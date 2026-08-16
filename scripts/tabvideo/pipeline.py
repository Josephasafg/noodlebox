"""
Reading a tab video, from frames to emitted primitives.

This is the whole recognition pass with no opinion about where it is driven
from: `cli.py` runs it from a terminal and `server.py` runs it for the app, and
both must behave identically, so the steps live here rather than in either.

The one step that is not here is naming the glyph shapes. That is deliberately a
caller's problem — the CLI asks for a labels file, and the server takes what
`bank.py` already knows, has `namer.py` read the rest where a vision model is
configured, and asks the app about whatever is still unnamed. A wrong name becomes
a wrong note everywhere that shape occurs, so who may decide what a glyph says is
a policy question, and it does not belong in the recognition path. See
`scripts/tabvideo/README.md`.
"""

from __future__ import annotations

import re
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

# Every name a shape may carry. Beyond fret numbers, muted notes and ghost
# brackets, video fonts fuse techniques into single marks: a hammer-on prints as
# a small digit against a full one ("4h6"), a pull-off as an arc over the pair
# ("4p2", or a lone "~", or "4~"/"~4" when the arc touches its digit), and a
# slide as a dash beside its number ("12-", "-12", or a lone "-"), and a bend
# as an up-curved arrow that may fuse with its digit ("12b", or a lone "b" for
# the arrow by itself; this font prints no amount, only the arrow). The empty
# string is a confirmed not-a-number. This is the single definition: the server
# validates submissions against it and `emit` interprets the same grammar.
LABEL_RE = re.compile(
    r"^(?:\d{1,2}(?:[hp]\d{1,2}|-{1,2}|~|b)?|-{1,2}\d{1,2}|-{1,2}|~\d{1,2}|~|b\d{1,2}|b|[x()])?$"
)

# How much of the page to keep either side of a printed number when a shape is
# rendered to be read, as a fraction of staff spacing. Enough to show the rest of
# the number and the lines it sits on, without pulling in the next note along.
CONTEXT_MARGIN = 0.5

# Six strings share a staff, so the band around a number also holds whatever is
# played on the strings above and below it, and the model reads the two together:
# a `4` with a `2` above it came back as "a 4 sitting below a 2" and went unnamed
# — 123 marks, 5% of the reference clip.
#
# Cropping them out was tried and measured worse. A number is 0.77 of the string
# spacing tall (median over 1825 of them, p10 0.72, p90 0.78), leaving about 0.23
# of clear air, so the margin that excludes a neighbour is 0.2 and there is no
# slope to trade along: 0.3 already catches one in 66.5% of crops. At 0.2 the
# digits sit hard against the frame with no staff around them, and legibility
# went with the context — the `1` of a printed `11`, 341 marks, stopped being
# named at all, and marks left unread nearly doubled.
#
# So the band stays generous and the other strings' marks are painted out of it
# instead. That keeps what makes context work — room around the glyph, the lines
# that fix its baseline, the neighbouring digit that fixes its size — and removes
# only the thing that was being misread as part of the number.
PAPER_PERCENTILE = 95

# The colour a context render outlines the mark in, and how thick. Colour rather
# than grey: the page is monochrome, so red is the one thing on it that cannot be
# read as engraving — whereas any grey sits inside the range the staff lines and
# the glyphs already occupy.
#
# This was a mid grey at one pixel, on the reasoning that it would read as an
# annotation. It did not. Asked about the `2` inside a printed `12`, the model
# answered `12-` — describing the whole number, and reading the interrupted staff
# line either side of it as a slide dash — and all three looks agreed, so the
# consensus rule passed it straight through. An outline that can be mistaken for
# part of the notation is worse than none, because the answer then comes back
# about the wrong subject with no sign that anything went wrong.
CONTEXT_OUTLINE = (0, 0, 255)
CONTEXT_OUTLINE_WIDTH = 2


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
        # Flat technique marks — slur arcs and slide dashes — kept apart from the
        # glyphs so they can never join a run, but clustered and named like any
        # other shape. What one means is decided in `emit`, from its label and
        # the notes beside it.
        self.flat_marks: list[tuple[staff_mod.Staff, glyphs.Component]] = []
        for one in self.staves:
            found = glyphs.components_on_staff(self.without_rules, one)
            flats = glyphs.marks_on_staff(self.without_rules, one)
            grouped = glyphs.group_runs(found, one)
            # Marks too small to be glyphs were dropped on the way here; where one
            # sat beside a token, the token is incomplete and must not be read as
            # whatever part of it survived.
            glyphs.flag_truncated(self.without_rules, one, grouped, found, flats)
            self.components.extend(found)
            self.flat_marks.extend((one, flat) for flat in flats)
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
        every.extend(flat for _, flat in reading.flat_marks)
    return Shapes.of(every)


