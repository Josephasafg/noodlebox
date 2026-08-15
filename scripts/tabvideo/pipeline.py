"""
Reading a tab video, from frames to emitted primitives.

This is the whole recognition pass with no opinion about where it is driven
from: `cli.py` runs it from a terminal and `server.py` runs it for the app, and
both must behave identically, so the steps live here rather than in either.

The one step that is not here is naming the glyph shapes. That is deliberately a
caller's problem — the CLI asks for a labels file and the server asks the app —
because a wrong name becomes a wrong note everywhere that shape occurs, and
nothing available guesses well enough to be trusted with it. See
`scripts/tabvideo/README.md` for the measurements behind that.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from . import frames, glyphs, primitives, staff as staff_mod

# Continuous scrolling needs the frames mosaicked before a system can be read.
# Detected drift above this many pixels per second means the held-system reader
# would return fragments, so callers refuse rather than emit nonsense.
SCROLL_LIMIT_PX_PER_S = 2.0

# No guitar has a 25th fret, so a token that reads as a larger number is two
# notes whose digits were kerned tightly enough to be grouped as one.
MAX_FRET = 24


class ScrollingVideo(Exception):
    """Raised for a video that scrolls its notation instead of holding it."""

    def __init__(self, dx: float, dy: float) -> None:
        self.dx = dx
        self.dy = dy
        super().__init__(
            f"this video scrolls ({dx:+.1f}, {dy:+.1f}) px/s; only videos that hold each "
            "system still can be read, because a scrolling one has to be mosaicked first"
        )


class UnreadableVideo(Exception):
    """Raised when the file cannot be decoded at all."""


def tab_staves(rules: list[staff_mod.Rule]) -> list[staff_mod.Staff]:
    """Tab staves only: six evenly spaced lines, not the notation staff's five."""
    return staff_mod.find_staves(rules, staff_mod.TAB_STAFF_LINES)


class Reading:
    """Everything found on one composited system."""

    def __init__(self, page: frames.Page) -> None:
        self.page = page
        # Ruled geometry comes from the permissive mask because staff lines are
        # often drawn far lighter than the notes; glyphs come from the dark one.
        self.marks = staff_mod.marks(page.image)
        self.ink = staff_mod.to_ink(page.image)
        self.rules = staff_mod.find_rules(self.marks)
        self.staves = tab_staves(self.rules)
        self.without_rules = staff_mod.remove_rules(self.ink, self.rules)
        self.runs: list[tuple[staff_mod.Staff, glyphs.Run]] = []
        self.components: list[glyphs.Component] = []
        for one in self.staves:
            found = glyphs.components_on_staff(self.without_rules, one)
            grouped = glyphs.group_runs(found, one)
            # Marks too small to be glyphs were dropped on the way here; where one
            # sat beside a token, the token is incomplete and must not be read as
            # whatever part of it survived.
            glyphs.flag_truncated(self.without_rules, one, grouped, found)
            self.components.extend(found)
            self.runs.extend((one, run) for run in grouped)

    @property
    def barlines(self) -> list[tuple[staff_mod.Staff, staff_mod.Barline]]:
        out = []
        for one in self.staves:
            out.extend((one, bar) for bar in staff_mod.find_barlines(self.marks, one))
        return out


def check_scroll(path: str) -> tuple[int, int]:
    """
    Find the notation panel and confirm the video holds its systems still.

    Raises `ScrollingVideo` for a scrolling one, so a caller never has to
    remember to test the drift itself.
    """
    capture = cv2.VideoCapture(path)
    ok, first = capture.read()
    capture.release()
    if not ok:
        raise UnreadableVideo(f"could not read any frames from {path}")
    panel = frames.find_panel(first)
    dx, dy = frames.measure_scroll(path, panel)
    if max(abs(dx), abs(dy)) > SCROLL_LIMIT_PX_PER_S:
        raise ScrollingVideo(dx, dy)
    return panel.top, panel.bottom


def read_video(path: str, limit: int | None = None, on_system=None) -> list[Reading]:
    """
    Composite and read every held system in the video.

    `on_system` is called with the count so far, because on a long video this is
    minutes of work and the caller is usually showing progress.
    """
    out: list[Reading] = []
    for page in frames.read_pages(path):
        out.append(Reading(page))
        if on_system is not None:
            on_system(len(out))
        if limit is not None and len(out) >= limit:
            break
    return out


