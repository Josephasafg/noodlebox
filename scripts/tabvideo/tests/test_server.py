"""
Tests for reading a video and for the service that does it for the app.

A synthetic video stands in for a real one — see `fixture.py` — so the suite stays
deterministic, needs no network, and commits no copyrighted material. The download
itself is always stubbed: nothing here fetches anything.

    python3 -m pytest scripts/tabvideo/tests
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from scripts.tabvideo import bank as bank_mod, fetch, frames, pipeline, server
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
    pages, unspelled = pipeline.emit(readings, shapes, labels)

    assert len(pages) == 3
    assert unspelled == 0
    assert all(page.texts for page in pages), "every system should carry notes"
    horizontals = [s for s in pages[0].segments if abs(s.y1 - s.y0) < 0.01]
    assert len(horizontals) == 6, "the six lines of the tab staff"


def test_shapes_left_unnamed_are_counted_not_guessed(video: Path) -> None:
    readings = pipeline.read_video(str(video))
    shapes = pipeline.find_shapes(readings)
    pages, unspelled = pipeline.emit(readings, shapes, {})
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


def test_a_shape_caught_between_two_names_is_not_decided(tmp_path: Path) -> None:
    """
    A near-tie between two different names is exactly the case that must be asked
    about: guessing it would put a wrong note everywhere that shape occurs.
    """
    base = np.zeros((TEMPLATE_SIZE, TEMPLATE_SIZE), dtype=np.float32)
    nudged = base.copy()
    nudged[0, 0] = 0.02
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    keeper.remember([base], {"0": "6"})
    keeper.remember([nudged], {"0": "5"})
    assert keeper.recognise([base]) == {}


def test_re_reading_a_video_does_not_grow_the_bank(tmp_path: Path) -> None:
    template = _template(4)
    keeper = bank_mod.Bank(path=tmp_path / "bank.json")
    assert keeper.remember([template], {"0": "7"}) == 1
    assert keeper.remember([template], {"0": "7"}) == 0
    assert len(keeper) == 1


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
    monkeypatch.setattr(
        fetch.socket, "getaddrinfo", lambda *a, **k: [(0, 0, 0, "", (address, 0))]
    )
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


def test_node_is_the_runtime_asked_for() -> None:
    # Without a JavaScript runtime yt-dlp hides the high-resolution formats and
    # then fails mid-download with a 403; deno is not installed here.
    assert "node" in fetch.JS_RUNTIMES


# --- the service ----------------------------------------------------------


@pytest.fixture
def client(video: Path, monkeypatch) -> TestClient:
    """A client whose downloads are stubbed with the fixture video."""
    monkeypatch.setattr(fetch, "check_url", lambda raw: raw.strip())

    def stub(url: str, into: Path, on_progress=None) -> fetch.Fetched:
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


def test_an_unknown_job_is_a_not_found(client: TestClient) -> None:
    assert client.get("/api/extract/nope").status_code == 404


def test_a_failed_download_is_reported_rather_than_hidden(client: TestClient, monkeypatch) -> None:
    def refuse(url, into, on_progress=None):
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
