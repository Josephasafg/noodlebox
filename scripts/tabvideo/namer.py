"""
Name glyph shapes by asking a vision model to read them.

Naming shapes is the one step of the reader a machine had not been trusted with,
because a wrong name becomes a wrong note everywhere that shape occurs while an
unnamed one is merely counted and reported. The measurements behind that stand:
matching against system fonts scored 38% on real video pixels and Tesseract
7-24%, because fret digits are around ten pixels tall. What changes here is the
reader, not the pixels — a vision model shown a *magnified* crop, and the same
mark outlined inside the number it belongs to, reads them where those do not.

The safety property is kept by construction rather than by trust:

- Every failure is an abstention. A timeout, a refused connection, an answer that
  is not JSON, an answer outside the label grammar, a blown time budget, a
  missing library — all of them leave the shape unnamed, which is the outcome
  the pipeline already handles well.
- A shape is only named when independent looks at *different printings* of it
  agree. A disagreement is evidence the shape is not being read reliably, which
  is exactly when a guess is worst, so it abstains rather than taking a majority.

There is a second, narrower question here, and its posture is the opposite one.
`24` is fret 24 and equally a hammer-on from 2 to 4; nothing in the ink separates
them, so `read_runs` shows the model the whole bar and asks which it is. That
reading is already right 270 times in 275, so the model is not deciding it, it is
being asked whether to overturn it, and only for the handful of patterns the
piece's own fret histogram argues against. Anything short of every look being
sure leaves the note alone. See `_decide_reading`.

Configured entirely from the environment — in practice from the project's `.env`,
which `env.py` loads before the service starts — and absent configuration this
module does nothing at all: `Namer.from_env()` returns None and the caller keeps
the manual naming flow it has always had.
"""

from __future__ import annotations

import base64
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import pipeline

# The endpoint. Unset means auto-naming is off, which is the default: nothing
# leaves this machine unless someone says where to send it.
URL_VAR = "TABVIDEO_VLM_URL"
MODEL_VAR = "TABVIDEO_VLM_MODEL"
KEY_VAR = "TABVIDEO_VLM_KEY"

# Independent looks per shape. Three is enough for a disagreement to show up
# while keeping a whole new font to a couple of hundred calls.
EXEMPLARS_VAR = "TABVIDEO_VLM_EXEMPLARS"
DEFAULT_EXEMPLARS = 3

CONCURRENCY_VAR = "TABVIDEO_VLM_CONCURRENCY"
DEFAULT_CONCURRENCY = 4

TIMEOUT_VAR = "TABVIDEO_VLM_TIMEOUT"
DEFAULT_TIMEOUT_S = 60.0

# A ceiling on the whole naming step. A slow or wedged endpoint must not hold an
# import open for ever; what has not been read by then is left unnamed.
BUDGET_VAR = "TABVIDEO_VLM_BUDGET"
DEFAULT_BUDGET_S = 300.0

# The SDK insists on a key even where the server wants none.
PLACEHOLDER_KEY = "not-needed"

# Room for a short description and a label. Answers are a single small object.
MAX_ANSWER_TOKENS = 300

ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "shows": {"type": "string"},
        "label": {"type": "string"},
        "certain": {"type": "boolean"},
    },
    "required": ["shows", "label", "certain"],
    "additionalProperties": False,
}

INSTRUCTIONS = """\
You are reading printed guitar tablature that has been photographed from a video \
frame and magnified, so it is blocky. You are shown one mark at a time and asked \
what it is.

The first image is the mark on its own. The second shows that same mark outlined \
in red inside the printed number and staff it belongs to. The red box is not part \
of the notation; it marks the one thing you are being asked about. Use the rest \
of the second image only to judge the outlined mark's size and where it sits.

Answer about what is inside the red box and nothing else. A printed number is \
often made of several separate marks, and each is asked about on its own: \
outline the `2` of a printed `12` and the answer is `2`, not `12`.

The staff line is broken either side of a printed number, so short line stubs sit \
level with the middle of the digits. Those are staff line, not slide dashes.

Answer with a JSON object: `shows` describing what you see in a few words, \
`label` naming it, and `certain` saying whether you are sure.

`label` must be one of:

- a fret number's digit, `0` to `9`
- a two-digit fret printed as one mark, up to `24`
- `x` for a muted note, `(` or `)` for a ghost note's brackets
- a technique fused into the mark: `4h6` for a small digit tight against a full \
one (a hammer-on), `4p2` for two digits under an arc (a pull-off), `12-` or \
`-12` for a number with a slide dash, `12b` or `b12` for a number with a bend \
arrow, `~` for a lone slur arc, `-` for a lone slide dash, `b` for a lone bend \
arrow
- the empty string `""` for a mark that is not part of a fret number at all: a \
piece of a slur, a fragment of a beam, a speck of noise, part of a staff line

Set `certain` to false whenever you are less than sure, and prefer that to \
guessing. A mark left unnamed is reported as unread and costs nothing. A mark \
named wrongly becomes a wrong note everywhere this shape appears in the piece, \
which cannot be recovered from. When two readings are plausible, you are not \
certain.
"""