def _owners(readings: list[Reading]) -> dict[int, Reading]:
    owner: dict[int, Reading] = {}
    for reading in readings:
        for component in reading.components:
            owner[id(component)] = reading
        for _, flat in reading.flat_marks:
            owner[id(flat)] = reading
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
    return component_crop(readings, component, scale=scale, pad=pad)


def shape_members(
    readings: list[Reading], shapes: Shapes, index: int, limit: int = 3
) -> list[glyphs.Component]:
    """
    Several marks belonging to one shape, taken from as many systems as possible.

    Anything asked to name a shape should be shown more than one printing of it,
    so that agreement between the answers means something. Two crops of the same
    mark are one observation twice; two crops from different systems are two, and
    a disagreement between them is a signal the shape is not being read reliably.
    """
    owner = _owners(readings)
    by_system: dict[int, list[glyphs.Component]] = {}
    for position, component in enumerate(shapes.every):
        if shapes.assignment[position] != index:
            continue
        reading = owner.get(id(component))
        by_system.setdefault(id(reading), []).append(component)

    # One from each system before a second from any, so a shape printed on ten
    # systems is never sampled three times from the same one.
    out: list[glyphs.Component] = []
    queues = list(by_system.values())
    depth = 0
    while len(out) < limit and any(len(queue) > depth for queue in queues):
        for queue in queues:
            if len(queue) > depth:
                out.append(queue[depth])
                if len(out) == limit:
                    break
        depth += 1
    return out


def _locate(
    reading: Reading, component: glyphs.Component
) -> tuple[staff_mod.Staff | None, glyphs.Run | None]:
    """The staff a mark sits on and the token it spells part of, if any."""
    for one, run in reading.runs:
        if any(member is component for member in run.components):
            return one, run
    for one, flat in reading.flat_marks:
        if flat is component:
            return one, None
    return None, None


def _hide_other_strings(
    crop: np.ndarray,
    reading: Reading,
    one: staff_mod.Staff,
    run: glyphs.Run | None,
    component: glyphs.Component,
    left: int,
    top: int,
) -> None:
    """
    Paint out notes played on other strings, in place.

    Only marks that sit clear of this number vertically are removed, so a note
    printed beside it on the same string stays: it is the neighbouring glyph that
    fixes the size, and losing that is what made the tight crop worse than the
    problem it fixed.
    """
    band = run.components if run and run.components else [component]
    band_top = min(mark.y0 for mark in band)
    band_bottom = max(mark.y1 for mark in band)
    keep = {id(mark) for mark in band} | {id(component)}

    others: list[glyphs.Component] = [
        mark
        for other_staff, other in reading.runs
        if other_staff is one
        for mark in other.components
    ]
    others.extend(flat for other_staff, flat in reading.flat_marks if other_staff is one)

    paper = int(np.percentile(crop, PAPER_PERCENTILE))
    for mark in others:
        if id(mark) in keep:
            continue
        if mark.y1 >= band_top and mark.y0 <= band_bottom:
            continue  # level with this number, so part of its line rather than another's
        crop[
            max(0, mark.y0 - top - 1) : max(0, mark.y1 - top + 2),
            max(0, mark.x0 - left - 1) : max(0, mark.x1 - left + 2),
        ] = paper