@dataclass
class Shapes:
    """The distinct glyph shapes in a video, commonest first."""

    every: list[glyphs.Component]
    assignment: list[int]
    centroids: list[np.ndarray]
    counts: list[int]
    index_of: dict[int, int]

    def __len__(self) -> int:
        return len(self.centroids)

    def coverage(self, named: int) -> float:
        """Fraction of all marks accounted for by the `named` commonest shapes."""
        total = sum(self.counts)
        if total == 0:
            return 0.0
        return sum(self.counts[:named]) / total

    def label_of(self, component: glyphs.Component) -> int:
        """Which shape a given mark belongs to."""
        return self.assignment[self.index_of[id(component)]]

    @classmethod
    def of(cls, components: list[glyphs.Component]) -> "Shapes":
        """Cluster marks into distinct shapes, commonest first."""
        assignment, centroids = glyphs.cluster(components)
        assignment, centroids, counts = by_frequency(assignment, centroids)
        return cls(
            every=list(components),
            assignment=assignment,
            centroids=centroids,
            counts=counts,
            index_of={id(component): index for index, component in enumerate(components)},
        )


def by_frequency(
    assignment: list[int], centroids: list[np.ndarray]
) -> tuple[list[int], list[np.ndarray], list[int]]:
    """
    Renumber clusters so the commonest shape is 0.

    A whole video throws up a long tail of one-off shapes — a digit fused to a
    slide line, a fragment of a slur — and there is no point asking anyone to
    name 200 of those. Ordering by how often a shape occurs means labelling can
    stop when the remaining ones no longer matter, and the count of marks each
    one accounts for says where that point is.
    """
    counts = np.bincount(assignment, minlength=len(centroids))
    order = list(np.argsort(-counts))
    renumbered = {int(old): new for new, old in enumerate(order)}
    return (
        [renumbered[value] for value in assignment],
        [centroids[old] for old in order],
        [int(counts[old]) for old in order],
    )


def find_shapes(readings: list[Reading]) -> Shapes:
    """Cluster every mark in the video into distinct shapes, commonest first."""
    every: list[glyphs.Component] = []
    for reading in readings:
        every.extend(reading.components)
    return Shapes.of(every)


def _owners(readings: list[Reading]) -> dict[int, Reading]:
    owner: dict[int, Reading] = {}
    for reading in readings:
        for component in reading.components:
            owner[id(component)] = reading
    return owner


def _first_of_each(shapes: Shapes) -> dict[int, glyphs.Component]:
    first: dict[int, glyphs.Component] = {}
    for index, component in enumerate(shapes.every):
        first.setdefault(shapes.assignment[index], component)
    return first


def shape_crop(
    readings: list[Reading], shapes: Shapes, index: int, scale: int = 6, pad: int = 2
) -> np.ndarray | None:
    """
    One shape as the pixels it really is, magnified for a person to read.

    Aspect ratio is preserved, which matters more than it looks: squashing a
    glyph to a square costs real information — a stretched digit was measured
    losing ten points of recognition accuracy — and the reader here is being
    asked to tell a 6 from a 5 at around ten pixels tall.
    """
    component = _first_of_each(shapes).get(index)
    if component is None:
        return None
    image = _owners(readings)[id(component)].page.image
    crop = image[
        max(0, component.y0 - pad) : component.y1 + pad,
        max(0, component.x0 - pad) : component.x1 + pad,
    ]
    if crop.size == 0:
        return None
    return cv2.resize(
        crop,
        (crop.shape[1] * scale, crop.shape[0] * scale),
        interpolation=cv2.INTER_NEAREST,
    )