ASK = "What is this mark?"

READING_SCHEMA = {
    "type": "object",
    "properties": {
        "shows": {"type": "string"},
        "reads": {"type": "string", "enum": ["one number", "two notes"]},
        "certain": {"type": "boolean"},
    },
    "required": ["shows", "reads", "certain"],
    "additionalProperties": False,
}

READING_INSTRUCTIONS = """\
You are reading printed guitar tablature photographed from a video frame and \
magnified. Each image is one bar, with a group of digits outlined in red.

The outlined digits are one of two things, and you are being asked which:

- one fret number, printed as two digits, played as a single note
- two frets played one straight after the other as a legato figure — a hammer-on \
or a pull-off — which this notation engraves with the two numbers pressed hard \
together, often with no arc drawn over them

Nothing inside the digits tells these apart: the two are printed identically, \
and the gap between them is the same either way. The bar around them is the \
evidence, so read that:

- Compare the outlined number with every other number in the bar. Tablature is \
written for one hand in one position, so a bar whose notes all sit low on the \
neck does not contain one number far above the rest. If the outlined number is \
an outlier and its two digits are frets the bar plays constantly, it is two notes.
- Look for the same figure elsewhere in the bar with an arc drawn over it. This \
notation draws the arc on some legato pairs and leaves it off others, so a `4` \
and a `2` under an arc beside the outlined group is direct evidence that the \
music here is legato pairs.
- Look at where notes fall along the line. A single note takes one of those \
positions; a legato pair is two notes pressed into one of them.

Answer with a JSON object: `shows` describing the bar in a few words, `reads` \
being exactly "one number" or "two notes", and `certain` saying whether you are \
sure.

Say "two notes" when the bar makes that the clear reading, and "one number" when \
it does not. Set `certain` to false only where you genuinely cannot tell from \
what is in front of you — if your own description of the bar already answers the \
question, then you can tell, and saying otherwise throws the answer away.

Only "two notes" with `certain` true changes anything: every other answer leaves \
the reading exactly as the reader had it, which is right far more often than not.
"""


@dataclass(frozen=True)
class Exemplar:
    """One printing of a shape: the mark alone, and the mark in its number."""

    mark: bytes
    context: bytes | None = None


@dataclass(frozen=True)
class ShapeJob:
    """One shape to name, with the printings of it that were found."""

    index: int
    count: int
    exemplars: list[Exemplar]


@dataclass(frozen=True)
class Answer:
    """What one look returned. `label` is None whenever it cannot be used."""

    label: str | None
    shows: str = ""
    note: str = ""


@dataclass(frozen=True)
class Outcome:
    """What the namer decided about one shape, and why."""

    index: int
    label: str | None
    reason: str
    answers: list[Answer] = field(default_factory=list)


@dataclass(frozen=True)
class RunJob:
    """One contested digit pattern, with bars where it was printed."""

    text: str
    """What the digits spell as a single fret, such as `24`."""
    split: list[str]
    """The other reading, such as `["2", "4"]`."""
    count: int
    """How many times the pattern occurs, which is the blast radius of an error."""
    bars: list[bytes] = field(default_factory=list)
    """PNG renders, one per printing, each with the digits outlined."""


@dataclass(frozen=True)
class RunOutcome:
    """Whether a contested pattern is really a legato pair."""

    text: str
    legato: bool
    reason: str
    answers: list[Answer] = field(default_factory=list)


def _encode(image: np.ndarray | None) -> bytes | None:
    if image is None or image.size == 0:
        return None
    ok, buffer = cv2.imencode(".png", image)
    return buffer.tobytes() if ok else None