def shape_context(
    readings: list[Reading],
    component: glyphs.Component,
    scale: int = 6,
) -> np.ndarray | None:
    """
    One mark shown inside the number and the staff it belongs to, magnified.

    A digit ten pixels tall is far more legible in context than alone: the glyph
    beside it fixes the size, and the lines under it fix the baseline, which is
    most of what separates a `6` from a `5`. The mark is outlined rather than
    cropped to, because the question being asked is about that mark and not about
    its neighbour.
    """
    reading = _owners(readings).get(id(component))
    if reading is None:
        return None
    one, run = _locate(reading, component)
    if one is None:
        return None

    image = reading.page.image
    margin = one.spacing * CONTEXT_MARGIN
    left = max(0, int(round((run.x0 if run else component.x0) - margin)))
    right = min(image.shape[1], int(round((run.x1 if run else component.x1) + margin)))
    top = max(0, int(round(one.top - one.spacing * glyphs.BAND_MARGIN)))
    bottom = min(image.shape[0], int(round(one.bottom + one.spacing * glyphs.BAND_MARGIN)))
    if right - left < 1 or bottom - top < 1:
        return None

    crop = image[top:bottom, left:right].copy()
    if crop.size == 0:
        return None
    _hide_other_strings(crop, reading, one, run, component, left, top)
    out = cv2.resize(
        crop,
        (crop.shape[1] * scale, crop.shape[0] * scale),
        interpolation=cv2.INTER_NEAREST,
    )
    # Colour only so the outline has somewhere to live; the notation stays grey.
    out = cv2.cvtColor(out, cv2.COLOR_GRAY2BGR)
    cv2.rectangle(
        out,
        ((component.x0 - left) * scale - 1, (component.y0 - top) * scale - 1),
        ((component.x1 - left) * scale, (component.y1 - top) * scale),
        CONTEXT_OUTLINE,
        CONTEXT_OUTLINE_WIDTH,
    )
    return out


def component_crop(
    readings: list[Reading], component: glyphs.Component, scale: int = 6, pad: int = 2
) -> np.ndarray | None:
    """One mark's own pixels, magnified — `shape_crop` for a chosen member."""
    reading = _owners(readings).get(id(component))
    if reading is None:
        return None
    image = reading.page.image
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


# The technique grammar of a spelled token, matching LABEL_RE's vocabulary.
# Placement works by character proportion: "12p10" is five characters across the
# run's box, so the "12" gets the first two fifths and the "10" the last two.
_LEGATO_PAIR = re.compile(r"^(\d{1,2})([hp])(\d{1,2})$")
_ARC_AFTER = re.compile(r"^(\d{1,2})~$")
_ARC_BEFORE = re.compile(r"^~(\d{1,2})$")
_SLIDE_AFTER = re.compile(r"^(\d{1,2})(-{1,2})$")
_SLIDE_BEFORE = re.compile(r"^(-{1,2})(\d{1,2})$")
_LONE_SLIDE = re.compile(r"^-{1,2}$")
_BEND_AFTER = re.compile(r"^(\d{1,2})b$")
# The arrow leans over the note it belongs to rather than sitting after it, so
# which side of the digit it groups on is down to where its stem happens to
# start. Both orders mean the same bend.
_BEND_BEFORE = re.compile(r"^b(\d{1,2})$")

# How far, in staff spaces, a slur arc reaches for the notes it joins. Notes on
# one string sit at least 2.5 glyph-heights apart (the run-joining measurement),
# so the partner of a legato pair is closer than this and the next phrase is not.
ARC_REACH = 2.5

# Two notes are on the same string when their baselines agree to well under a
# space; the tolerance absorbs the odd pixel of bounding-box slack.
SAME_STRING_TOL = 0.6


