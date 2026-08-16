"""
Tests for reading a video and for the service that does it for the app.

A synthetic video stands in for a real one — see `fixture.py` — so the suite stays
deterministic, needs no network, and commits no copyrighted material. The download
itself is always stubbed: nothing here fetches anything.

    python3 -m pytest scripts/tabvideo/tests
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from scripts.tabvideo import bank as bank_mod, fetch, frames, namer as namer_mod, pipeline, server
from scripts.tabvideo.glyphs import TEMPLATE_SIZE
from scripts.tabvideo.tests import fixture


@pytest.fixture
def video(tmp_path: Path) -> Path:
    return fixture.write_video(tmp_path / "clip.mp4")


@pytest.fixture(autouse=True)
def isolated_bank(tmp_path, monkeypatch):
    """Never read or write the real bank in someone's home directory."""
    monkeypatch.setenv("NOODLEBOX_GLYPH_BANK", str(tmp_path / "bank.json"))


@pytest.fixture(autouse=True)
def empty_jobs():
    server.jobs.clear()
    yield
    for job in list(server.jobs.values()):
        job.cleanup()
    server.jobs.clear()


# --- reading a video -------------------------------------------------------


def test_each_held_system_is_read_once(video: Path) -> None:
    pages = list(frames.read_pages(str(video)))
    assert len(pages) == 3, "three systems were held, so three should come out"


def test_a_held_video_is_not_mistaken_for_a_scrolling_one(video: Path) -> None:
    # Refusing a readable video would be as bad as garbling a scrolling one, and a
    # moving playback cursor is the thing most likely to look like motion.
    top, bottom = pipeline.check_scroll(str(video))
    assert bottom > top


def test_the_camera_strip_is_left_out_of_the_panel(video: Path) -> None:
    import cv2

    capture = cv2.VideoCapture(str(video))
    ok, first = capture.read()
    capture.release()
    assert ok
    panel = frames.find_panel(first)
    assert panel.top >= fixture.CAMERA_HEIGHT, "the camera strip is not engraved paper"


def test_the_playback_cursor_is_composited_away(video: Path) -> None:
    """
    The median of several frames must leave no trace of the moving highlight.

    A surviving cursor would be read as ink and could split a glyph, so this
    checks the staff band holds no column that is lighter than the paper around
    it — which is what the cursor looks like where it survives.
    """
    page = next(iter(frames.read_pages(str(video))))
    band = page.image[: fixture.TAB_TOP + 5 * fixture.TAB_SPACING]
    paper = float(np.median(band))
    # Column means, excluding ink, should sit at paper level everywhere.
    columns = np.where(band > 200, band.astype(np.float32), np.nan)
    with np.errstate(invalid="ignore"):
        means = np.nanmean(columns, axis=0)
    assert np.nanmax(np.abs(means - paper)) < 6.0


def test_every_system_yields_one_tab_staff(video: Path) -> None:
    readings = pipeline.read_video(str(video))
    assert [len(r.staves) for r in readings] == [1, 1, 1]


def test_the_same_character_becomes_one_shape_across_systems(video: Path) -> None:
    """
    Clustering is what makes naming a shape once enough for the whole video.

    The fixture prints a small fret vocabulary many times over, so the shape count
    must stay near the number of distinct characters rather than growing with the
    number of marks.
    """
    readings = pipeline.read_video(str(video))
    shapes = pipeline.find_shapes(readings)
    assert len(shapes.every) > 100, "the fixture is densely printed"
    assert len(shapes) <= 12, f"{len(shapes)} shapes for a handful of characters"
    assert shapes.counts == sorted(shapes.counts, reverse=True), "commonest first"


def test_naming_shapes_produces_a_score(video: Path) -> None:
    """The whole point: named shapes turn into text the parser can read."""
    readings = pipeline.read_video(str(video))
    shapes = pipeline.find_shapes(readings)
    # Name every shape as the same digit. What each one says is irrelevant here;
    # that they reach the output as positioned text is the property under test.
    labels = {str(i): "7" for i in range(len(shapes))}
    emitted = pipeline.emit(readings, shapes, labels)
    pages, unspelled = emitted.pages, emitted.unspelled

    assert len(pages) == 3
    assert unspelled == 0
    assert all(page.texts for page in pages), "every system should carry notes"
    horizontals = [s for s in pages[0].segments if abs(s.y1 - s.y0) < 0.01]
    assert len(horizontals) == 6, "the six lines of the tab staff"