def exemplar_sheet(
    readings: list[Reading],
    shapes: Shapes,
    columns: int = 10,
    scale: int = 5,
) -> np.ndarray:
    """
    Show one real crop per shape, taken from the frame it was found in.

    A shape's average template is what recognition compares against, but it is a
    poor thing to ask a person to read. The original pixels, magnified, are
    unambiguous — which matters because a mislabelled shape is a wrong note
    everywhere it occurs.
    """
    pad = 2
    cell = int(round(glyphs.TEMPLATE_SIZE * scale * 0.9))
    label_space = 16
    rows = (len(shapes) + columns - 1) // columns
    sheet = np.full((rows * (cell + label_space), columns * cell), 255, dtype=np.uint8)
    owner = _owners(readings)
    first = _first_of_each(shapes)
    for index in range(len(shapes)):
        component = first.get(index)
        if component is None:
            continue
        image = owner[id(component)].page.image
        crop = image[
            max(0, component.y0 - pad) : component.y1 + pad,
            max(0, component.x0 - pad) : component.x1 + pad,
        ]
        if crop.size == 0:
            continue
        tile = cv2.resize(crop, (cell, cell), interpolation=cv2.INTER_NEAREST)
        row, column = divmod(index, columns)
        y = row * (cell + label_space) + label_space
        x = column * cell
        sheet[y : y + cell, x : x + cell] = tile
        cv2.putText(
            sheet, str(index), (x + 2, y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, 0, 1, cv2.LINE_AA
        )
    return sheet


def _tokens(
    run: glyphs.Run,
    spelled: str,
    shapes: Shapes,
    labels: dict[str, str],
    dx: float,
) -> list[primitives.Text]:
    """
    Turn one grouped run into the text items it really represents.

    Grouping happens before the characters are known, so a pair of single-digit
    notes printed close together can arrive as one run. An impossible fret number
    is the tell, and the fix is to hand back each character separately, letting
    the parser place them as two onsets.
    """

    def item(text: str, x0: float, x1: float, baseline: float, height: float) -> primitives.Text:
        return primitives.Text(str=text, x=x0 + dx, y=baseline, fontSize=height, width=x1 - x0)

    if spelled.isdigit() and int(spelled) > MAX_FRET and len(run.components) == 1:
        # One mark that reads as an impossible fret is a pair the splitter failed
        # to cut. Reporting nothing keeps it in the unread count, where it shows
        # up as lost confidence rather than as a wrong note on the fretboard.
        return []
    if spelled.isdigit() and int(spelled) > MAX_FRET and len(run.components) > 1:
        return [
            item(
                labels[str(shapes.label_of(glyph))],
                float(glyph.x0),
                float(glyph.x1),
                float(glyph.y1),
                float(glyph.height),
            )
            for glyph in run.components
        ]
    return [item(spelled, float(run.x0), float(run.x1), run.baseline, float(run.height))]


def emit(
    readings: list[Reading], shapes: Shapes, labels: dict[str, str]
) -> tuple[list[primitives.PagePrimitives], int]:
    """Build page primitives, reporting how many tokens could not be spelled."""
    pages: list[primitives.PagePrimitives] = []
    unspelled = 0
    for reading in readings:
        height, width = reading.page.image.shape
        declared_width, declared_height, dx = primitives.page_frame(width, height)

        # Only the staves themselves are emitted, not every ruled line on the page.
        #
        # Chord boxes and brackets above the staff are ruled lines too, and the
        # parser walks rules in order: an irregular one just above a staff starts
        # a run of its own, and because a run of one accepts any gap it then
        # swallows the staff's first line, leaving five and hiding the staff
        # entirely. Emitting only real staff geometry keeps that from arising.
        #
        # It costs the notation staff, which the parser looks for to pair with a
        # tab staff. Nothing here depends on finding it: barlines are emitted
        # directly, and bend marks are read from a band measured off the tab staff.
        segments = []
        for one in reading.staves:
            if not one.rules:
                continue
            # Each line of a staff shares its extent on the page, but measuring
            # them separately does not recover that — fret numbers punch gaps
            # through the ends of some lines and not others. The consensus extent
            # is what the parser's own same-extent test needs to see.
            x0 = float(np.median([r.x0 for r in one.rules])) + dx
            x1 = float(np.median([r.x1 for r in one.rules])) + dx
            for rule in one.rules:
                segments.append(primitives.Segment(x0=x0, y0=rule.y, x1=x1, y1=rule.y))
        for _, bar in reading.barlines:
            segments.append(primitives.Segment(x0=bar.x + dx, y0=bar.y0, x1=bar.x + dx, y1=bar.y1))

        texts: list[primitives.Text] = []
        for _, run in reading.runs:
            if run.truncated:
                # Part of this number was never captured, so any reading of it
                # would be a wrong note rather than a gap.
                unspelled += 1
                continue
            spelled = glyphs.spell(run, shapes.assignment, shapes.index_of, labels)
            if spelled is None:
                unspelled += 1
                continue
            tokens = _tokens(run, spelled, shapes, labels, dx)
            if not tokens:
                unspelled += 1
                continue
            texts.extend(tokens)
        pages.append(
            primitives.PagePrimitives(
                pageIndex=reading.page.index,
                width=declared_width,
                height=declared_height,
                segments=segments,
                texts=texts,
            )
        )
    return pages, unspelled
