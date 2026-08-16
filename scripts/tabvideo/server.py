"""
Local service that reads a tab video for the app.

The app is a static build with no backend, so this runs beside it in development
and Vite proxies `/api` here. It exists because reading notation off a video needs
a video decoder and OpenCV, neither of which a browser has — but the work should
still happen when a link is pasted into the library, not in a terminal.

    python3 -m scripts.tabvideo.server        # or: npm run dev, which starts both

Deciding what a glyph says is the one part of this that is not arithmetic. A
wrong name becomes a wrong note everywhere that shape occurs, so a job never
guesses: it takes what `bank.py` already knows, asks `namer.py` to read the rest
if a vision model is configured, and stops at `naming` with magnified pictures of
whatever is still unread. With no endpoint configured, or one that cannot read the
font, that is every shape and the app asks as it always has. Either way the names
are remembered, which is what makes the next video in that font need nothing.

Deliberately bound to the loopback interface. It downloads whatever URL it is
given and spends real CPU doing it, so it is not something to expose.
"""

from __future__ import annotations

import base64
import os
import shutil
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import cv2
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import bank as bank_mod, env as env_mod, fetch, namer as namer_mod, pipeline
from .primitives import PagePrimitives

# Before anything reads a setting. Nothing about this service is started by hand,
# so settings that only exist in a shell are settings that are usually absent.
env_mod.apply()

# The dev server and a preview build; nothing else has any business calling this.
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]

# A page served from anywhere can ask a browser to call a loopback address, so the
# Host header is checked too: that stops a name that resolves to 127.0.0.1 from
# being used to reach this service as though it were a public site.
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}

# One video at a time. Reading one is minutes of CPU-bound work, and running two
# together makes both slower without making either finish sooner.
WORKERS = 1

# Jobs hold composited frames, so they are not free to keep. Both bounds are
# generous for one person working through a video at a time.
MAX_JOBS = 6
JOB_TTL_S = 60 * 60

# How much of the notation may go unread before the app is asked to name shapes.
# Rare one-off fragments — half a slur, a digit fused to a slide — are not worth
# stopping for, but they are always reported rather than quietly dropped.
AUTO_FINISH_UNREAD_FRACTION = 0.01
AUTO_FINISH_UNREAD_SHAPES = 5

# The same question once a model has read the shapes, where the tolerance has to
# be looser: it abstains on anything it is unsure of, and those abstentions are
# mostly the long tail of one-off debris that a person would leave empty too. A
# healthy read sits far under this — 20 shapes cover 96% of the marks on the
# reference clip — so what this really catches is an endpoint that is down or a
# font the model cannot read, which belongs in front of a person rather than in a
# score with most of its notes missing.
AUTO_NAMED_FINISH_FRACTION = 0.10

State = Literal["queued", "downloading", "reading", "naming", "emitting", "done", "error"]


@dataclass
class Job:
    id: str
    url: str
    state: State = "queued"
    stage: str = "waiting to start"
    progress: float | None = None
    title: str = ""
    error: str | None = None
    created_at: float = field(default_factory=time.monotonic)
    workdir: Path | None = None
    readings: list[pipeline.Reading] = field(default_factory=list)
    shapes: pipeline.Shapes | None = None
    remembered: dict[int, str] = field(default_factory=dict)
    auto: dict[int, str] = field(default_factory=dict)
    """Names a model read off the shapes, kept apart because they are banked as its own."""
    labels: dict[str, str] = field(default_factory=dict)
    pages: list[PagePrimitives] | None = None
    unspelled: int = 0
    silent_techniques: int = 0
    """Slur arcs and slide dashes dropped for want of a name, which used to vanish."""
    split_runs: int = 0
    """Notes a model read as a legato pair rather than the fret they also spell."""
    lock: threading.Lock = field(default_factory=threading.Lock)

    def cleanup(self) -> None:
        """Drop the frames and the downloaded video; the result is kept."""
        self.readings = []
        if self.workdir and self.workdir.exists():
            shutil.rmtree(self.workdir, ignore_errors=True)
        self.workdir = None


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()
pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="tabvideo")