def test_an_unnamed_technique_mark_is_counted_rather_than_dropped(tmp_path: Path) -> None:
    """
    A slur arc nobody named must be reported, not silently discarded.

    This is the bug that let a whole piece lose its articulation without saying
    so. Unnamed *digits* have always been counted and reported unread, but an
    unnamed flat mark was simply skipped: on the reference clip all 46 arcs and
    27 of 28 slide dashes shared one unnamed shape, so the tab came out with no
    hammer-ons, pull-offs or slides at all — and every count it reported said it
    had been read perfectly. The notes were right, which is exactly what made it
    hard to notice.
    """
    page = fixture.render_system([(2, 300, "4"), (2, 330, "2")], (20, fixture.WIDTH - 20))
    fixture.draw_arc(page, 2, 310, 328)
    video = fixture.write_video(tmp_path / "clip.mp4", pages=[page])

    readings = pipeline.read_video(str(video))
    shapes = pipeline.find_shapes(readings)
    arcs = [flat for _, flat in readings[0].flat_marks]
    assert arcs, "the fixture draws one"

    # Name the digits as printed but not the arc, which is what an abstention
    # leaves behind. They have to differ: a slur's direction — hammer-on or
    # pull-off — is read from the frets it joins, and 4 to 4 goes nowhere.
    named: dict[str, str] = {}
    for mark in readings[0].components:
        named[str(shapes.label_of(mark))] = "4" if mark.cx < 320 else "2"

    emitted = pipeline.emit(readings, shapes, named)

    assert emitted.silent == len(arcs), "the dropped arc is accounted for"
    assert "p" not in [t.str for t in emitted.pages[0].texts], "and really was dropped"

    # Named, it costs nothing to report and the technique comes back.
    named[str(shapes.label_of(arcs[0]))] = "~"
    again = pipeline.emit(readings, shapes, named)
    assert again.silent == 0
    assert "p" in [t.str for t in again.pages[0].texts]


def test_technique_marks_survive_to_the_emitted_page(tmp_path: Path) -> None:
    """
    Arcs, dashes and muted notes, drawn as the video font prints them, end up in
    the vocabulary the parser already reads: `h`, `p` and `sl.` below the staff.

    This also guards the truncation fix: before flat marks were claimed, the
    dash beside the 7 read as the remains of a dropped digit and silenced it.
    """
    page = fixture.render_system(
        [
            (2, 300, "4"),
            (2, 330, "2"),
            (3, 500, "7"),
            (3, 530, "9"),
            (1, 700, "7"),
            (1, 900, "x"),
            (4, 1100, "8"),
        ],
        (20, fixture.WIDTH - 20),
    )
    fixture.draw_arc(page, 2, 310, 328)  # 4 to 2 falls: a pull-off
    fixture.draw_arc(page, 3, 510, 528)  # 7 to 9 rises: a hammer-on
    fixture.draw_dash(page, 1, 712, 724)  # slide away from the 7
    fixture.draw_bend_arrow(page, 4, 1114)  # the 8 is bent
    video = fixture.write_video(tmp_path / "clip.mp4", pages=[page])

    readings = pipeline.read_video(str(video))
    assert len(readings) == 1
    reading = readings[0]
    shapes = pipeline.find_shapes(readings)

    def line(string_index: int) -> int:
        return fixture.TAB_TOP + string_index * fixture.TAB_SPACING

    everything = list(reading.components) + [flat for _, flat in reading.flat_marks]

    def name(x: int, y: int, label: str, into: dict[str, str]) -> None:
        hits = [c for c in everything if c.x0 <= x <= c.x1 and c.y0 <= y <= c.y1]
        assert hits, f"nothing was found where the {label!r} was drawn"
        into[str(shapes.label_of(hits[0]))] = label

    labels: dict[str, str] = {}
    name(303, line(2), "4", labels)
    name(333, line(2), "2", labels)
    name(503, line(3), "7", labels)
    name(533, line(3), "9", labels)
    name(703, line(1), "7", labels)
    name(903, line(1), "x", labels)
    name(1103, line(4), "8", labels)
    name(319, line(2) - 9, "~", labels)
    name(519, line(3) - 9, "~", labels)
    name(718, line(1) - 3, "-", labels)
    name(1114, line(4) - 7, "b", labels)

    emitted = pipeline.emit(readings, shapes, labels)
    pages, unspelled = emitted.pages, emitted.unspelled
    assert unspelled == 0, "the dash must not read as a truncated 7"
    texts = [t.str for t in pages[0].texts]
    assert texts.count("p") == 1, f"the falling arc should be one pull-off in {texts}"
    assert texts.count("h") == 1, f"the rising arc should be one hammer-on in {texts}"
    assert texts.count("sl.") == 1
    assert texts.count("bend") == 1, f"the arrow should be one bend in {texts}"
    assert "x" in texts
    assert "8" in texts, "the bent note itself must still be read"

    # Legato marks live below the staff and the bend above it, which is where
    # the parser reads each from.
    staff = reading.staves[0]
    for item in pages[0].texts:
        if item.str in ("h", "p", "sl."):
            assert staff.bottom + staff.spacing * 0.9 <= item.y <= staff.bottom + staff.spacing * 4
        if item.str == "bend":
            assert staff.top - staff.spacing * 4.5 <= item.y <= staff.top - staff.spacing * 0.5


