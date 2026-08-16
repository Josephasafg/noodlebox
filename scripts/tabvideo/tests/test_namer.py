"""
Tests for naming glyph shapes with a vision model.

Nothing here talks to a model. What is being checked is the part that has to be
right whatever the model says: that a name is only accepted when independent
looks agree, and that every other outcome — a conflict, an unsure answer, a
label outside the grammar, a broken endpoint — leaves the shape unnamed rather
than guessed at.

    python3 -m pytest scripts/tabvideo/tests/test_namer.py
"""

from __future__ import annotations

import json

import numpy as np

from scripts.tabvideo import namer as namer_mod
from scripts.tabvideo import cli, frames, pipeline
from scripts.tabvideo.tests.test_tabvideo import render_system


class Rejected(Exception):
    """What an SDK raises when the server refuses the request itself."""

    def __init__(self, status_code: int = 400) -> None:
        super().__init__(f"unknown field (status {status_code})")
        self.status_code = status_code


class StubClient:
    """An OpenAI-shaped client that replays scripted answers."""

    def __init__(self, answers: list[object], fails: int = 0, error: Exception | None = None) -> None:
        self.answers = list(answers)
        self.fails = fails
        self.error = error or RuntimeError("connection refused")
        self.calls: list[dict] = []
        self.completions = self
        self.chat = self

    def create(self, **request):  # noqa: ANN003 - mirrors the SDK's shape
        self.calls.append(request)
        if self.fails:
            self.fails -= 1
            raise self.error
        answer = self.answers.pop(0) if self.answers else ""
        text = answer if isinstance(answer, str) else json.dumps(answer)
        return _Response(text)


class _Response:
    def __init__(self, text: str) -> None:
        self.choices = [_Choice(text)]


class _Choice:
    def __init__(self, text: str) -> None:
        self.message = _Message(text)


class _Message:
    def __init__(self, text: str) -> None:
        self.content = text


def _namer(
    answers: list[object], fails: int = 0, error: Exception | None = None, **kwargs
) -> namer_mod.Namer:
    return namer_mod.Namer(StubClient(answers, fails, error), "a-model", **kwargs)


def _job(exemplars: int = 3, index: int = 0) -> namer_mod.ShapeJob:
    return namer_mod.ShapeJob(
        index=index,
        count=exemplars,
        exemplars=[namer_mod.Exemplar(mark=b"png", context=b"png") for _ in range(exemplars)],
    )


def _said(label: str, certain: bool = True) -> dict:
    return {"shows": f"the digit {label}", "label": label, "certain": certain}


def test_agreeing_looks_name_the_shape() -> None:
    namer = _namer([_said("7"), _said("7"), _said("7")])

    outcome = namer.read([_job()])[0]

    assert outcome.label == "7"
    assert outcome.reason == "agreed"


def test_a_disagreement_leaves_the_shape_unnamed() -> None:
    """
    A majority would name this `7`. Two readings of one mark is exactly when a
    name is least trustworthy, and a wrong one is paid for on every occurrence.
    """
    namer = _namer([_said("7"), _said("7"), _said("1")])

    outcome = namer.read([_job()])[0]

    assert outcome.label is None
    assert outcome.reason == "conflict"


def test_one_certain_look_is_not_enough_when_more_were_available() -> None:
    namer = _namer([_said("7"), _said("7", certain=False), _said("7", certain=False)])

    outcome = namer.read([_job()])[0]

    assert outcome.label is None
    assert outcome.reason == "unsure"


def test_a_shape_printed_once_is_named_from_its_single_look() -> None:
    """Its blast radius is the one mark, so one confident reading is the bar."""
    namer = _namer([_said("9")])

    outcome = namer.read([_job(exemplars=1)])[0]

    assert outcome.label == "9"


def test_an_uncertain_answer_is_an_abstention() -> None:
    namer = _namer([_said("7", certain=False)])

    assert namer.read([_job(exemplars=1)])[0].label is None


def test_the_empty_string_is_a_real_answer() -> None:
    """It means the mark is confirmed to be something other than a fret number."""
    namer = _namer([_said(""), _said("")])

    outcome = namer.read([_job(exemplars=2)])[0]

    assert outcome.label == ""
    assert outcome.reason == "agreed"


def test_a_name_outside_the_grammar_is_refused() -> None:
    """`emit` would not know what to do with it, so it never reaches the labels."""
    namer = _namer([_said("treble clef"), _said("treble clef")])

    assert namer.read([_job(exemplars=2)])[0].label is None


def test_an_impossible_fret_is_refused() -> None:
    namer = _namer([_said("57"), _said("57")])

    assert namer.read([_job(exemplars=2)])[0].label is None


def test_prose_instead_of_json_is_an_abstention() -> None:
    namer = _namer(["It looks like a seven to me!", "Seven."])

    assert namer.read([_job(exemplars=2)])[0].label is None


def test_a_broken_endpoint_leaves_shapes_unnamed_rather_than_failing() -> None:
    namer = _namer([], fails=99)

    outcomes = namer.read([_job(exemplars=2), _job(exemplars=2, index=1)])

    assert [outcome.label for outcome in outcomes] == [None, None]


