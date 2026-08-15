"""
Turn a tab video into one clean image per engraved system.

Videos that show rolling tablature come in two shapes: the notation scrolls
continuously past a fixed window, or a whole system is held on screen and
swapped for the next one. Only the second is read here. The first needs its
frames mosaicked into one long image before a system can be recognised, so
`measure_scroll` exists to tell the two apart and let the caller refuse the
scrolling case rather than return fragments of it.

Everything downstream works on still images, so this is the only module that
knows a video was involved.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

import cv2
import numpy as np

# A frame region counts as engraved paper when it is bright and unsaturated.
# Camera footage of a room fails both tests even when the wall behind is pale.
PAPER_MAX_SATURATION = 30.0
PAPER_MIN_VALUE = 180.0

# Mean absolute grey difference, on a downsampled panel, that separates "the
# system changed" from compression noise. Measured spread on real video is
# ~0.01 between held frames against >15 across a swap, so this sits far from both.
SWAP_THRESHOLD = 6.0

# Frames sampled per second when looking for swaps. Systems are held for
# seconds at a time, so this is plenty and keeps the scan cheap.
SCAN_FPS = 6.0

# Fraction of a held interval trimmed from each end before compositing, so that
# fades and the frames either side of a swap never reach the median.
SETTLE_TRIM = 0.25

# Frames combined per system. An odd count gives the median a true middle
# sample, and a handful is enough to erase a playback cursor.
COMPOSITE_SAMPLES = 5


@dataclass(frozen=True)
class Panel:
    """The rows of the frame that hold engraved notation."""

    top: int
    bottom: int

    @property
    def height(self) -> int:
        return self.bottom - self.top


@dataclass(frozen=True)
class Page:
    """One engraved system, composited from the frames that held it."""

    index: int
    start_s: float
    end_s: float
    image: np.ndarray
    """Greyscale, cropped to the panel."""


class VideoUnreadable(RuntimeError):
    pass


def _open(path: str) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise VideoUnreadable(f"could not decode {path}")
    return cap


def find_panel(frame: np.ndarray) -> Panel:
    """
    Locate the notation panel in a frame.

    Tab videos usually pair a camera with the score, so the score occupies a
    band rather than the whole frame. The band is found by row statistics in HSV
    instead of by edge detection: a row of engraved paper is bright and grey
    almost everywhere, which stays true whether the notation is dense or empty,
    and does not depend on where the split happens to fall.
    """
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1].mean(axis=1)
    value = hsv[:, :, 2].mean(axis=1)
    paper = (saturation < PAPER_MAX_SATURATION) & (value > PAPER_MIN_VALUE)
    if not paper.any():
        raise VideoUnreadable("no engraved panel found; is this a tab video?")

    rows = np.flatnonzero(paper)
    runs = np.split(rows, np.flatnonzero(np.diff(rows) > 1) + 1)
    longest = max(runs, key=len)
    return Panel(top=int(longest[0]), bottom=int(longest[-1]) + 1)


def _signature(gray_panel: np.ndarray) -> np.ndarray:
    """A small, blur-tolerant fingerprint used only to compare frames."""
    return cv2.resize(gray_panel, (240, 40), interpolation=cv2.INTER_AREA).astype(np.float32)


def _scan(path: str, panel: Panel) -> tuple[list[float], list[np.ndarray], float]:
    """Sample the panel across the video, returning timestamps and signatures."""
    cap = _open(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, int(round(fps / SCAN_FPS)))

    times: list[float] = []
    signatures: list[np.ndarray] = []
    for index in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame[panel.top : panel.bottom], cv2.COLOR_BGR2GRAY)
        times.append(index / fps)
        signatures.append(_signature(gray))
    cap.release()
    if not signatures:
        raise VideoUnreadable("no frames could be read")
    return times, signatures, fps


def measure_scroll(path: str, panel: Panel) -> tuple[float, float]:
    """
    Median per-second drift of the panel, in pixels.

    A continuously scrolling video reports a steady non-zero shift on one axis;
    a video that holds each system reports zero on both, with the swaps showing
    up as correlation failures rather than as motion. The distinction decides
    whether pages can be read straight off the frames.
    """
    cap = _open(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    shifts: list[tuple[float, float]] = []
    for fraction in (0.2, 0.4, 0.6, 0.8):
        base = int(total * fraction)
        cap.set(cv2.CAP_PROP_POS_FRAMES, base)
        ok_a, frame_a = cap.read()
        cap.set(cv2.CAP_PROP_POS_FRAMES, base + int(fps))
        ok_b, frame_b = cap.read()
        if not (ok_a and ok_b):
            continue
        a = cv2.cvtColor(frame_a[panel.top : panel.bottom], cv2.COLOR_BGR2GRAY).astype(np.float32)
        b = cv2.cvtColor(frame_b[panel.top : panel.bottom], cv2.COLOR_BGR2GRAY).astype(np.float32)
        (dx, dy), response = cv2.phaseCorrelate(a, b)
        # A swap decorrelates the pair, so its offset is meaningless: drop it.
        if response > 0.2:
            shifts.append((dx, dy))
    cap.release()
    if not shifts:
        return 0.0, 0.0
    return (
        float(np.median([s[0] for s in shifts])),
        float(np.median([s[1] for s in shifts])),
    )


def _held_intervals(times: list[float], signatures: list[np.ndarray]) -> list[tuple[float, float]]:
    """Split the timeline where the panel content changes wholesale."""
    bounds = [times[0]]
    for i in range(1, len(signatures)):
        if float(np.abs(signatures[i] - signatures[i - 1]).mean()) > SWAP_THRESHOLD:
            bounds.append(times[i])
    bounds.append(times[-1])
    return [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]


def _composite(cap: cv2.VideoCapture, panel: Panel, fps: float, start_s: float, end_s: float) -> np.ndarray | None:
    """
    Median-combine several frames from one held interval.

    The median is what removes a playback cursor: the highlight is somewhere
    different in every sample while the notation underneath never moves, so the
    middle value at each pixel is the engraving. It also suppresses the block
    noise that lossy video leaves around thin glyphs.
    """
    span = end_s - start_s
    trim = span * SETTLE_TRIM
    lo, hi = start_s + trim, end_s - trim
    if hi <= lo:
        lo = hi = (start_s + end_s) / 2

    stack: list[np.ndarray] = []
    for t in np.linspace(lo, hi, COMPOSITE_SAMPLES):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, frame = cap.read()
        if ok:
            stack.append(cv2.cvtColor(frame[panel.top : panel.bottom], cv2.COLOR_BGR2GRAY))
    if not stack:
        return None
    return np.median(np.stack(stack), axis=0).astype(np.uint8)


def _looks_blank(image: np.ndarray) -> bool:
    """Reject intervals that hold no engraving, such as a title card."""
    return float((image < 128).mean()) < 0.002


def read_pages(path: str, min_hold_s: float = 1.0) -> Iterator[Page]:
    """
    Yield one composited image per engraved system, in playing order.

    Only the held-system layout is emitted here. Continuous scrolling needs the
    frames mosaicked before they can be read, which `measure_scroll` detects and
    the caller is told about rather than silently mishandled.
    """
    cap = _open(path)
    ok, first = cap.read()
    if not ok:
        cap.release()
        raise VideoUnreadable("no frames could be read")
    panel = find_panel(first)
    cap.release()

    times, signatures, fps = _scan(path, panel)
    intervals = [iv for iv in _held_intervals(times, signatures) if iv[1] - iv[0] >= min_hold_s]

    cap = _open(path)
    emitted = 0
    previous: np.ndarray | None = None
    try:
        for start_s, end_s in intervals:
            image = _composite(cap, panel, fps, start_s, end_s)
            if image is None or _looks_blank(image):
                continue
            # A repeated section shows the same system twice; only drop it when
            # it repeats back to back, which is re-detection of one swap rather
            # than a genuine second pass through the music.
            signature = _signature(image)
            if previous is not None and float(np.abs(signature - previous).mean()) <= SWAP_THRESHOLD:
                continue
            previous = signature
            yield Page(index=emitted, start_s=start_s, end_s=end_s, image=image)
            emitted += 1
    finally:
        cap.release()