def test_shapes_left_unnamed_are_counted_not_guessed(video: Path) -> None:
    readings = pipeline.read_video(str(video))
    shapes = pipeline.find_shapes(readings)
    emitted = pipeline.emit(readings, shapes, {})
    pages, unspelled = emitted.pages, emitted.unspelled
    assert unspelled > 0, "nothing was named, so nothing should have been read"
    assert all(not page.texts for page in pages)


def test_a_shape_picture_keeps_the_glyph_proportions(video: Path) -> None:
    """
    Squashing a glyph to a square costs real recognition accuracy, and the person
    naming it is telling a 6 from a 5 at around ten pixels tall.
    """
    readings = pipeline.read_video(str(video))
    shapes = pipeline.find_shapes(readings)
    crop = pipeline.shape_crop(readings, shapes, 0)
    assert crop is not None
    assert crop.shape[0] != crop.shape[1], "a digit is taller than it is wide"


# --- remembering shape names ----------------------------------------------


def _template(seed: int) -> np.ndarray:
    generator = np.random.default_rng(seed)
    return generator.random((TEMPLATE_SIZE, TEMPLATE_SIZE)).astype(np.float32)


def test_a_confirmed_name_is_recognised_next_time(tmp_path: Path) -> None:
    template = _template(1)
    first = bank_mod.Bank(path=tmp_path / "bank.json")
    assert first.remember([template], {"0": "7"}) == 1
    first.save()

    again = bank_mod.load(tmp_path / "bank.json")
    assert again.recognise([template]) == {0: "7"}


def test_a_shape_confirmed_as_not_a_number_is_also_remembered(tmp_path: Path) -> None:
    """
    An empty name is a real answer — a slur fragment is not a fret number — and
    it is most of the long tail, so re-asking about it would waste the saving.
    """
    template = _template(2)
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    keeper.remember([template], {"0": ""})
    keeper.save()

    recalled = bank_mod.load(tmp_path / "bank.json").recognise([template])
    assert recalled == {0: ""}, "membership is the answer, not truthiness"


def test_an_unfamiliar_shape_is_left_for_a_person(tmp_path: Path) -> None:
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    keeper.remember([_template(3)], {"0": "7"})
    assert keeper.recognise([_template(99)]) == {}


def test_renaming_a_shape_corrects_the_bank_instead_of_tying_it(tmp_path: Path) -> None:
    """
    Two different names within same-character distance cannot both be right —
    different characters were measured to start at 0.189 apart, outside the
    match radius — so the newer confirmation is a correction. It happened for
    real: a bend arrow fused to a digit was banked as the digit alone, and
    appending rather than replacing would have left a tie that gets asked about
    on every video for ever.
    """
    base = np.zeros((TEMPLATE_SIZE, TEMPLATE_SIZE), dtype=np.float32)
    nudged = base.copy()
    nudged[0, 0] = 0.02
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    keeper.remember([base], {"0": "1"})
    keeper.remember([nudged], {"0": "2b"})
    assert keeper.recognise([base]) == {0: "2b"}
    assert len(keeper) == 1, "the wrong entry is gone, not outvoted"


def test_a_correction_beside_a_same_named_entry_does_not_crash(tmp_path: Path) -> None:
    """
    Removal used to go through list.remove, which compares entries with == and
    so reaches their numpy templates — 'the truth value of an array is
    ambiguous', raised the moment the scan passed another entry with the same
    label. That is the common case: a real bank holds many entries per digit.
    """
    same = np.zeros((TEMPLATE_SIZE, TEMPLATE_SIZE), dtype=np.float32)
    other = np.ones((TEMPLATE_SIZE, TEMPLATE_SIZE), dtype=np.float32)
    keeper = bank_mod.Bank(
        entries=[
            bank_mod.Entry(label="1", template=same),
            bank_mod.Entry(label="1", template=other),
        ],
        path=tmp_path / "bank.json",
    )
    keeper.remember([other], {"0": "12b"})
    assert keeper.recognise([other]) == {0: "12b"}
    assert keeper.recognise([same]) == {0: "1"}, "the far entry is untouched"


def test_a_tie_already_in_the_bank_is_still_not_decided(tmp_path: Path) -> None:
    # remember() can no longer create one, but a bank written by an older
    # version can hold one, and it must be asked about rather than guessed.
    base = np.zeros((TEMPLATE_SIZE, TEMPLATE_SIZE), dtype=np.float32)
    nudged = base.copy()
    nudged[0, 0] = 0.02
    keeper = bank_mod.Bank(
        entries=[
            bank_mod.Entry(label="6", template=base),
            bank_mod.Entry(label="5", template=nudged),
        ],
        path=tmp_path / "bank.json",
    )
    assert keeper.recognise([base]) == {}