app = FastAPI(title="noodlebox tab video reader", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["content-type"],
)


@app.middleware("http")
async def only_loopback(request: Request, call_next):
    """
    Refuse a request that reached us under someone else's hostname.

    The refusal is returned rather than raised: middleware runs outside the
    exception handlers, so an HTTPException raised here would reach the client as
    a 500 and a traceback instead of an answer.
    """
    host = (request.headers.get("host") or "").rsplit(":", 1)[0]
    if host and host not in ALLOWED_HOSTS:
        return JSONResponse(
            status_code=421, content={"detail": "This service only answers on localhost."}
        )
    return await call_next(request)


class ExtractRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class LabelsRequest(BaseModel):
    # Names are single characters; the mapping is shape index to character, and an
    # empty string means "confirmed as not part of a fret number".
    labels: dict[str, str]


def _reap() -> None:
    """Forget jobs that have aged out, oldest first when over the limit."""
    with jobs_lock:
        now = time.monotonic()
        for job in list(jobs.values()):
            if now - job.created_at > JOB_TTL_S:
                job.cleanup()
                jobs.pop(job.id, None)
        while len(jobs) > MAX_JOBS:
            oldest = min(jobs.values(), key=lambda j: j.created_at)
            oldest.cleanup()
            jobs.pop(oldest.id, None)


def _get(job_id: str) -> Job:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No such extraction job.")
    return job


def _unresolved(job: Job) -> list[int]:
    """Shapes nothing has named yet, commonest first."""
    assert job.shapes is not None
    return [
        index
        for index in range(len(job.shapes))
        if str(index) not in job.labels and index not in job.remembered and index not in job.auto
    ]


def _read_shapes(job: Job) -> None:
    """
    Have a model name the shapes the bank did not recognise.

    The bank goes first so a shape someone already confirmed is never sent
    anywhere, and this whole step is optional: without an endpoint configured
    there is no namer, and any failure inside it leaves the shapes unnamed for a
    person, which is the flow this has always had.
    """
    assert job.shapes is not None
    namer = namer_mod.Namer.from_env()
    if namer is None:
        # Configured-but-unusable looks exactly like never-configured from the
        # app: a naming screen. Say which one this is, because the difference is
        # a typo in a settings file nobody is looking at.
        state = namer_mod.availability()
        if state.problem:
            print(f"shapes will be named by hand: {state.problem}", file=sys.stderr)
        return
    unresolved = _unresolved(job)
    if not unresolved:
        return

    job.stage = "reading the printed shapes"
    job.progress = 0.0
    try:
        asked = namer_mod.build_jobs(
            job.readings, job.shapes, unresolved, exemplars=namer.exemplars
        )

        def progressed(done: int, total: int) -> None:
            job.progress = done / max(1, total)

        for outcome in namer.read(asked, on_progress=progressed):
            if outcome.label is not None:
                job.auto[outcome.index] = outcome.label
    except Exception as problem:  # noqa: BLE001 - naming is an optimisation, never a failure
        # The job carries on and the app asks about the shapes, which is a worse
        # experience and not a wrong one. Said out loud because the symptom
        # otherwise is a naming screen appearing for no visible reason.
        print(f"reading the shapes failed, falling back to naming: {problem}", file=sys.stderr)
    finally:
        job.progress = None