def build_jobs(
    readings: list[pipeline.Reading],
    shapes: pipeline.Shapes,
    indices: list[int],
    exemplars: int = DEFAULT_EXEMPLARS,
) -> list[ShapeJob]:
    """Render the shapes worth asking about, commonest first."""
    jobs: list[ShapeJob] = []
    for index in indices:
        members = pipeline.shape_members(readings, shapes, index, limit=exemplars)
        rendered: list[Exemplar] = []
        for member in members:
            mark = _encode(pipeline.component_crop(readings, member))
            if mark is None:
                continue
            rendered.append(
                Exemplar(mark=mark, context=_encode(pipeline.shape_context(readings, member)))
            )
        if rendered:
            jobs.append(ShapeJob(index=index, count=shapes.counts[index], exemplars=rendered))
    return jobs


def build_run_jobs(
    readings: list[pipeline.Reading],
    shapes: pipeline.Shapes,
    labels: dict[str, str],
    patterns: list[str],
    exemplars: int = DEFAULT_EXEMPLARS,
) -> list[RunJob]:
    """
    Render the bars where a contested pattern was printed, commonest first.

    Different printings rather than one printing looked at repeatedly, same as
    for shapes: three views of one bar is one observation three times, and a
    disagreement between three bars is the signal that the pattern is not always
    the same thing — which is exactly when it must be left alone.
    """
    found = pipeline.contested_runs(readings, shapes, labels, patterns)
    jobs: list[RunJob] = []
    for text in patterns:
        runs = found.get(text, [])
        split = pipeline.fret_sequence(text, split=True)
        if not runs or split is None:
            continue
        bars: list[bytes] = []
        for run in runs[:exemplars]:
            rendered = _encode(pipeline.run_context(readings, run))
            if rendered is not None:
                bars.append(rendered)
        jobs.append(RunJob(text=text, split=split, count=len(runs), bars=bars))
    return jobs


def _refused_the_request(problem: Exception) -> bool:
    """
    Whether the server rejected the shape of the request rather than failing.

    Only that is a reason to stop sending `guided_json`. A refused connection or
    a timeout says nothing about whether the server understands the field, and
    treating it as though it did would quietly give up constrained decoding for
    the rest of the process on one blip.
    """
    status = getattr(problem, "status_code", None)
    if not isinstance(status, int):
        status = getattr(problem, "status", None)
    return isinstance(status, int) and 400 <= status < 500


def _clean(value: object) -> str | None:
    """A label the pipeline would accept, or None."""
    if not isinstance(value, str):
        return None
    label = value.strip().lower()
    if label in {"none", "null", "unknown", "?"}:
        return None
    if len(label) > 5 or not pipeline.LABEL_RE.match(label):
        return None
    # The grammar admits any two digits, and the pipeline drops an impossible
    # fret later. Refusing it here is better: read as a misreading of the shape,
    # it leaves every occurrence reported unread rather than silently dropped.
    if label.isdigit() and int(label) > pipeline.MAX_FRET:
        return None
    return label


@dataclass(frozen=True)
class Availability:
    """
    Whether a model will read the shapes, and if not, why not.

    `from_env` answers None to three different questions — nobody asked for a
    model, half the settings are there, the client library is missing — and only
    the first is the intended silence. Told apart, the other two can be said out
    loud instead of showing a naming screen that looks like the feature never
    shipped.
    """

    configured: bool
    """Someone pointed this at a model, whether or not it can be reached."""
    ready: bool
    """A namer can actually be built."""
    model: str = ""
    problem: str = ""
    """Empty unless something was configured and cannot be used."""


def availability(environ: dict[str, str] | None = None) -> Availability:
    """Read the configuration without building anything."""
    env = os.environ if environ is None else environ
    url = (env.get(URL_VAR) or "").strip()
    model = (env.get(MODEL_VAR) or "").strip()
    if not url and not model:
        return Availability(configured=False, ready=False)
    if not url:
        return Availability(False, False, model, f"{MODEL_VAR} is set but {URL_VAR} is not.")
    if not model:
        return Availability(True, False, "", f"{URL_VAR} is set but {MODEL_VAR} is not.")
    try:
        import openai  # noqa: F401
    except ImportError:
        return Availability(
            True,
            False,
            model,
            "the openai package is not installed; "
            "run: pip install -r scripts/tabvideo/requirements.txt",
        )
    return Availability(configured=True, ready=True, model=model)