def test_re_reading_a_video_does_not_grow_the_bank(tmp_path: Path) -> None:
    template = _template(4)
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    assert keeper.remember([template], {"0": "7"}) == 1
    assert keeper.remember([template], {"0": "7"}) == 0
    assert len(keeper) == 1


def test_a_model_cannot_overturn_a_name_a_person_gave(tmp_path: Path) -> None:
    """
    The one rule that makes automatic naming safe to bank at all. A person looked
    at the shape; the model read it. Where they disagree the person is right, and
    the model's answer must not evict that entry or sit beside it as a tie — both
    would turn a confirmed name into a shape that gets asked about, or read
    wrongly, on every later video.
    """
    base = np.zeros((TEMPLATE_SIZE, TEMPLATE_SIZE), dtype=np.float32)
    nudged = base.copy()
    nudged[0, 0] = 0.02
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    keeper.remember([base], {"0": "6"}, by=bank_mod.HUMAN)

    assert keeper.remember([nudged], {"0": "5"}, by=bank_mod.MODEL) == 0
    assert len(keeper) == 1
    assert keeper.recognise([base]) == {0: "6"}, "still the name it was given"


def test_a_person_overrules_what_a_model_read(tmp_path: Path) -> None:
    base = np.zeros((TEMPLATE_SIZE, TEMPLATE_SIZE), dtype=np.float32)
    nudged = base.copy()
    nudged[0, 0] = 0.02
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    keeper.remember([base], {"0": "5"}, by=bank_mod.MODEL)

    keeper.remember([nudged], {"0": "6"}, by=bank_mod.HUMAN)

    assert len(keeper) == 1, "the misreading is gone, not outvoted"
    assert keeper.recognise([base]) == {0: "6"}


def test_confirming_what_a_model_read_makes_the_name_a_persons(tmp_path: Path) -> None:
    """
    Otherwise a later run could overturn a name someone had already checked: the
    entry would still be owned by the model that first guessed it right.
    """
    template = _template(11)
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    keeper.remember([template], {"0": "7"}, by=bank_mod.MODEL)

    assert keeper.remember([template], {"0": "7"}, by=bank_mod.HUMAN) == 0, "not stored twice"
    assert [entry.by for entry in keeper.entries] == [bank_mod.HUMAN]


def test_one_model_reading_can_correct_another(tmp_path: Path) -> None:
    base = np.zeros((TEMPLATE_SIZE, TEMPLATE_SIZE), dtype=np.float32)
    nudged = base.copy()
    nudged[0, 0] = 0.02
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    keeper.remember([base], {"0": "5"}, by=bank_mod.MODEL)

    keeper.remember([nudged], {"0": "6"}, by=bank_mod.MODEL)

    assert keeper.recognise([base]) == {0: "6"}
    assert len(keeper) == 1, "a tie would be asked about for ever"


def test_who_named_a_shape_survives_being_written_out(tmp_path: Path) -> None:
    path = tmp_path / "bank.json"
    keeper = bank_mod.Bank(path=path)
    keeper.remember([_template(12)], {"0": "7"}, by=bank_mod.MODEL)
    keeper.remember([_template(13)], {"0": "9"}, by=bank_mod.HUMAN)
    keeper.save()

    reloaded = bank_mod.load(path)

    assert sorted(entry.by for entry in reloaded.entries) == [bank_mod.HUMAN, bank_mod.MODEL]


def test_a_bank_written_before_models_named_anything_reads_as_confirmed(tmp_path: Path) -> None:
    """Every name in an older bank was typed by a person, so it keeps that standing."""
    path = tmp_path / "bank.json"
    path.write_text(
        json.dumps([{"label": "7", "template": base64.b64encode(bytes(400)).decode("ascii")}]),
        encoding="utf-8",
    )

    entries = bank_mod.load(path).entries

    assert [entry.by for entry in entries] == [bank_mod.HUMAN]


def test_a_damaged_bank_does_not_stop_a_video_being_read(tmp_path: Path) -> None:
    path = tmp_path / "bank.json"
    path.write_text("{not json at all", encoding="utf-8")
    assert len(bank_mod.load(path)) == 0


def test_a_shape_never_looked_at_is_not_remembered_as_nothing(tmp_path: Path) -> None:
    """
    A missing label means nobody decided; an empty one means somebody decided it
    was not a fret number. Conflating them would poison the bank with wrong
    "ignore this" entries for shapes that were simply never reached.
    """
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    assert keeper.remember([_template(5), _template(6)], {"0": "7"}) == 1
    assert len(keeper) == 1