def test_an_answer_is_retried_once_without_constrained_decoding() -> None:
    """
    `guided_json` is a vLLM extension. A server that refuses it must cost one
    call, not every call.
    """
    namer = _namer([_said("7")], fails=1, error=Rejected(400))

    outcome = namer.read([_job(exemplars=1)])[0]

    assert outcome.label == "7"
    assert namer._guided is False, "the field is dropped after being refused"
    assert "extra_body" not in namer.client.calls[-1]


def test_a_dropped_connection_does_not_give_up_constrained_decoding() -> None:
    """
    Only a refusal of the request says the server does not know the field. A blip
    that disabled it would quietly weaken every later call in the process.
    """
    namer = _namer([_said("7")], fails=1)

    assert namer.read([_job(exemplars=1)])[0].label is None
    assert namer._guided is True
    assert "extra_body" in namer.client.calls[-1]


def test_an_exhausted_budget_stops_asking() -> None:
    namer = _namer([_said("7")] * 6, budget=0.0)

    outcomes = namer.read([_job(exemplars=1), _job(exemplars=1, index=1)])

    assert [outcome.reason for outcome in outcomes] == ["budget", "budget"]
    assert namer.client.calls == [], "nothing is asked once the time is gone"


def test_no_endpoint_configured_means_no_namer() -> None:
    assert namer_mod.Namer.from_env({}) is None
    assert namer_mod.Namer.from_env({namer_mod.URL_VAR: "http://localhost:8000/v1"}) is None
    assert namer_mod.Namer.from_env({namer_mod.MODEL_VAR: "qwen"}) is None


def test_jobs_carry_the_mark_and_its_context() -> None:
    readings = [
        cli.Reading(
            frames.Page(
                index=index,
                start_s=0.0,
                end_s=1.0,
                image=render_system([(0, 100, "7"), (2, 220, "7")]),
            )
        )
        for index in range(2)
    ]
    shapes = pipeline.find_shapes(readings)
    common = max(range(len(shapes)), key=lambda index: shapes.counts[index])

    jobs = namer_mod.build_jobs(readings, shapes, [common], exemplars=3)

    assert len(jobs) == 1
    assert jobs[0].index == common
    assert len(jobs[0].exemplars) == 3
    for exemplar in jobs[0].exemplars:
        assert exemplar.mark.startswith(b"\x89PNG")
        assert exemplar.context is not None and exemplar.context.startswith(b"\x89PNG")


def test_a_shape_that_cannot_be_rendered_is_not_asked_about() -> None:
    readings = [
        cli.Reading(
            frames.Page(index=0, start_s=0.0, end_s=1.0, image=render_system([(0, 100, "7")]))
        )
    ]
    shapes = pipeline.Shapes(
        every=[], assignment=[], centroids=[np.zeros((20, 20), np.float32)], counts=[1], index_of={}
    )

    assert namer_mod.build_jobs(readings, shapes, [0]) == []


def test_nothing_configured_is_a_silence_and_not_a_problem() -> None:
    # The ordinary case, and the default: nobody asked for a model, so nothing
    # should be said about one and nothing leaves the machine.
    state = namer_mod.availability({})

    assert not state.configured
    assert not state.ready
    assert state.problem == ""
    assert namer_mod.Namer.from_env({}) is None


def test_half_the_settings_says_which_half_is_missing() -> None:
    # Both halves are counted as "someone meant to configure this", because the
    # symptom either way is a naming screen that looks like nothing was built.
    without_model = namer_mod.availability({namer_mod.URL_VAR: "http://127.0.0.1:8000/v1"})
    assert without_model.configured
    assert not without_model.ready
    assert namer_mod.MODEL_VAR in without_model.problem

    without_url = namer_mod.availability({namer_mod.MODEL_VAR: "a-model"})
    assert not without_url.ready
    assert namer_mod.URL_VAR in without_url.problem


def test_a_blank_setting_counts_as_unset() -> None:
    # Commenting a value out by emptying it is a thing people do, and it must not
    # read as a configured endpoint pointed at nowhere.
    state = namer_mod.availability({namer_mod.URL_VAR: "  ", namer_mod.MODEL_VAR: ""})

    assert not state.configured
    assert state.problem == ""


def test_a_configured_endpoint_is_reported_with_its_model() -> None:
    state = namer_mod.availability(
        {namer_mod.URL_VAR: "http://127.0.0.1:8000/v1", namer_mod.MODEL_VAR: "a-model"}
    )

    assert state.configured
    assert state.model == "a-model"
    # Whether it is usable depends on the openai package being installed, which
    # is not a given here — but an unusable one must always explain itself, and
    # must never hand back a namer that would fail on first use.
    assert state.ready or "openai" in state.problem
    if not state.ready:
        assert (
            namer_mod.Namer.from_env(
                {namer_mod.URL_VAR: "http://127.0.0.1:8000/v1", namer_mod.MODEL_VAR: "a-model"}
            )
            is None
        )