def _run(job: Job) -> None:
    """Download, read, and either finish or stop to ask about shapes."""
    try:
        job.state = "downloading"
        job.stage = "fetching the video"
        job.workdir = Path(tempfile.mkdtemp(prefix=f"tabvideo-{job.id}-"))

        def downloaded(fraction: float) -> None:
            job.progress = fraction

        def retrying(attempt: int) -> None:
            # The bar restarts from nothing, so say why rather than appear stuck.
            # Phrased in the past, because this stays on screen while the next
            # attempt downloads perfectly happily.
            job.progress = None
            job.stage = (
                f"the video host refused a request; fetching again "
                f"({attempt + 1} of {fetch.DOWNLOAD_ATTEMPTS})"
            )

        got = fetch.download(job.url, job.workdir, on_progress=downloaded, on_retry=retrying)
        job.title = got.title
        job.progress = None

        job.state = "reading"
        job.stage = "looking for the notation"
        pipeline.check_scroll(str(got.path))

        def read_one(count: int) -> None:
            job.stage = f"reading system {count}"

        job.stage = "reading the systems"
        job.readings = pipeline.read_video(str(got.path), on_system=read_one)
        if not job.readings:
            raise pipeline.UnreadableVideo(
                "No engraved notation was found in that video. This reads printed "
                "tablature shown on screen, not the audio."
            )

        job.stage = "grouping the shapes"
        job.shapes = pipeline.find_shapes(job.readings)
        job.remembered = bank_mod.load().recognise(job.shapes.centroids)

        # The downloaded video is no longer needed; the composited systems are.
        if job.workdir:
            shutil.rmtree(job.workdir, ignore_errors=True)
            job.workdir = None

        _read_shapes(job)

        unresolved = _unresolved(job)
        share = sum(job.shapes.counts[i] for i in unresolved) / max(1, sum(job.shapes.counts))
        if job.auto:
            # A model read the shapes, so what is left is what it declined to
            # name. Those are reported unread rather than asked about, unless
            # there are so many that the read cannot be trusted.
            stop = share > AUTO_NAMED_FINISH_FRACTION
        else:
            stop = bool(unresolved) and (
                len(unresolved) > AUTO_FINISH_UNREAD_SHAPES or share > AUTO_FINISH_UNREAD_FRACTION
            )
        if stop:
            job.state = "naming"
            job.stage = f"{len(unresolved)} shapes need naming"
            return
        _finish(job, dict(job.labels))
    except (fetch.UrlRejected, fetch.DownloadFailed) as problem:
        job.state, job.error, job.stage = "error", str(problem), "failed"
    except (pipeline.ScrollingVideo, pipeline.UnreadableVideo) as problem:
        job.state, job.error, job.stage = "error", str(problem), "failed"
    except Exception as problem:  # noqa: BLE001 - a job must not take the service down
        job.state, job.error, job.stage = "error", f"Reading that video failed: {problem}", "failed"
    finally:
        if job.state == "error":
            job.cleanup()


def _read_music(job: Job, labels: dict[str, str]) -> pipeline.Emitted:
    """
    Build the score, asking about the runs the reading itself argues against.

    A run of digits that spells a playable fret is usually that fret, and nothing
    in the ink separates `24` from a hammer-on from 2 to 4. `suspect_patterns`
    finds the handful where the piece's own fret histogram disagrees with the
    reading — four on the reference clip, and all four are legato pairs — and a
    vision model is asked about those and only those, one question per pattern.

    Without a model, or where it is not sure, the fret reading stands. This is
    the only place a model may change a note rather than name a shape, so it may
    only overturn, never decide, and only over the short list.
    """
    assert job.shapes is not None
    emitted = pipeline.emit(job.readings, job.shapes, labels)
    namer = namer_mod.Namer.from_env()
    if namer is None:
        return emitted

    patterns = pipeline.suspect_patterns(emitted)
    if not patterns:
        return emitted

    job.stage = "checking the notes that could be read two ways"
    jobs = namer_mod.build_run_jobs(job.readings, job.shapes, labels, patterns, namer.exemplars)
    try:
        legato = {out.text for out in namer.read_runs(jobs) if out.legato}
    except Exception as problem:  # noqa: BLE001 - a check must never fail the import
        print(f"tabvideo: could not check contested runs: {problem}", file=sys.stderr)
        return emitted
    return pipeline.emit(job.readings, job.shapes, labels, legato=legato) if legato else emitted