# --- guarding the submitted link ------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/clip.mp4",
        "not a url at all",
        "",
    ],
)
def test_a_link_that_is_not_web_video_is_refused(url: str) -> None:
    with pytest.raises(fetch.UrlRejected):
        fetch.check_url(url)


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1"],
)
def test_a_link_into_the_local_network_is_refused(address: str, monkeypatch) -> None:
    """
    The URL comes from whoever is using the app, so it must not be usable to reach
    something only this machine can see — a metadata service most of all.
    """
    monkeypatch.setattr(fetch.socket, "getaddrinfo", lambda *a, **k: [(0, 0, 0, "", (address, 0))])
    with pytest.raises(fetch.UrlRejected):
        fetch.check_url("https://sneaky.example/clip.mp4")


def test_a_name_resolving_to_both_public_and_local_is_refused(monkeypatch) -> None:
    """One public address must not vouch for a loopback one alongside it."""
    monkeypatch.setattr(
        fetch.socket,
        "getaddrinfo",
        lambda *a, **k: [(0, 0, 0, "", ("93.184.216.34", 0)), (0, 0, 0, "", ("127.0.0.1", 0))],
    )
    with pytest.raises(fetch.UrlRejected):
        fetch.check_url("https://rebind.example/clip.mp4")


def test_an_ordinary_public_link_is_accepted(monkeypatch) -> None:
    monkeypatch.setattr(
        fetch.socket, "getaddrinfo", lambda *a, **k: [(0, 0, 0, "", ("93.184.216.34", 0))]
    )
    assert fetch.check_url("  https://example.com/watch?v=abc  ") == (
        "https://example.com/watch?v=abc"
    )


def test_an_over_long_video_is_refused_before_it_is_downloaded() -> None:
    with pytest.raises(fetch.UrlRejected):
        fetch.check_limits({"duration": fetch.MAX_DURATION_S + 1})


def test_yt_dlp_accepts_the_options_we_build(tmp_path: Path) -> None:
    """
    Construct a downloader for real, without fetching anything.

    These options are only validated when yt-dlp is constructed, so a wrong shape
    surfaces as a failed download rather than as anything obvious. `js_runtimes`
    got this wrong once: the Python API wants a dict of {runtime: {config}}, which
    is not what the `--js-runtimes` command line option parses into.
    """
    import yt_dlp

    for options in (fetch.probe_options(), fetch.download_options(tmp_path)):
        with yt_dlp.YoutubeDL(options):
            pass


class _FakeDownloader:
    """Stands in for yt-dlp: fails on the first `failures` attempts, then writes."""

    def __init__(self, options: dict) -> None:
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def download(self, urls: list[str]) -> None:
        state = _FakeDownloader.state
        state["attempts"] += 1
        state["saw"].append(sorted(p.name for p in state["into"].iterdir()))
        if state["attempts"] <= state["failures"]:
            (state["into"] / "clip.mp4.part").write_bytes(b"partial")
            raise RuntimeError("ERROR: unable to download video data: HTTP Error 403: Forbidden")
        (state["into"] / "clip.mp4").write_bytes(b"video bytes")


@pytest.fixture
def flaky_host(tmp_path: Path, monkeypatch):
    """A download that 403s a given number of times before working."""
    import yt_dlp

    monkeypatch.setattr(fetch, "probe", lambda url: {"title": "Lesson", "duration": 100})
    monkeypatch.setattr(fetch, "RETRY_DELAY_S", 0.0)
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeDownloader)
    into = tmp_path / "work"

    def arrange(failures: int) -> Path:
        _FakeDownloader.state = {"attempts": 0, "failures": failures, "into": into, "saw": []}
        return into

    return arrange


def test_a_refused_url_is_retried_rather_than_losing_the_reading(flaky_host) -> None:
    # The signed URL YouTube hands out is sometimes refused on first use, and
    # yt-dlp will not retry a 403 itself.
    into = flaky_host(failures=1)
    got = fetch.download("https://example.com/watch", into)
    assert _FakeDownloader.state["attempts"] == 2
    assert got.path.name == "clip.mp4"


def test_retrying_starts_from_an_empty_directory(flaky_host) -> None:
    # A later attempt can settle on a different format with the same extension,
    # so appending to the abandoned part file would produce an unreadable video.
    into = flaky_host(failures=2)
    fetch.download("https://example.com/watch", into)
    assert _FakeDownloader.state["saw"] == [[], [], []]


def test_a_host_that_keeps_refusing_is_reported(flaky_host) -> None:
    into = flaky_host(failures=fetch.DOWNLOAD_ATTEMPTS)
    with pytest.raises(fetch.DownloadFailed) as failure:
        fetch.download("https://example.com/watch", into)
    assert _FakeDownloader.state["attempts"] == fetch.DOWNLOAD_ATTEMPTS
    # The host's own words survive: they say more than the status code does.
    assert "403" in str(failure.value)


