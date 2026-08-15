"""
Local service that reads a tab video for the app.

The app is a static build with no backend, so this runs beside it in development
and Vite proxies `/api` here. It exists because reading notation off a video needs
a video decoder and OpenCV, neither of which a browser has — but the work should
still happen when a link is pasted into the library, not in a terminal.

    python3 -m scripts.tabvideo.server        # or: npm run dev, which starts both

What it does not do is decide what a glyph says. Recognition is measured at 38%
against system fonts and 7-24% with Tesseract on real video pixels, because fret
digits are around ten pixels tall; a wrong name becomes a wrong note everywhere
that shape occurs. So a job stops at `naming`, hands the app magnified pictures of
each distinct shape, and waits to be told. Names confirmed once are remembered in
`bank.py`, which is what makes the next video in that font need nothing.

Deliberately bound to the loopback interface. It downloads whatever URL it is
given and spends real CPU doing it, so it is not something to expose.
"""

from __future__ import annotations

import base64
import os
import shutil
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

from . import bank as bank_mod, fetch, pipeline
from .primitives import PagePrimitives

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
    labels: dict[str, str] = field(default_factory=dict)
    pages: list[PagePrimitives] | None = None
    unspelled: int = 0
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
    """Shapes nobody has named yet, commonest first."""
    assert job.shapes is not None
    return [
        index
        for index in range(len(job.shapes))
        if str(index) not in job.labels and index not in job.remembered
    ]


def _run(job: Job) -> None:
    """Download, read, and either finish or stop to ask about shapes."""
    try:
        job.state = "downloading"
        job.stage = "fetching the video"
        job.workdir = Path(tempfile.mkdtemp(prefix=f"tabvideo-{job.id}-"))

        def downloaded(fraction: float) -> None:
            job.progress = fraction

        got = fetch.download(job.url, job.workdir, on_progress=downloaded)
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

        unresolved = _unresolved(job)
        share = sum(job.shapes.counts[i] for i in unresolved) / max(1, sum(job.shapes.counts))
        if unresolved and (
            len(unresolved) > AUTO_FINISH_UNREAD_SHAPES or share > AUTO_FINISH_UNREAD_FRACTION
        ):
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


def _finish(job: Job, submitted: dict[str, str]) -> None:
    """Emit primitives from whatever names are known, and remember them."""
    assert job.shapes is not None
    job.state = "emitting"
    job.stage = "building the score"
    labels = {str(index): name for index, name in job.remembered.items()}
    labels.update(submitted)
    job.labels = labels

    pages, unspelled = pipeline.emit(job.readings, job.shapes, labels)
    job.pages, job.unspelled = pages, unspelled

    # Only names a person confirmed are worth remembering. Ones this job took
    # from the bank are already in it, and re-storing them would just duplicate.
    confirmed = {key: value for key, value in submitted.items()}
    if confirmed:
        remembered = bank_mod.load()
        remembered.remember(job.shapes.centroids, confirmed)
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
        out.append(
            {
                "index": index,
                "count": job.shapes.counts[index],
                "png": encoded,
                "label": known,
                "remembered": index in job.remembered,
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
    return payload


@app.get("/api/health")
def health() -> dict[str, Any]:
    """So the app can tell whether reading a video is possible at all."""
    return {"ok": True, "service": "tabvideo", "maxDurationMinutes": fetch.MAX_DURATION_S // 60}


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
        # A fret number is at most two characters; anything longer is not a name.
        cleaned[str(int(key))] = value[:2]
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


def main() -> None:
    import uvicorn

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