def _finish(job: Job, submitted: dict[str, str]) -> None:
    """Emit primitives from whatever names are known, and remember them."""
    assert job.shapes is not None
    job.state = "emitting"
    job.stage = "building the score"
    labels = {str(index): name for index, name in job.remembered.items()}
    labels.update({str(index): name for index, name in job.auto.items()})
    labels.update(submitted)
    job.labels = labels

    emitted = _read_music(job, labels)
    job.silent_techniques = emitted.silent
    job.split_runs = sum(emitted.split.values())
    job.pages, job.unspelled = emitted.pages, emitted.unspelled

    # Names this job worked out are worth keeping; ones it took from the bank are
    # already in it, and re-storing them would just duplicate. A person's answer
    # is banked as theirs and overrides the model's reading of the same shape.
    machine = {str(index): name for index, name in job.auto.items() if str(index) not in submitted}
    if machine or submitted:
        remembered = bank_mod.load()
        if machine:
            remembered.remember(job.shapes.centroids, machine, by=bank_mod.MODEL)
        if submitted:
            remembered.remember(job.shapes.centroids, submitted, by=bank_mod.HUMAN)
        remembered.save()

    job.state = "done"
    job.stage = "ready"
    job.cleanup()


def _shape_pictures(job: Job) -> list[dict[str, Any]]:
    """Every shape as a magnified PNG, commonest first, with what is known of it."""
    assert job.shapes is not None
    out: list[dict[str, Any]] = []
    for index in range(len(job.shapes)):
        crop = pipeline.shape_crop(job.readings, job.shapes, index)
        encoded = ""
        if crop is not None:
            ok, buffer = cv2.imencode(".png", crop)
            if ok:
                encoded = base64.b64encode(buffer.tobytes()).decode("ascii")
        known = job.labels.get(str(index))
        if known is None and index in job.remembered:
            known = job.remembered[index]
        if known is None and index in job.auto:
            known = job.auto[index]
        out.append(
            {
                "index": index,
                "count": job.shapes.counts[index],
                "png": encoded,
                "label": known,
                "remembered": index in job.remembered,
                # A machine's reading is a suggestion to check, not a name
                # someone confirmed, and the two must not look alike.
                "suggested": index in job.auto and str(index) not in job.labels,
            }
        )
    return out


def _status(job: Job, *, include_shapes: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": job.id,
        "state": job.state,
        "stage": job.stage,
        "progress": job.progress,
        "title": job.title,
        "sourceUrl": job.url,
        "error": job.error,
    }
    if job.shapes is not None:
        payload["systems"] = len(job.readings) or None
        payload["staves"] = sum(len(r.staves) for r in job.readings) or None
        payload["shapeCount"] = len(job.shapes)
        payload["rememberedCount"] = len(job.remembered)
        payload["autoNamedCount"] = len(job.auto)
        payload["unresolvedCount"] = len(_unresolved(job))
        if include_shapes and job.state == "naming":
            payload["shapes"] = _shape_pictures(job)
    if job.state == "done" and job.pages is not None:
        payload["primitives"] = [
            {
                "pageIndex": page.pageIndex,
                "width": page.width,
                "height": page.height,
                "segments": [vars(segment) for segment in page.segments],
                "texts": [vars(text) for text in page.texts],
            }
            for page in job.pages
        ]
        payload["unreadCount"] = job.unspelled
        # Reported separately because it means something different to a reader: the
        # notes are all there and correct, but the piece has lost its articulation.
        payload["silentTechniqueCount"] = job.silent_techniques
        # The one place a model changed a note rather than named a shape, so it
        # is said out loud rather than left to be noticed by ear.
        payload["splitRunCount"] = job.split_runs
    return payload