# Above this bow (see `glyphs._bow`) a flat mark is a slur arc; below, a slide
# dash. The pixels decide rather than the label, because arcs and dashes
# normalise into near-identical templates and can share one cluster — one label
# then covers marks of both kinds, and only each mark's own curve tells them
# apart. Measured over the reference clip's 56 flat marks: the 11 dashes bow at
# most 0.5px while 45 of the 46 arcs bow 0.9-1.8px, with a single shallow arc at
# 0.5 that this misreads as a slide — a decoration wobble, not a wrong note.
ARC_MIN_BOW = 0.75


@dataclass
class _Note:
    """An emitted fret token, kept so slur directions can be resolved."""

    cx: float
    baseline: float
    fret: int | None
    item: primitives.Text


def _fret_of(text: str) -> int | None:
    bare = text.strip("()")
    return int(bare) if bare.isdigit() else None


class _StaffTexts:
    """
    The text items for one staff: fret tokens plus the technique marks.

    Techniques come out in the vocabulary the parser already reads from PDFs — an
    `h`, `p` or `sl.` printed below the staff attaches to the note that follows
    it — so nothing downstream needs to know videos exist. A slur arc's own label
    cannot say which way it goes; that is resolved here by comparing the frets it
    joins, which is why arcs wait until every note on the staff is known.
    """

    def __init__(self, staff: staff_mod.Staff, dx: float) -> None:
        self.staff = staff
        self.dx = dx
        self.spacing = staff.spacing
        # Inside the band the parser reads legato marks from: below the staff,
        # above the lyrics.
        self.mark_y = staff.bottom + staff.spacing * 2.0
        self.notes: list[_Note] = []
        self.marks: list[primitives.Text] = []
        # Arcs whose direction is not decided yet: (anchor cx, from, to).
        self.arcs: list[tuple[float, _Note | None, _Note | None]] = []
        self.unread = 0

    def note(self, text: str, x0: float, x1: float, baseline: float, height: float) -> _Note:
        item = primitives.Text(str=text, x=x0 + self.dx, y=baseline, fontSize=height, width=x1 - x0)
        made = _Note(cx=(x0 + x1) / 2, baseline=baseline, fret=_fret_of(text), item=item)
        self.notes.append(made)
        return made

    def slide(self, cx: float) -> None:
        # The parser attaches `sl.` to the first note right of it, so a dash
        # trailing a note points at the note slid into, and a leading one at its
        # own note. Both are what the dash means.
        self.marks.append(
            primitives.Text(
                str="sl.", x=cx - 2 + self.dx, y=self.mark_y, fontSize=self.spacing * 0.6, width=4
            )
        )

    def legato(self, letter: str, cx: float) -> None:
        self.marks.append(
            primitives.Text(
                str=letter, x=cx - 2 + self.dx, y=self.mark_y, fontSize=self.spacing * 0.6, width=4
            )
        )

    def bend(self, cx: float) -> None:
        # This font draws only the arrow, never an amount, so the word is all
        # that can honestly be said; the parser turns it into a bend whose
        # target is unknown, shown as `12↑` rather than an invented fret. It
        # goes in the band above the staff where bend amounts are read from,
        # and its left edge is what the parser attaches by.
        self.marks.append(
            primitives.Text(
                str="bend",
                x=cx + self.dx,
                y=self.staff.top - self.spacing * 1.5,
                fontSize=self.spacing * 0.6,
                width=10,
            )
        )

    def add_run(
        self, run: glyphs.Run, spelled: str, shapes: Shapes, labels: dict[str, str]
    ) -> None:
        x0, x1 = float(run.x0), float(run.x1)
        baseline, height = run.baseline, float(run.height)
        width = x1 - x0

        def span(i: int, j: int) -> tuple[float, float]:
            return x0 + width * i / len(spelled), x0 + width * j / len(spelled)

        if spelled.isdigit() and int(spelled) > MAX_FRET:
            if len(run.components) == 1:
                # One mark that reads as an impossible fret is a pair the splitter
                # failed to cut. Reporting nothing keeps it in the unread count,
                # as lost confidence rather than a wrong note on the fretboard.
                self.unread += 1
                return
            if len(run.components) > 2:
                # Three or more digits are at least two numbers, and nothing here
                # says where one ends. "911" is a fret 9 then a fret 11, printed
                # with the 9 closer to the 1 than the two 1s are to each other, so
                # the gaps do not answer it either. Splitting per character would
                # spell it 9, 1, 1 — one right note and two invented ones — so it
                # is reported unread instead.
                self.unread += 1
                return
            # Grouping happens before the characters are known, so a pair of
            # single-digit notes printed close together can arrive as one run.
            # The impossible number is the tell; each character goes back
            # separately for the parser to place as its own onset.
            for glyph in run.components:
                self.note(
                    labels[str(shapes.label_of(glyph))],
                    float(glyph.x0),
                    float(glyph.x1),
                    float(glyph.y1),
                    float(glyph.height),
                )
            return

        if match := _LEGATO_PAIR.match(spelled):
            frm, letter, to = match.group(1), match.group(2), match.group(3)
            a = self.note(frm, *span(0, len(frm)), baseline, height)
            b = self.note(to, *span(len(frm) + 1, len(spelled)), baseline, height)
            self.legato(letter, (a.cx + b.cx) / 2)
            return
        if match := _ARC_AFTER.match(spelled):
            frm = match.group(1)
            made = self.note(frm, *span(0, len(frm)), baseline, height)
            self.arcs.append((made.cx, made, None))
            return
        if match := _ARC_BEFORE.match(spelled):
            to = match.group(1)
            made = self.note(to, *span(1, len(spelled)), baseline, height)
            self.arcs.append((made.cx, None, made))
            return
        if match := _SLIDE_AFTER.match(spelled):
            digits = match.group(1)
            self.note(digits, *span(0, len(digits)), baseline, height)
            dash_from, dash_to = span(len(digits), len(spelled))
            self.slide((dash_from + dash_to) / 2)
            return
        if match := _SLIDE_BEFORE.match(spelled):
            dashes = match.group(1)
            self.note(match.group(2), *span(len(dashes), len(spelled)), baseline, height)
            dash_from, dash_to = span(0, len(dashes))
            self.slide((dash_from + dash_to) / 2)
            return
        if match := _BEND_AFTER.match(spelled):
            digits = match.group(1)
            made = self.note(digits, *span(0, len(digits)), baseline, height)
            self.bend(made.cx)
            return
        if match := _BEND_BEFORE.match(spelled):
            digits = match.group(1)
            made = self.note(digits, *span(1, len(spelled)), baseline, height)
            self.bend(made.cx)
            return
        if spelled == "b":
            # The arrow alone. It rises from the top of its digit, so it often
            # lands in the string bucket above and arrives as its own run; the
            # parser attaches a bend to the note at its x, whatever the string.
            self.bend(x0)
            return
        if _LONE_SLIDE.match(spelled):
            self.slide((x0 + x1) / 2)
            return
        if spelled == "~":
            self.arcs.append(((x0 + x1) / 2, None, None))
            return
        self.note(spelled, x0, x1, baseline, height)

    def add_flat(self, flat: glyphs.Component, label: str) -> None:
        # A bend arrow is known by its shape — taller than any digit, narrower
        # than one. Its label cannot be trusted to say so: the arrow's template
        # normalises into the same square as the digit 1 and clusters with it,
        # so the cluster's confirmed name is often "1". The name still matters —
        # it says a person looked — but which members are arrows is geometry.
        # Its left edge is what points back at the note the parser attaches to.
        if label == "b" or (
            flat.height >= self.spacing * glyphs.MIN_ARROW_HEIGHT
            and flat.width <= self.spacing * glyphs.MAX_ARROW_WIDTH
        ):
            self.bend(float(flat.x0))
            return
        # Either flat name confirms the cluster holds technique marks; each
        # mark's own curvature then says which technique, because arcs and
        # dashes flatten into near-identical templates and can share a cluster.
        if label == "~" or _LONE_SLIDE.match(label):
            if flat.bow >= ARC_MIN_BOW:
                self.arcs.append((float(flat.cx), None, None))
            else:
                self.slide(float(flat.cx))
        # Any other name on a flat mark says nothing a fret token could not, and
        # an unnamed one is decoration; both are simply not emitted.

    def _nearest(self, cx: float, direction: int, like: _Note | None) -> _Note | None:
        """The closest note on the given side, on the same string when known."""
        best: _Note | None = None
        for candidate in self.notes:
            offset = (candidate.cx - cx) * direction
            if not 0 < offset <= self.spacing * ARC_REACH:
                continue
            if like is not None and abs(candidate.baseline - like.baseline) > (
                self.spacing * SAME_STRING_TOL
            ):
                continue
            if best is None or offset < (best.cx - cx) * direction:
                best = candidate
        return best

    def resolve(self) -> list[primitives.Text]:
        """Decide each waiting arc and return every text item for this staff."""
        for cx, frm, to in self.arcs:
            if frm is None:
                frm = self._nearest(cx, -1, to)
            if to is None:
                to = self._nearest(cx, +1, frm)
            if frm is None or to is None or frm.fret is None or to.fret is None:
                continue  # not enough to say what the slur does; leave it silent
            if abs(frm.baseline - to.baseline) > self.spacing * SAME_STRING_TOL:
                continue  # joins nothing on one string, so it is not a slur
            if to.fret == frm.fret:
                continue
            self.legato("h" if to.fret > frm.fret else "p", (frm.cx + to.cx) / 2)
        return [note.item for note in self.notes] + self.marks


