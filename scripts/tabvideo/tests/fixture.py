"""
Build a synthetic tab video for the tests.

Real lesson videos are copyrighted, so nothing here downloads or commits one. The
fixture imitates the four properties the reader actually depends on: a notation
panel that is bright and grey while the rest of the frame is not, each system held
still for seconds and then swapped wholesale, a playback cursor that moves while
the notation underneath does not, and staff lines drawn lighter than the glyphs.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

PAPER = 253
RULE_GREY = 225
INK = 20

WIDTH = 1600
# The panel is cropped closely around the two staves, as a real one is. That is
# not only cosmetic: frames are compared through a 240x40 downsample, so a loose
# panel averages each 1px stroke over so many pixels that a whole system's worth
# of changed notation stops registering as a swap.
PANEL_HEIGHT = 190
CAMERA_HEIGHT = 90

NOTATION_TOP = 22
NOTATION_SPACING = 11
TAB_TOP = 95
TAB_SPACING = 16

FPS = 15.0
HOLD_S = 2.0

# A cursor light enough that it never reads as a glyph, and thin enough that it
# does not dominate the frame. Both matter: a wide bright band moving across an
# otherwise sparse panel is enough to make `measure_scroll` lock onto the cursor
# and report the video as scrolling. Real cursors are thin and real engraving is
# dense, so the notation is what the correlation follows.
CURSOR_GREY = 236
CURSOR_WIDTH = 3


def render_system(notes: list[tuple[int, int, str]], barlines: tuple[int, ...]) -> np.ndarray:
    """
    Draw one engraved system: notation staff, tab staff, fret numbers.

    `notes` are `(string_index, x, text)` with string 0 the top tab line. Each
    fret number also gets a notehead and stem on the notation staff above, which
    is both what real engraving looks like and what makes one system differ from
    the next by enough for a swap to register.
    """
    page = np.full((PANEL_HEIGHT, WIDTH), PAPER, dtype=np.uint8)
    for i in range(5):
        page[NOTATION_TOP + i * NOTATION_SPACING, 20 : WIDTH - 20] = RULE_GREY
    for i in range(6):
        page[TAB_TOP + i * TAB_SPACING, 20 : WIDTH - 20] = RULE_GREY
    for x in barlines:
        page[TAB_TOP : TAB_TOP + 5 * TAB_SPACING + 1, x] = INK
        page[NOTATION_TOP : NOTATION_TOP + 4 * NOTATION_SPACING + 1, x] = INK

    # Beams, drawn between the stem tops of consecutive notes as an engraver
    # would. They are a large share of the ink on a real page.
    stem_tops = [(x + 8, NOTATION_TOP + 6 + s * 7 - 22) for s, x, _ in notes]
    for (x0, y0), (x1, y1) in zip(stem_tops, stem_tops[1:]):
        cv2.line(page, (x0, y0), (x1, y1), int(INK), 3, cv2.LINE_AA)

    for string_index, x, text in notes:
        head_y = NOTATION_TOP + 6 + string_index * 7
        cv2.ellipse(page, (x + 3, head_y), (5, 4), 0, 0, 360, int(INK), -1)
        page[head_y - 22 : head_y, x + 8] = INK

        line_y = TAB_TOP + string_index * TAB_SPACING
        (text_width, text_height), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        # The line is interrupted behind the number, as an engraver would. This has
        # to happen before the glyph is drawn, or it cuts the glyph in half.
        page[line_y, max(0, x - 2) : x + text_width + 2] = PAPER
        cv2.putText(
            page,
            text,
            (x, line_y + text_height // 2),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            int(INK),
            1,
            cv2.LINE_AA,
        )
    return page


def draw_arc(page: np.ndarray, string_index: int, x0: int, x1: int) -> None:
    """A slur arc between two notes: wide, a few pixels tall, above the line."""
    line_y = TAB_TOP + string_index * TAB_SPACING
    cv2.ellipse(
        page, ((x0 + x1) // 2, line_y - 8), ((x1 - x0) // 2, 3), 0, 180, 360, int(INK), 1
    )


def draw_dash(page: np.ndarray, string_index: int, x0: int, x1: int) -> None:
    """A slide dash beside a note: drawn just off the line so rule removal keeps it."""
    line_y = TAB_TOP + string_index * TAB_SPACING
    cv2.line(page, (x0, line_y - 3), (x1, line_y - 3), int(INK), 2)


# Notes per system. A real system of music is densely printed, and the density is
# not cosmetic: `_held_intervals` only calls a swap when the panel changes by more
# than compression noise, so a sparse fixture reads as one long held system. The
# reference video measured over 15 across a swap; roughly fifty notes with beams,
# on a panel the width of a real one, is what puts the fixture in that territory.
NOTES_PER_SYSTEM = 52

FRETS = ("5", "7", "9", "12", "0", "4")


def systems(count: int = 3) -> list[np.ndarray]:
    """
    Systems whose notation genuinely differs, as consecutive ones do.

    Laid out arithmetically rather than by hand so the fixture stays dense: each
    system walks the strings and the fret vocabulary on a different stride, which
    changes nearly every mark on the page from one system to the next.
    """
    pages = []
    for system in range(count):
        notes = []
        for i in range(NOTES_PER_SYSTEM):
            x = 40 + i * ((WIDTH - 100) // NOTES_PER_SYSTEM)
            string_index = (i * (system + 2) + system) % 6
            fret = FRETS[(i * (system + 1)) % len(FRETS)]
            notes.append((string_index, x, fret))
        barlines = (20, 400 + system * 30, 800 + system * 30, 1200 + system * 30, WIDTH - 20)
        pages.append(render_system(notes, barlines))
    return pages


def _frame(page: np.ndarray, cursor_x: int) -> np.ndarray:
    """One video frame: a camera strip above, the notation panel below."""
    panel = page.copy()
    if 0 <= cursor_x < WIDTH - CURSOR_WIDTH:
        band = panel[TAB_TOP - 10 : TAB_TOP + 5 * TAB_SPACING + 10, cursor_x : cursor_x + CURSOR_WIDTH]
        # Only lighten paper, so the cursor never eats a glyph.
        np.copyto(band, CURSOR_GREY, where=band > CURSOR_GREY - 1)
    frame = cv2.cvtColor(panel, cv2.COLOR_GRAY2BGR)
    # A saturated, dark strip so the panel finder has something to exclude.
    camera = np.zeros((CAMERA_HEIGHT, WIDTH, 3), dtype=np.uint8)
    camera[:, :] = (90, 40, 30)
    return np.vstack([camera, frame])


def write_video(path: Path, pages: list[np.ndarray] | None = None, hold_s: float = HOLD_S) -> Path:
    """Write the fixture video, each system held then swapped for the next."""
    pages = pages if pages is not None else systems()
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        FPS,
        (WIDTH, PANEL_HEIGHT + CAMERA_HEIGHT),
    )
    if not writer.isOpened():
        raise RuntimeError("OpenCV could not open an mp4 writer")
    per_page = int(round(hold_s * FPS))
    for page in pages:
        for index in range(per_page):
            cursor = int(WIDTH * index / max(1, per_page - 1)) - CURSOR_WIDTH // 2
            writer.write(_frame(page, cursor))
    writer.release()
    return path