class Namer:
    """Reads glyph shapes through an OpenAI-compatible vision endpoint."""

    def __init__(
        self,
        client,
        model: str,
        *,
        exemplars: int = DEFAULT_EXEMPLARS,
        concurrency: int = DEFAULT_CONCURRENCY,
        timeout: float = DEFAULT_TIMEOUT_S,
        budget: float = DEFAULT_BUDGET_S,
    ) -> None:
        self.client = client
        self.model = model
        self.exemplars = max(1, exemplars)
        self.concurrency = max(1, concurrency)
        self.timeout = timeout
        self.budget = budget
        # Constrained decoding removes the whole class of "the model wrote prose"
        # failures, but it is a vLLM extension rather than part of the OpenAI API.
        # Servers without it reject the field, so it is dropped after one refusal
        # instead of failing every call.
        self._guided = True

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> "Namer | None":
        """Build a namer if one is configured, and otherwise nothing."""
        env = os.environ if environ is None else environ
        if not availability(env).ready:
            return None
        from openai import OpenAI

        url = (env.get(URL_VAR) or "").strip()
        model = (env.get(MODEL_VAR) or "").strip()

        def number(name: str, fallback: float) -> float:
            try:
                return float(env[name])
            except (KeyError, TypeError, ValueError):
                return fallback

        timeout = number(TIMEOUT_VAR, DEFAULT_TIMEOUT_S)
        return cls(
            OpenAI(base_url=url, api_key=env.get(KEY_VAR) or PLACEHOLDER_KEY, timeout=timeout),
            model,
            exemplars=int(number(EXEMPLARS_VAR, DEFAULT_EXEMPLARS)),
            concurrency=int(number(CONCURRENCY_VAR, DEFAULT_CONCURRENCY)),
            timeout=timeout,
            budget=number(BUDGET_VAR, DEFAULT_BUDGET_S),
        )

    def _content(self, exemplar: Exemplar) -> list[dict]:
        content: list[dict] = [{"type": "text", "text": ASK}]
        for image in (exemplar.mark, exemplar.context):
            if image is None:
                continue
            encoded = base64.b64encode(image).decode("ascii")
            content.append(
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}}
            )
        return content

    def _object(self, instructions: str, content: list[dict], schema: dict) -> tuple[dict, str]:
        """One call, answering with the object it returned or why there is none."""
        request = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": instructions},
                {"role": "user", "content": content},
            ],
            # The question has one right answer, so there is nothing to sample for.
            "temperature": 0,
            "max_tokens": MAX_ANSWER_TOKENS,
            "response_format": {"type": "json_object"},
            "timeout": self.timeout,
        }
        for attempt in range(2):
            body = dict(request)
            if self._guided:
                body["extra_body"] = {"guided_json": schema}
            try:
                response = self.client.chat.completions.create(**body)
                break
            except Exception as problem:  # noqa: BLE001 - every failure is an abstention
                if self._guided and attempt == 0 and _refused_the_request(problem):
                    # The server does not know `guided_json`. Drop it and try once
                    # more before giving the question up.
                    self._guided = False
                    continue
                return {}, f"call failed: {problem}"

        try:
            payload = json.loads(response.choices[0].message.content or "")
        except (AttributeError, IndexError, TypeError, ValueError) as problem:
            return {}, f"unreadable answer: {problem}"
        if not isinstance(payload, dict):
            return {}, "answer was not an object"
        return payload, ""

    def _ask(self, exemplar: Exemplar) -> Answer:
        """One look at one printing. Never raises."""
        payload, problem = self._object(INSTRUCTIONS, self._content(exemplar), ANSWER_SCHEMA)
        if problem:
            return Answer(label=None, note=problem)

        shows = payload.get("shows") if isinstance(payload.get("shows"), str) else ""
        if payload.get("certain") is not True:
            return Answer(label=None, shows=shows, note="not certain")
        label = _clean(payload.get("label"))
        if label is None:
            return Answer(label=None, shows=shows, note=f"not a name: {payload.get('label')!r}")
        return Answer(label=label, shows=shows)

    def _ask_reading(self, job: RunJob, bar: bytes) -> Answer:
        """One look at one printing of a contested run. Never raises."""
        joined = " then ".join(job.split)
        question = (
            f"Are the outlined digits the single fret {job.text}, "
            f"or the frets {joined} played as a legato pair?"
        )
        encoded = base64.b64encode(bar).decode("ascii")
        content = [
            {"type": "text", "text": question},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}},
        ]
        payload, problem = self._object(READING_INSTRUCTIONS, content, READING_SCHEMA)
        if problem:
            return Answer(label=None, note=problem)

        shows = payload.get("shows") if isinstance(payload.get("shows"), str) else ""
        if payload.get("certain") is not True:
            return Answer(label=None, shows=shows, note="not certain")
        reads = payload.get("reads")
        if reads not in ("one number", "two notes"):
            return Answer(label=None, shows=shows, note=f"not an answer: {reads!r}")
        return Answer(label=reads, shows=shows)

    def _decide(self, index: int, answers: list[Answer]) -> Outcome:
        """
        Accept a name only when the looks agree, and abstain on any conflict.

        Taking a majority would be the natural thing here and is the wrong thing:
        two looks agreeing while a third reads the mark differently is precisely
        the case where the shape is not legible, and the cost of being wrong is
        paid on every occurrence of it in the piece.
        """
        offered = [answer.label for answer in answers if answer.label is not None]
        if not offered:
            return Outcome(index=index, label=None, reason="unsure", answers=answers)
        if len(set(offered)) > 1:
            return Outcome(index=index, label=None, reason="conflict", answers=answers)
        if len(offered) < min(2, len(answers)):
            return Outcome(index=index, label=None, reason="unsure", answers=answers)
        return Outcome(index=index, label=offered[0], reason="agreed", answers=answers)

    def read(self, jobs: list[ShapeJob], on_progress=None) -> list[Outcome]:
        """
        Name what can be named, commonest shape first.

        Ordering matters when the budget runs out: the shapes that account for
        most of the notation are the ones already read.
        """
        deadline = time.monotonic() + self.budget
        outcomes: list[Outcome] = []
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            for done, job in enumerate(jobs, start=1):
                if time.monotonic() >= deadline:
                    outcomes.append(Outcome(index=job.index, label=None, reason="budget"))
                else:
                    answers = list(pool.map(self._ask, job.exemplars))
                    outcomes.append(self._decide(job.index, answers))
                if on_progress is not None:
                    on_progress(done, len(jobs))
        return outcomes

    def _decide_reading(self, job: RunJob, answers: list[Answer]) -> RunOutcome:
        """
        Split a contested run only when every look is sure it should be split.

        The posture here is the opposite of `_decide`, on purpose. There, nothing
        is known until the looks agree, and agreement is what produces a name.
        Here something *is* known — the run reads as a playable fret, and across
        the reference clip that reading is right 270 times in 275 — so the model
        is not being asked to decide, it is being asked to overturn. One look
        saying "one number", one look unsure, an unreachable endpoint, a spent
        budget: all of them leave the reading alone, which is the answer that is
        usually right anyway.

        The asymmetry is what keeps the blast radius small. A pattern occurring
        five times risks five notes if this is wrong, and only ever a pattern the
        piece's own fret histogram already argued against.
        """
        offered = [answer.label for answer in answers if answer.label is not None]
        if not offered or len(offered) < len(answers):
            return RunOutcome(job.text, legato=False, reason="unsure", answers=answers)
        if len(set(offered)) > 1:
            return RunOutcome(job.text, legato=False, reason="conflict", answers=answers)
        if offered[0] != "two notes":
            return RunOutcome(job.text, legato=False, reason="one number", answers=answers)
        return RunOutcome(job.text, legato=True, reason="agreed", answers=answers)

    def read_runs(self, jobs: list[RunJob], on_progress=None) -> list[RunOutcome]:
        """Decide which contested patterns are legato pairs rather than frets."""
        deadline = time.monotonic() + self.budget
        outcomes: list[RunOutcome] = []
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            for done, job in enumerate(jobs, start=1):
                if time.monotonic() >= deadline or not job.bars:
                    outcomes.append(RunOutcome(job.text, legato=False, reason="budget"))
                else:
                    answers = list(pool.map(lambda bar: self._ask_reading(job, bar), job.bars))
                    outcomes.append(self._decide_reading(job, answers))
                if on_progress is not None:
                    on_progress(done, len(jobs))
        return outcomes