def test_a_retry_is_announced_so_it_does_not_look_stuck(flaky_host) -> None:
    into = flaky_host(failures=2)
    seen: list[int] = []
    fetch.download("https://example.com/watch", into, on_retry=seen.append)
    assert seen == [1, 2]


def test_node_is_the_runtime_asked_for() -> None:
    # Without a JavaScript runtime yt-dlp hides the high-resolution formats and
    # then fails mid-download with a 403; deno is not installed here.
    assert "node" in fetch.JS_RUNTIMES


# --- the service ----------------------------------------------------------


@pytest.fixture
def client(video: Path, monkeypatch) -> TestClient:
    """A client whose downloads are stubbed with the fixture video."""
    monkeypatch.setattr(fetch, "check_url", lambda raw: raw.strip())

    def stub(url: str, into: Path, on_progress=None, on_retry=None) -> fetch.Fetched:
        if on_progress:
            on_progress(1.0)
        return fetch.Fetched(path=video, title="Fixture Lesson", duration_s=6.0, source_url=url)

    monkeypatch.setattr(fetch, "download", stub)
    # Addressed as localhost, because the service refuses any other hostname.
    return TestClient(server.app, base_url="http://localhost")


def _await_state(client: TestClient, job_id: str, *states: str, timeout: float = 90.0) -> dict:
    deadline = time.monotonic() + timeout
    payload: dict = {}
    while time.monotonic() < deadline:
        payload = client.get(f"/api/extract/{job_id}").json()
        if payload["state"] in states:
            return payload
        if payload["state"] == "error":
            raise AssertionError(f"job failed: {payload['error']}")
        time.sleep(0.05)
    raise AssertionError(f"job stayed {payload.get('state')}, waiting for {states}")


def test_the_app_can_tell_the_service_is_there(client: TestClient) -> None:
    assert client.get("/api/health").json()["ok"] is True


def test_the_app_can_tell_whether_shapes_will_be_named_for_it(
    client: TestClient, monkeypatch
) -> None:
    """
    Whether a model reads the shapes changes what the app should promise before
    an import — a tab straight away, or a screen full of shapes to name — so it
    is worth knowing before one starts rather than after.
    """
    monkeypatch.delenv(namer_mod.URL_VAR, raising=False)
    monkeypatch.delenv(namer_mod.MODEL_VAR, raising=False)
    off = client.get("/api/health").json()["vision"]
    assert off == {"configured": False, "ready": False, "model": "", "problem": ""}

    # Answered per request, because settings get edited while this is running and
    # a cached answer would say an edit had not worked.
    monkeypatch.setenv(namer_mod.URL_VAR, "http://127.0.0.1:8000/v1")
    on = client.get("/api/health").json()["vision"]
    assert on["configured"] is True
    assert on["ready"] is False
    assert namer_mod.MODEL_VAR in on["problem"]


def test_a_video_link_is_read_and_stops_to_ask_about_shapes(client: TestClient) -> None:
    started = client.post("/api/extract", json={"url": "https://example.com/watch?v=abc"})
    assert started.status_code == 200
    job_id = started.json()["id"]

    naming = _await_state(client, job_id, "naming")
    assert naming["systems"] == 3
    assert naming["staves"] == 3
    assert naming["title"] == "Fixture Lesson"
    assert naming["shapes"], "the app is given the shapes to name"
    assert all(shape["png"] for shape in naming["shapes"]), "each shape has a picture"
    assert naming["shapes"][0]["count"] >= naming["shapes"][-1]["count"], "commonest first"


def test_naming_the_shapes_returns_primitives_the_parser_can_read(client: TestClient) -> None:
    job_id = client.post("/api/extract", json={"url": "https://example.com/a"}).json()["id"]
    naming = _await_state(client, job_id, "naming")

    labels = {str(shape["index"]): "7" for shape in naming["shapes"]}
    done = client.post(f"/api/extract/{job_id}/labels", json={"labels": labels})
    assert done.status_code == 200
    payload = done.json()

    assert payload["state"] == "done"
    assert payload["unreadCount"] == 0
    pages = payload["primitives"]
    assert len(pages) == 3
    for page in pages:
        assert page["texts"], "each system carries notes"
        assert page["width"] > 0 and page["height"] > 0
        for text in page["texts"]:
            assert set(text) == {"str", "x", "y", "fontSize", "width"}