@app.get("/api/health")
def health() -> dict[str, Any]:
    """So the app can tell whether reading a video is possible at all."""
    # Read per call rather than cached: settings are edited while this runs, and
    # a stale answer here would tell someone their edit did not work.
    vision = namer_mod.availability()
    return {
        "ok": True,
        "service": "tabvideo",
        "maxDurationMinutes": fetch.MAX_DURATION_S // 60,
        # Whether shapes get named automatically decides what the app should
        # promise before an import, so it is worth saying before one starts.
        "vision": {
            "configured": vision.configured,
            "ready": vision.ready,
            "model": vision.model,
            "problem": vision.problem,
        },
    }


@app.post("/api/extract")
def start(request: ExtractRequest) -> dict[str, Any]:
    _reap()
    try:
        url = fetch.check_url(request.url)
    except fetch.UrlRejected as problem:
        raise HTTPException(status_code=400, detail=str(problem)) from problem
    job = Job(id=uuid.uuid4().hex, url=url)
    with jobs_lock:
        jobs[job.id] = job
    pool.submit(_run, job)
    return {"id": job.id, "state": job.state}


@app.get("/api/extract/{job_id}")
def status(job_id: str) -> dict[str, Any]:
    return _status(_get(job_id), include_shapes=True)


@app.post("/api/extract/{job_id}/labels")
def name_shapes(job_id: str, request: LabelsRequest) -> dict[str, Any]:
    job = _get(job_id)
    if job.shapes is None:
        raise HTTPException(status_code=409, detail="That job has not found its shapes yet.")
    if job.state not in ("naming", "done"):
        raise HTTPException(status_code=409, detail=f"That job is {job.state}.")
    count = len(job.shapes)
    cleaned: dict[str, str] = {}
    for key, value in request.labels.items():
        if not key.isdigit() or not 0 <= int(key) < count:
            raise HTTPException(status_code=400, detail=f"There is no shape {key}.")
        name = value.strip().lower()
        if len(name) > 5 or not pipeline.LABEL_RE.match(name):
            # Refused rather than trimmed: a silently altered name would become
            # a silently wrong note everywhere that shape occurs.
            raise HTTPException(
                status_code=400, detail=f"{value!r} is not a name a shape can have."
            )
        cleaned[str(int(key))] = name
    with job.lock:
        if job.state == "done":
            raise HTTPException(status_code=409, detail="That job has already been built.")
        try:
            _finish(job, cleaned)
        except Exception as problem:  # noqa: BLE001
            job.state, job.error = "error", f"Building the score failed: {problem}"
            raise HTTPException(status_code=500, detail=job.error) from problem
    return _status(job, include_shapes=False)


@app.delete("/api/extract/{job_id}")
def discard(job_id: str) -> dict[str, bool]:
    job = _get(job_id)
    job.cleanup()
    with jobs_lock:
        jobs.pop(job_id, None)
    return {"ok": True}


def _announce() -> None:
    """Say on startup whether shapes will be named automatically."""
    vision = namer_mod.availability()
    if vision.ready:
        print(f"tabvideo: shapes will be read by {vision.model}")
    elif vision.problem:
        print(f"tabvideo: shapes will be named by hand — {vision.problem}")
    else:
        print(
            "tabvideo: shapes will be named by hand. To have a vision model read "
            f"them, set {namer_mod.URL_VAR} and {namer_mod.MODEL_VAR} in .env "
            "(see scripts/tabvideo/README.md)."
        )


def main() -> None:
    import uvicorn

    _announce()

    # Loopback by default, and overridable only through the environment so that
    # exposing this is always a deliberate act. Vite's proxy reads the same
    # variable, so the two cannot drift apart.
    uvicorn.run(
        app,
        host=os.environ.get("TABVIDEO_HOST", "127.0.0.1"),
        port=int(os.environ.get("TABVIDEO_PORT", "8787")),
        log_level="warning",
    )


if __name__ == "__main__":
    main()