@dataclass(frozen=True)
class Emitted:
    """What a video came out as, and what of it could not be said."""

    pages: list[primitives.PagePrimitives]

    unspelled: int
    """Fret tokens no name could be found for. Reported to the app as unread."""

    silent: int
    """
    Slur arcs and slide dashes dropped because their shape has no name.

    Counted separately because they used to be lost in silence. An unnamed digit
    has always been reported unread, but an unnamed flat mark was simply skipped,
    so a tab could lose every hammer-on, pull-off and slide it had and still
    describe itself as fully read. On the reference clip that was all 46 arcs and
    27 of the 28 dashes, sitting together in one shape nobody had named — the
    whole piece came out with no articulation at all, and nothing said so.

    The asymmetry mattered more than the count: every safety property here rests
    on an unread mark being a visible gap rather than a quiet omission.
    """


def emit(readings: list[Reading], shapes: Shapes, labels: dict[str, str]) -> Emitted:
    """Build page primitives, reporting what could not be spelled or attached."""
    pages: list[primitives.PagePrimitives] = []
    unspelled = 0
    silent = 0
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
        for one in reading.staves:
            emitter = _StaffTexts(one, dx)
            for staff_of_run, run in reading.runs:
                if staff_of_run is not one:
                    continue
                if run.truncated:
                    # Part of this number was never captured, so any reading of
                    # it would be a wrong note rather than a gap.
                    unspelled += 1
                    continue
                spelled = glyphs.spell(run, shapes.assignment, shapes.index_of, labels)
                if spelled is None:
                    unspelled += 1
                    continue
                emitter.add_run(run, spelled, shapes, labels)
            for staff_of_flat, flat in reading.flat_marks:
                if staff_of_flat is not one:
                    continue
                label = labels.get(str(shapes.label_of(flat)))
                if label:
                    emitter.add_flat(flat, label)
                else:
                    silent += 1
            unspelled += emitter.unread
            texts.extend(emitter.resolve())
        pages.append(
            primitives.PagePrimitives(
                pageIndex=reading.page.index,
                width=declared_width,
                height=declared_height,
                segments=segments,
                texts=texts,
            )
        )
    return Emitted(pages=pages, unspelled=unspelled, silent=silent)