def test_a_second_video_in_a_known_font_needs_no_naming(client: TestClient, video: Path) -> None:
    """
    The saving that makes this bearable: names confirmed once are remembered, so
    the next video in that font is read without anyone being asked anything.
    """
    first = client.post("/api/extract", json={"url": "https://example.com/one"}).json()["id"]
    naming = _await_state(client, first, "naming")
    labels = {str(shape["index"]): "7" for shape in naming["shapes"]}
    client.post(f"/api/extract/{first}/labels", json={"labels": labels})

    second = client.post("/api/extract", json={"url": "https://example.com/two"}).json()["id"]
    payload = _await_state(client, second, "done", "naming")
    assert payload["state"] == "done", "every shape was already known"
    assert payload["rememberedCount"] == payload["shapeCount"]
    assert payload["primitives"][0]["texts"]


def test_a_shape_index_that_does_not_exist_is_refused(client: TestClient) -> None:
    job_id = client.post("/api/extract", json={"url": "https://example.com/a"}).json()["id"]
    _await_state(client, job_id, "naming")
    answer = client.post(f"/api/extract/{job_id}/labels", json={"labels": {"9999": "7"}})
    assert answer.status_code == 400


def test_technique_names_are_accepted(client: TestClient) -> None:
    job_id = client.post("/api/extract", json={"url": "https://example.com/a"}).json()["id"]
    naming = _await_state(client, job_id, "naming")
    labels = {str(shape["index"]): "7" for shape in naming["shapes"]}
    keys = list(labels)
    labels[keys[0]] = "4h6"
    if len(keys) > 1:
        labels[keys[1]] = "12b"
    answer = client.post(f"/api/extract/{job_id}/labels", json={"labels": labels})
    assert answer.status_code == 200


# `b2` is deliberately absent: an arrow grouped before its digit is a real name.
@pytest.mark.parametrize("bad", ["4h", "h6", "seven", "123", "12p100", "--~", "x2", "b123", "bb"])
def test_a_name_outside_the_grammar_is_refused_not_trimmed(client: TestClient, bad: str) -> None:
    # Trimming would turn a typo into a silently wrong note on every occurrence.
    job_id = client.post("/api/extract", json={"url": "https://example.com/a"}).json()["id"]
    _await_state(client, job_id, "naming")
    answer = client.post(f"/api/extract/{job_id}/labels", json={"labels": {"0": bad}})
    assert answer.status_code == 400


# --- naming the shapes without a person -----------------------------------


class _StubNamer:
    """Stands in for a configured vision endpoint, answering from a script."""

    exemplars = 3

    def __init__(self, answer, fail: bool = False) -> None:
        self.answer = answer
        self.fail = fail
        self.asked: list[int] = []

    def read(self, jobs, on_progress=None):
        if self.fail:
            raise RuntimeError("the endpoint is down")
        outcomes = []
        for position, job in enumerate(jobs):
            self.asked.append(job.index)
            label = self.answer(position, len(jobs)) if callable(self.answer) else self.answer
            outcomes.append(namer_mod.Outcome(index=job.index, label=label, reason="agreed"))
        if on_progress:
            on_progress(len(jobs), len(jobs))
        return outcomes


def _all_but_the_rarest(position: int, total: int) -> str | None:
    """Read everything except the last shape, which is the one-off tail."""
    return None if position == total - 1 else "7"


def _with_namer(monkeypatch, namer) -> None:
    monkeypatch.setattr(namer_mod.Namer, "from_env", classmethod(lambda cls, environ=None: namer))


def test_a_video_is_read_end_to_end_when_a_model_names_the_shapes(
    client: TestClient, monkeypatch
) -> None:
    """The point of the whole thing: a link becomes a score with nothing to click."""
    _with_namer(monkeypatch, _StubNamer("7"))

    job_id = client.post("/api/extract", json={"url": "https://example.com/a"}).json()["id"]
    payload = _await_state(client, job_id, "done", "naming")

    assert payload["state"] == "done", "nobody was asked anything"
    assert payload["autoNamedCount"] == payload["shapeCount"]
    assert payload["primitives"][0]["texts"]


def test_shapes_the_model_declines_are_left_unread_rather_than_guessed(
    client: TestClient, monkeypatch
) -> None:
    """
    Abstaining is the safe failure and must not stop the import: the notes it
    covered are reported unread, which is recoverable, and a guess would not be.
    """
    _with_namer(monkeypatch, _StubNamer(_all_but_the_rarest))

    job_id = client.post("/api/extract", json={"url": "https://example.com/a"}).json()["id"]
    payload = _await_state(client, job_id, "done", "naming")

    assert payload["state"] == "done"
    assert payload["unresolvedCount"] > 0, "the rest is admitted, not invented"


