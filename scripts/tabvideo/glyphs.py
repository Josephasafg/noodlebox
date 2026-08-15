"""
Read the characters printed on a tab staff.

Engraved video is a friendly case for recognition: one font, one size, no skew
and no paper noise. That makes template clustering a better fit than a general
OCR engine — every instance of a glyph in a given video is very nearly identical,
so grouping the shapes and naming each group once is both more accurate than
per-glyph classification and easy to check by eye.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .staff import Staff

# Glyph size limits, relative to staff spacing. Fret digits are a little shorter
# than one space; this admits them while rejecting specks and long slur arcs.
MIN_GLYPH_HEIGHT = 0.35
MAX_GLYPH_HEIGHT = 1.9
MIN_GLYPH_PIXELS = 6

# A printed digit is also a certain width, and saying so matters more than it
# looks. Templates are scaled onto a fixed square, so a one-pixel-wide sliver — a
# leftover stem, a piece of a slur, an over-eager fused split — normalises into
# something indistinguishable from a narrow digit, and then clusters with it. In
# the reference video that put 196 fragments, 12% of all marks, into the same
# shape as the digit 1, which read out as several hundred phantom notes on fret 1.
#
# Measured there: widths are bimodal, fragments at 1-2px and real digits from 4px
# up with a clear valley between, against a staff spacing of 19.3px.
MIN_GLYPH_WIDTH = 0.15

# Technique marks are wide and only a few pixels tall — the opposite of a digit.
# Slur arcs and slide dashes both fail MIN_GLYPH_HEIGHT by design, but dropping
# them entirely costs twice: their meaning (a hammer-on, a slide) is lost, and
# their ink is left unclaimed right beside a healthy number, where
# `flag_truncated` reads it as a dropped digit and silences the note it decorates.
# Measured on the reference clip: arcs and dashes are 12-26px wide and 1-4px tall
# against a 19.4px spacing, while true dropped-digit leftovers are digit-width.
MIN_MARK_WIDTH = 0.6
MIN_MARK_PIXELS = 10

# Unclaimed ink beside a token, in pixels, before the token counts as incomplete.
# A dropped units digit leaves ten or more pixels behind — that was the median area
# of the marks rejected as too short — while a stray antialiased pixel or two beside
# a digit is nothing. See `flag_truncated`.
TRUNCATION_MIN_PIXELS = 5

# How far above and below the outer lines a fret number may sit and still belong
# to the staff. Digits are centred on their line, so the outer strings hang half
# a space beyond it.
BAND_MARGIN = 0.8

# Two glyphs join into one number when the gap between them is under this
# fraction of the font's height. The digits of a two-digit fret sit close together
# while separate notes on one string are a note-spacing apart, so the two
# populations are far apart — measured over 439 same-line pairs in the reference
# video, gap/height was at most 0.67 within a number and at least 2.50 between
# notes, with almost nothing in between. This sits in that dead zone.
#
# It was 0.45 before, which joined only gaps under about four pixels and so left
# half of all two-digit frets split in two. That is worse than it sounds: a split
# "12" is not an unread mark but two confident wrong notes, fret 1 and fret 2.
JOIN_GAP_FRACTION = 1.5

# Clustering canvas. Small enough that antialiasing differences wash out, large
# enough to keep 6 apart from 8.
TEMPLATE_SIZE = 20

# Maximum mean per-pixel difference, on the 0..1 template, within one cluster.
# Measured on the reference video: two renderings of the same character land
# within 0.13 of each other (nearest-neighbour p90 = 0.133) while different
# characters start at 0.19, so this sits in the gap between the two populations.
# Resampling a ~7x10 glyph onto the template square is what spreads the former.
CLUSTER_RADIUS = 0.14

# A component wider than this multiple of the run's median width is two glyphs
# that touch, which happens where a two-note figure is tightly kerned. Single
# digits measured 7px wide at the 50th percentile and 9px at the 90th, with
# touching pairs from 11px up, so the cut sits just above the honest single.
FUSED_WIDTH_RATIO = 1.4


@dataclass(frozen=True)
class Component:
    """One connected mark, before it is known which character it is."""

    x0: int
    y0: int
    x1: int
    y1: int
    template: np.ndarray
    """Normalised bitmap, TEMPLATE_SIZE square, 0..1."""

    bow: float = 0.0
    """How far the mark's ink arches above the line joining its ends, in source
    pixels. Only computed for flat technique marks, where it is what separates a
    slur arc from a slide dash — normalising onto the template square flattens
    the curve too much to measure it there."""

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2


@dataclass
class Run:
    """Adjacent components that spell one printed token, such as `10` or `(7)`."""

    components: list[Component]

    truncated: bool = False
    """
    True when the printed token continues into ink that was never captured.

    A two-digit fret whose units digit was too small to be picked up would
    otherwise spell as a bare `1` and be emitted as a confident note on fret 1 —
    a wrong note rather than an admitted gap, which is the one outcome this
    pipeline is meant to avoid. Flagged runs are reported unread instead.
    """

    @property
    def x0(self) -> int:
        return min(c.x0 for c in self.components)

    @property
    def x1(self) -> int:
        return max(c.x1 for c in self.components)

    @property
    def baseline(self) -> float:
        """Bottom of the tallest component.

        The parser calibrates the baseline-to-line offset from the spread of the
        values it is given, so this only has to be consistent, not typographically
        exact.
        """
        return float(max(c.y1 for c in self.components))

    @property
    def height(self) -> int:
        return max(c.height for c in self.components)


def _normalise(mask: np.ndarray) -> np.ndarray:
    """Scale a glyph mask onto a fixed square, preserving aspect ratio."""
    height, width = mask.shape
    scale = TEMPLATE_SIZE / max(height, width)
    resized = cv2.resize(
        mask.astype(np.float32),
        (max(1, int(round(width * scale))), max(1, int(round(height * scale)))),
        interpolation=cv2.INTER_AREA,
    )
    out = np.zeros((TEMPLATE_SIZE, TEMPLATE_SIZE), dtype=np.float32)
    y = (TEMPLATE_SIZE - resized.shape[0]) // 2
    x = (TEMPLATE_SIZE - resized.shape[1]) // 2
    out[y : y + resized.shape[0], x : x + resized.shape[1]] = resized
    return out


def components_on_staff(ink_without_rules: np.ndarray, staff: Staff) -> list[Component]:
    """Extract the marks sitting on one tab staff, left to right."""
    spacing = staff.spacing
    top = int(round(staff.top - spacing * BAND_MARGIN))
    bottom = int(round(staff.bottom + spacing * BAND_MARGIN))
    top = max(0, top)
    bottom = min(ink_without_rules.shape[0], bottom)

    band = ink_without_rules[top:bottom].astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(band, connectivity=8)

    found: list[tuple[int, int, np.ndarray]] = []
    for label in range(1, count):
        x, y, width, height, area = stats[label]
        if area < MIN_GLYPH_PIXELS:
            continue
        if not (spacing * MIN_GLYPH_HEIGHT <= height <= spacing * MAX_GLYPH_HEIGHT):
            continue
        if not spacing * MIN_GLYPH_WIDTH <= width <= spacing * 3:
            continue
        found.append((int(x), int(y), labels[y : y + height, x : x + width] == label))
    if not found:
        return []

    typical_width = float(np.median([mask.shape[1] for _, _, mask in found]))
    out: list[Component] = []
    for x, y, mask in found:
        for offset, piece in _split_fused(mask, typical_width):
            # Checked again after splitting, because a cut through the wrong column
            # is itself a way to manufacture a sliver too thin to be a character.
            if piece.shape[1] < spacing * MIN_GLYPH_WIDTH:
                continue
            out.append(
                Component(
                    x0=x + offset,
                    y0=y + top,
                    x1=x + offset + piece.shape[1],
                    y1=y + top + piece.shape[0],
                    template=_normalise(piece),
                )
            )
    return sorted(out, key=lambda c: c.cx)


def marks_on_staff(ink_without_rules: np.ndarray, staff: Staff) -> list[Component]:
    """
    The flat technique marks on one staff: slur arcs and slide dashes.

    These are exactly what `components_on_staff` rejects — wide and shorter than
    any digit — so they are collected separately rather than by loosening the
    glyph filters, which were measured against fragments that cluster into
    phantom notes. A flat mark never joins a run: it decorates the notes beside
    it, and what it means is decided from its label and its neighbours in `emit`.
    """
    spacing = staff.spacing
    top = max(0, int(round(staff.top - spacing * BAND_MARGIN)))
    bottom = min(ink_without_rules.shape[0], int(round(staff.bottom + spacing * BAND_MARGIN)))

    band = ink_without_rules[top:bottom].astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(band, connectivity=8)

    out: list[Component] = []
    for label in range(1, count):
        x, y, width, height, area = stats[label]
        if area < MIN_MARK_PIXELS:
            continue
        if height >= spacing * MIN_GLYPH_HEIGHT:
            continue  # tall enough to be a glyph, and judged by those rules
        # The width ceiling matters: staff-line residue that survived rule
        # removal runs the width of the system, and this is what excludes it.
        if not spacing * MIN_MARK_WIDTH <= width <= spacing * 3:
            continue
        mask = labels[y : y + height, x : x + width] == label
        out.append(
            Component(
                x0=int(x),
                y0=int(y) + top,
                x1=int(x) + int(width),
                y1=int(y) + int(height) + top,
                template=_normalise(mask),
                bow=_bow(mask),
            )
        )
    return sorted(out, key=lambda c: c.cx)


def _bow(mask: np.ndarray) -> float:
    """
    How far a flat mark's ink arches above the line joining its ends.

    A slur arc bows up by a couple of pixels; a slide dash is straight. Measured
    here on the source pixels because the template square flattens the curve.
    """
    centres = [float(np.mean(np.nonzero(column)[0])) for column in mask.T if column.any()]
    if len(centres) < 4:
        return 0.0
    ends = np.linspace(centres[0], centres[-1], len(centres))
    return float(np.max(ends - np.array(centres)))


def _split_fused(mask: np.ndarray, typical_width: float) -> list[tuple[int, np.ndarray]]:
    """
    Cut a component that is really two touching glyphs, at the thinnest column.

    Tightly kerned figures occasionally join at one pixel. The join is far
    thinner than either stroke, so the minimum of the vertical ink profile finds
    it; anything of normal width is returned untouched.
    """
    width = mask.shape[1]
    if width <= typical_width * FUSED_WIDTH_RATIO:
        return [(0, mask)]
    profile = mask.sum(axis=0)
    margin = max(2, int(typical_width * 0.4))
    if width - 2 * margin < 1:
        return [(0, mask)]
    cut = margin + int(np.argmin(profile[margin : width - margin]))
    left, right = mask[:, :cut], mask[:, cut:]
    if left.sum() < MIN_GLYPH_PIXELS or right.sum() < MIN_GLYPH_PIXELS:
        return [(0, mask)]
    return [(0, left), (cut, right)]


def group_runs(components: list[Component], staff: Staff) -> list[Run]:
    """
    Join neighbouring components into printed tokens.

    Only components on the same string can belong to the same number, so each
    string is walked separately. Doing it in one pass over everything, testing
    only neighbouring pairs, silently loses numbers: notes on six strings
    interleave in x — measured overlapping by a few pixels — so any note that
    falls between the `1` and the `0` of a `10` ends the run and leaves two
    confident wrong notes behind. In the reference video that split 125 of 297
    two-digit frets.
    """
    if not components:
        return []
    font_height = float(np.median([c.height for c in components]))
    max_gap = font_height * JOIN_GAP_FRACTION

    def string_of(glyph: Component) -> int:
        """Which of the six lines this mark is printed on."""
        return int(round((glyph.cy - staff.top) / staff.spacing))

    per_string: dict[int, list[Component]] = {}
    for glyph in components:
        per_string.setdefault(string_of(glyph), []).append(glyph)

    runs: list[Run] = []
    for _, on_string in sorted(per_string.items()):
        ordered = sorted(on_string, key=lambda c: c.cx)
        current: list[Component] = [ordered[0]]
        for previous, glyph in zip(ordered, ordered[1:]):
            if glyph.x0 - previous.x1 <= max_gap:
                current.append(glyph)
            else:
                runs.append(Run(current))
                current = [glyph]
        runs.append(Run(current))
    # Reading order, so the parser sees the systems left to right as printed.
    return sorted(runs, key=lambda run: run.x0)


def flag_truncated(
    ink_without_rules: np.ndarray,
    staff: Staff,
    runs: list[Run],
    components: list[Component],
    claimed_marks: tuple[Component, ...] | list[Component] = (),
) -> None:
    """
    Mark runs whose printed token runs on into a mark that was dropped.

    Marks too small to be a glyph are discarded, which is right for a speck and
    wrong for the small units digit of a two-digit fret: discarding that leaves the
    tens digit alone, spelling a bare `1` that reads as a confident note on fret 1.
    In the reference video fret 1 came out as a fifth of every note read, which no
    guitar part does.

    The test needs no labels, only shapes. It looks specifically for leftover ink
    the size of a dropped digit — too short to have been accepted, but far more than
    a speck. That precision matters: counting *any* unclaimed ink would catch the
    barline that follows the last note of a measure and silence a note that was
    read perfectly well.
    """
    if not components:
        return
    claimed = np.zeros(ink_without_rules.shape, dtype=bool)
    # Technique marks count as claimed too: a slur arc or slide dash beside a
    # run's last digit is decoration, not the remains of a dropped digit, and
    # without this every note a mark decorates would be silenced as truncated.
    for glyph in [*components, *claimed_marks]:
        claimed[glyph.y0 : glyph.y1, glyph.x0 : glyph.x1] = True
    leftover = (ink_without_rules.astype(bool) & ~claimed).astype(np.uint8)

    # Keep only the leftovers that could be a digit the size filters dropped.
    count, labelled, stats, _ = cv2.connectedComponentsWithStats(leftover, connectivity=8)
    dropped = np.zeros(leftover.shape, dtype=bool)
    for label in range(1, count):
        _, _, width, height, area = stats[label]
        if area < TRUNCATION_MIN_PIXELS:
            continue
        if height > staff.spacing * MIN_GLYPH_HEIGHT:
            continue  # tall enough to have been kept, so it is not a dropped digit
        if width < staff.spacing * MIN_GLYPH_WIDTH:
            continue  # a sliver, not a character
        dropped |= labelled == label

    font_height = float(np.median([c.height for c in components]))
    reach = max(1, int(round(font_height * JOIN_GAP_FRACTION)))
    for run in runs:
        last = max(run.components, key=lambda c: c.x1)
        window = dropped[last.y0 : last.y1, last.x1 : last.x1 + reach]
        if int(window.sum()) >= TRUNCATION_MIN_PIXELS:
            run.truncated = True


def cluster(components: list[Component], radius: float = CLUSTER_RADIUS) -> tuple[list[int], list[np.ndarray]]:
    """
    Group identical shapes.

    Greedy nearest-centroid assignment is enough because the shapes come from one
    rendering of one font: within-glyph variation is video compression only, so
    clusters are far tighter than the gap between different characters.

    Returns the cluster index per component and the mean template of each cluster.
    """
    centroids: list[np.ndarray] = []
    counts: list[int] = []
    assignment: list[int] = []
    for glyph in components:
        best, best_distance = -1, float("inf")
        for index, centroid in enumerate(centroids):
            distance = float(np.abs(centroid - glyph.template).mean())
            if distance < best_distance:
                best, best_distance = index, distance
        if best >= 0 and best_distance <= radius:
            # Running mean, so a cluster's template is not set by its first member.
            counts[best] += 1
            centroids[best] += (glyph.template - centroids[best]) / counts[best]
            assignment.append(best)
        else:
            centroids.append(glyph.template.copy())
            counts.append(1)
            assignment.append(len(centroids) - 1)
    return assignment, centroids


def contact_sheet(centroids: list[np.ndarray], columns: int = 12, scale: int = 3) -> np.ndarray:
    """
    Render cluster templates as a labelled grid for a human to name.

    This is the one manual step in the pipeline, and it happens once per video:
    a few dozen shapes to read off, after which every instance is known.
    """
    cell = TEMPLATE_SIZE * scale
    pad = 14
    rows = (len(centroids) + columns - 1) // columns
    sheet = np.full((rows * (cell + pad), columns * cell), 255, dtype=np.uint8)
    for index, centroid in enumerate(centroids):
        row, column = divmod(index, columns)
        tile = cv2.resize((1.0 - centroid) * 255, (cell, cell), interpolation=cv2.INTER_NEAREST)
        y = row * (cell + pad) + pad
        x = column * cell
        sheet[y : y + cell, x : x + cell] = tile.astype(np.uint8)
        cv2.putText(sheet, str(index), (x + 2, y - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.35, 0, 1, cv2.LINE_AA)
    return sheet


def spell(run: Run, assignment: list[int], index_of: dict[int, int], labels: dict[str, str]) -> str | None:
    """
    Turn a run into its printed text using the cluster labels.

    A run containing any unlabelled cluster returns None: a half-read number is
    worse than an admitted gap, because the parser counts what it could not read
    and reports it as a confidence signal.
    """
    out: list[str] = []
    for glyph in run.components:
        cluster_index = assignment[index_of[id(glyph)]]
        label = labels.get(str(cluster_index))
        if label is None or label == "":
            return None
        out.append(label)
    return "".join(out)
