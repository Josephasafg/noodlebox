"""
Find the ruled lines of an engraved system.

The parser in `src/tabpdf` already knows how to tell a six-line tab staff from
the five-line notation staff above it, and how to turn barlines into a measure
grid. All that is needed from an image is the same geometry a PDF would have
given: where the long horizontal rules are, and where the verticals cross them.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# Both thresholds are measured down from the paper, not across the page's
# dynamic range. What is on the page besides the engraving varies — a logo, a
# title card, the black of the camera footage — and none of it says anything
# about how dark the notation is.
PAPER_PERCENTILE = 95

# Engravers draw staff lines far lighter than the notes on them — measured at
# grey 221-233 against paper 253 in the reference video. So rules get a much
# more permissive threshold: anything detectably below the paper. Measured safe
# window is 5%-8% of the paper level; outside it the lines either dissolve or
# the paper's own noise starts to register.
RULE_DELTA_FRACTION = 0.07

# Ink is what a note is drawn with. A fret number is engraved at around ten
# pixels and antialiased, so most of its body sits in the midtones: on the
# reference video a digit's core reads near 100 but the pixels holding it
# together run to 200.
#
# This was measured against the page's dynamic range before, which is what made
# the reader miss notes. `page.min()` is pinned to 0 by whatever else shares the
# panel, so the threshold sat at a fixed 140 — below the body of every digit,
# keeping only its darkest specks. A `0` on the low E came back as two 1px walls
# and two 1px arcs, none of them glyph-shaped, and the note simply vanished.
# Across the reference video that dropped 40% of all marks and turned 43 real
# shapes into 126 clusters, most of them debris.
#
# The window is wide: every threshold from 160 to 200 reads the reference video
# identically. It is bounded below by the digit's own body and above by the
# staff lines, which must stay out of this mask or the numbers on a line come
# back strung together through it. This sits in the middle.
INK_DELTA_FRACTION = 0.27

# A staff line runs the width of its system. Shorter rules — ties, slide marks,
# the beams under the notation staff — must not be mistaken for one.
MIN_RULE_WIDTH_FRACTION = 0.35

# How unequal the gaps in one staff may be, in pixels.
#
# A staff is engraved on an exact grid, so the only thing that moves its gaps is
# where each rule's rows quantise — about half a pixel either side, whatever the
# staff's width. Measured over the reference video, the 29 real tab staves had a
# gap range of at most 1.0px while every false candidate was 1.5px or worse, so
# an absolute limit separates them with room to spare.
#
# It is absolute rather than proportional on purpose: quantisation does not
# shrink with the staff, so a relative test tight enough to reject a false
# candidate here would reject a real staff in a lower-resolution video. The
# proportional term only takes over for unusually large engravings.
MAX_GAP_RANGE_PX = 1.2
GAP_RANGE_FRACTION = 0.06

# A barline crosses nearly every row between the outer lines of its staff.
# Stems and note flags cross far fewer, which is what separates them.
MIN_BARLINE_COVERAGE = 0.85

# Bands whose centres are closer than this are one printed line reported twice,
# which happens when a middle row of a rule dips under the coverage threshold and
# splits it. No engraving spaces two real lines this closely — the tightest staff
# measured here is 13px — so merging them cannot join distinct lines.
#
# It matters beyond tidiness: the parser walks rules in order, so a duplicate in
# the middle of a staff ends the run early and the staff is missed entirely.
MERGE_RULES_WITHIN_PX = 2.5

TAB_STAFF_LINES = 6


@dataclass(frozen=True)
class Rule:
    """One long horizontal line, in page pixels."""

    y: float
    x0: float
    x1: float
    thickness: int


@dataclass(frozen=True)
class Staff:
    """A run of evenly spaced rules: six lines for tab, five for notation."""

    lines: list[float]
    x0: float
    x1: float
    rules: tuple[Rule, ...] = ()
    """The rules this staff was built from, kept so they can be emitted together."""

    @property
    def top(self) -> float:
        return self.lines[0]

    @property
    def bottom(self) -> float:
        return self.lines[-1]

    @property
    def spacing(self) -> float:
        return (self.bottom - self.top) / (len(self.lines) - 1)


@dataclass(frozen=True)
class Barline:
    x: float
    y0: float
    y1: float


def to_ink(page: np.ndarray) -> np.ndarray:
    """
    The dark marks only: note heads, fret numbers, stems.

    This is what glyph recognition runs on. It deliberately excludes the pale
    staff lines, which keeps the numbers on a string from being strung together
    into one component by the line they sit on.
    """
    white = float(np.percentile(page, PAPER_PERCENTILE))
    return page < white - white * INK_DELTA_FRACTION


def marks(page: np.ndarray) -> np.ndarray:
    """
    Everything that is not paper, however faintly drawn.

    A superset of `to_ink`, used for the ruled geometry — staff lines and
    barlines — because an engraver may draw those in a light grey that a
    threshold tuned for note heads would throw away entirely.
    """
    white = float(np.percentile(page, PAPER_PERCENTILE))
    return page < white - white * RULE_DELTA_FRACTION


def find_rules(ink: np.ndarray) -> list[Rule]:
    """
    Collect the long horizontal rules, one entry per line.

    Rows are grouped rather than reported individually because a rule is two or
    three pixels tall once the video has been scaled and re-encoded, and the
    spacing test downstream needs one y per line.
    """
    height, width = ink.shape
    min_run = width * MIN_RULE_WIDTH_FRACTION
    # Fret numbers sit in a gap punched through the line, so a rule's row is not
    # continuous. Count coverage instead of requiring an unbroken run.
    coverage = ink.sum(axis=1)
    candidate = coverage >= min_run

    rules: list[Rule] = []
    row = 0
    while row < height:
        if not candidate[row]:
            row += 1
            continue
        start = row
        while row < height and candidate[row]:
            row += 1
        band = ink[start:row]
        columns = np.flatnonzero(band.any(axis=0))
        if columns.size == 0:
            continue
        rules.append(
            Rule(
                y=float(start + (row - start - 1) / 2),
                # Trim the extremes so a stray mark on the line's row cannot
                # stretch its reported extent.
                x0=float(np.percentile(columns, 0.5)),
                x1=float(np.percentile(columns, 99.5)),
                thickness=row - start,
            )
        )
    return _merge_split_rules(rules)


def _merge_split_rules(rules: list[Rule]) -> list[Rule]:
    """Collapse bands that are two readings of the same printed line."""
    merged: list[Rule] = []
    for rule in rules:
        previous = merged[-1] if merged else None
        if previous is not None and rule.y - previous.y <= MERGE_RULES_WITHIN_PX:
            merged[-1] = Rule(
                y=(previous.y + rule.y) / 2,
                x0=min(previous.x0, rule.x0),
                x1=max(previous.x1, rule.x1),
                thickness=previous.thickness + rule.thickness,
            )
            continue
        merged.append(rule)
    return merged


def _runs_of_equal_spacing(rules: list[Rule], count: int) -> list[list[Rule]]:
    """Every maximal group of `count` rules that are evenly spaced and aligned."""
    out: list[list[Rule]] = []
    for start in range(len(rules) - count + 1):
        group = rules[start : start + count]
        gaps = np.diff([r.y for r in group])
        if gaps.min() <= 0:
            continue
        # The five lines of a notation staff plus one stray rule nearby — an
        # ottava line, a bracket, a neighbouring staff's edge — will otherwise
        # pass as a six-line tab staff, because those gaps are almost regular.
        # Almost is the distinction: a real staff's are regular to the pixel.
        allowed = max(MAX_GAP_RANGE_PX, gaps.mean() * GAP_RANGE_FRACTION)
        if gaps.max() - gaps.min() > allowed:
            continue
        # Lines of one staff share a horizontal extent; a neighbouring staff's
        # line landing a staff-space away would not.
        spread = max(abs(group[0].x0 - r.x0) for r in group)
        if spread > gaps.mean() * 2:
            continue
        out.append(group)
    return out


def find_staves(rules: list[Rule], count: int = TAB_STAFF_LINES) -> list[Staff]:
    """
    Locate the staves with `count` lines, keeping non-overlapping ones.

    Candidate groups overlap by construction — six consecutive rules contain two
    runs of five — so the widest-spaced candidate wins its rows and the rest are
    discarded.
    """
    candidates = _runs_of_equal_spacing(rules, count)
    chosen: list[Staff] = []
    used: list[tuple[float, float]] = []
    for group in sorted(candidates, key=lambda g: g[-1].y - g[0].y, reverse=True):
        top, bottom = group[0].y, group[-1].y
        if any(not (bottom < lo or top > hi) for lo, hi in used):
            continue
        used.append((top, bottom))
        chosen.append(
            Staff(
                lines=[r.y for r in group],
                x0=min(r.x0 for r in group),
                x1=max(r.x1 for r in group),
                rules=tuple(group),
            )
        )
    return sorted(chosen, key=lambda s: s.top)


def find_barlines(ink: np.ndarray, staff: Staff) -> list[Barline]:
    """
    Find the verticals that cross a staff from its top line to its bottom.

    Restricting the search to the staff's own rows is what keeps note stems and
    the beams of the notation staff out of the result.
    """
    top, bottom = int(round(staff.top)), int(round(staff.bottom))
    band = ink[top : bottom + 1]
    if band.size == 0:
        return []
    coverage = band.sum(axis=0) / band.shape[0]
    hit = coverage >= MIN_BARLINE_COVERAGE

    out: list[Barline] = []
    column = 0
    while column < hit.size:
        if not hit[column]:
            column += 1
            continue
        start = column
        while column < hit.size and hit[column]:
            column += 1
        out.append(Barline(x=float(start + (column - start - 1) / 2), y0=staff.top, y1=staff.bottom))
    return out


def remove_rules(ink: np.ndarray, rules: list[Rule]) -> np.ndarray:
    """
    Erase the staff lines, keeping everything drawn across them.

    Without this every fret number on a string would be joined to its
    neighbours through the line and come back as one connected component. A line
    pixel is only cleared when the ink through it is no thicker than the rule
    itself, so digits, stems and barlines survive the cut.
    """
    out = ink.copy()
    height, width = ink.shape
    for rule in rules:
        centre = int(round(rule.y))
        limit = rule.thickness + 2
        # Only cut where the line is actually part of this mask. When an engraver
        # draws staff lines lighter than the notes they never reach the glyph
        # mask at all, and cutting anyway would gouge the digits sitting on them.
        rows = ink[max(0, centre - rule.thickness) : min(height, centre + rule.thickness + 1)]
        if rows.size == 0 or rows.any(axis=0).sum() < (rule.x1 - rule.x0) * 0.3:
            continue
        lo = max(0, centre - limit)
        hi = min(height, centre + limit + 1)
        window = ink[lo:hi]
        # Vertical ink run length through each column of the window.
        run = window.sum(axis=0)
        clear = run <= limit
        for row in range(max(0, centre - rule.thickness), min(height, centre + rule.thickness + 1)):
            out[row, clear] = False
    return out