def test_a_model_that_reads_almost_nothing_still_asks_a_person(
    client: TestClient, monkeypatch
) -> None:
    """
    A broadly failing endpoint must not produce a score with most of its notes
    missing. Past the threshold the naming screen comes back, prefilled with
    whatever was read, which is the flow this always had.
    """
    _with_namer(monkeypatch, _StubNamer(_all_but_the_rarest))
    monkeypatch.setattr(server, "AUTO_NAMED_FINISH_FRACTION", 0.0)

    job_id = client.post("/api/extract", json={"url": "https://example.com/a"}).json()["id"]
    payload = _await_state(client, job_id, "naming", "done")

    assert payload["state"] == "naming"
    suggested = [shape for shape in payload["shapes"] if shape["suggested"]]
    assert suggested, "what the model did read is offered rather than thrown away"
    assert all(shape["label"] == "7" for shape in suggested)


def test_a_broken_endpoint_falls_back_to_naming_by_hand(client: TestClient, monkeypatch) -> None:
    _with_namer(monkeypatch, _StubNamer(None, fail=True))

    job_id = client.post("/api/extract", json={"url": "https://example.com/a"}).json()["id"]
    payload = _await_state(client, job_id, "naming", "done")

    assert payload["state"] == "naming", "the job survives and asks as it always did"
    assert payload["shapes"]


def test_a_shape_the_bank_knows_is_never_sent_to_the_model(client: TestClient, monkeypatch) -> None:
    """Nothing leaves the machine that has already been answered."""
    first = client.post("/api/extract", json={"url": "https://example.com/one"}).json()["id"]
    naming = _await_state(client, first, "naming")
    labels = {str(shape["index"]): "7" for shape in naming["shapes"]}
    client.post(f"/api/extract/{first}/labels", json={"labels": labels})

    namer = _StubNamer("9")
    _with_namer(monkeypatch, namer)
    second = client.post("/api/extract", json={"url": "https://example.com/two"}).json()["id"]
    _await_state(client, second, "done", "naming")

    assert namer.asked == [], "every shape was already confirmed"


def test_what_the_model_read_is_remembered_for_the_next_video(
    client: TestClient, monkeypatch
) -> None:
    """So a font costs the endpoint one video, not one video every time."""
    namer = _StubNamer("7")
    _with_namer(monkeypatch, namer)
    first = client.post("/api/extract", json={"url": "https://example.com/one"}).json()["id"]
    _await_state(client, first, "done", "naming")
    assert namer.asked, "the first video did the reading"

    quiet = _StubNamer("9")
    _with_namer(monkeypatch, quiet)
    second = client.post("/api/extract", json={"url": "https://example.com/two"}).json()["id"]
    payload = _await_state(client, second, "done", "naming")

    assert quiet.asked == []
    assert payload["rememberedCount"] == payload["shapeCount"]


def test_a_person_correcting_a_model_wins_in_the_bank(client: TestClient, monkeypatch) -> None:
    _with_namer(monkeypatch, _StubNamer(_all_but_the_rarest))
    first = client.post("/api/extract", json={"url": "https://example.com/one"}).json()["id"]
    _await_state(client, first, "done", "naming")

    # The same shape, named differently by a person on a later video.
    banked = bank_mod.load()
    shape = next(entry for entry in banked.entries if entry.label == "7")
    banked.remember([shape.template], {"0": "9"}, by=bank_mod.HUMAN)
    banked.save()

    reloaded = bank_mod.load()
    assert reloaded.recognise([shape.template]) == {0: "9"}


def test_an_unknown_job_is_a_not_found(client: TestClient) -> None:
    assert client.get("/api/extract/nope").status_code == 404


def test_a_failed_download_is_reported_rather_than_hidden(client: TestClient, monkeypatch) -> None:
    def refuse(url, into, on_progress=None, on_retry=None):
        raise fetch.DownloadFailed("that video is private")

    monkeypatch.setattr(fetch, "download", refuse)
    job_id = client.post("/api/extract", json={"url": "https://example.com/x"}).json()["id"]

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        payload = client.get(f"/api/extract/{job_id}").json()
        if payload["state"] == "error":
            assert "private" in payload["error"]
            return
        time.sleep(0.05)
    raise AssertionError("the failure was never reported")


def test_a_scrolling_video_is_refused_with_a_reason(client: TestClient, monkeypatch) -> None:
    def scrolling(path: str):
        raise pipeline.ScrollingVideo(0.0, 40.0)

    monkeypatch.setattr(pipeline, "check_scroll", scrolling)
    job_id = client.post("/api/extract", json={"url": "https://example.com/scroll"}).json()["id"]

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        payload = client.get(f"/api/extract/{job_id}").json()
        if payload["state"] == "error":
            assert "scrolls" in payload["error"]
            return
        time.sleep(0.05)
    raise AssertionError("the refusal was never reported")


def test_the_service_refuses_a_request_addressed_to_another_host(client: TestClient) -> None:
    """
    A page on any origin can point a browser at a loopback address, so a request
    arriving under someone else's hostname is not answered.
    """
    answer = client.get("/api/health", headers={"host": "tab.evil.example"})
    assert answer.status_code == 421
