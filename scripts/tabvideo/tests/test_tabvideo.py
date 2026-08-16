"""
Tests for the video tab reader.

Everything here works on synthetically engraved systems rather than a real video,
which keeps the suite deterministic and free of committed copyrighted material.
The renderer imitates the properties of real engraving that the pipeline actually
depends on: staff lines drawn much lighter than the notes, and fret numbers
centred on their line. It draws those numbers solid for legibility, which is not
how a video prints them — see `print_hairline_zero` for the faithful version, and
the bug that only it catches.

    python3 -m pytest scripts/tabvideo/tests
"""

from __future__ import annotations

import cv2
import numpy as np

from scripts.tabvideo import bank as bank_mod
from scripts.tabvideo import cli, fetch, frames, glyphs, pipeline, primitives
from scripts.tabvideo import staff as staff_mod


PAPER = 253
RULE_GREY = 225
INK = 20

# What a fret number is really printed in: grey, not the near-black `INK` most of
# this suite draws with. See `print_hairline_zero`.
GLYPH_GREY = 95

TAB_TOP = 150
SPACING = 20
NOTATION_TOP = 40
NOTATION_SPACING = 15


def render_system(
    notes: list[tuple[int, int, str]],
    width: int = 800,
    height: int = 300,
    rule_grey: int = RULE_GREY,
    barlines: tuple[int, ...] = (20, 400, 780),
    clutter: tuple[tuple[float, float, float], ...] = (),
) -> np.ndarray:
    """
    Draw a system: a five-line notation staff, a six-line tab staff, and notes.

    `notes` are `(string_index, x, text)` with string 0 the top line, matching how
    the numbers are printed rather than how they are tuned.
    """
    page = np.full((height, width), PAPER, dtype=np.uint8)
    for i in range(5):
        page[NOTATION_TOP + i * NOTATION_SPACING, 20:780] = rule_grey
    for i in range(6):
        page[TAB_TOP + i * SPACING, 20:780] = rule_grey
    for y, x0, x1 in clutter:
        page[int(y), int(x0) : int(x1)] = rule_grey
    for x in barlines:
        page[TAB_TOP : TAB_TOP + 5 * SPACING + 1, x] = INK

    for string_index, x, text in notes:
        line_y = TAB_TOP + string_index * SPACING
        (text_width, text_height), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        # The line is interrupted behind the number, as an engraver would. This
        # has to happen before the glyph is drawn, or it cuts the glyph in half.
        page[line_y, max(0, x - 2) : x + text_width + 2] = PAPER
        # Fret numbers are centred on their line, so the baseline sits below it.
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


def test_find_panel_locates_the_engraved_band() -> None:
    frame = np.zeros((200, 120, 3), dtype=np.uint8)
    frame[:100] = (20, 200, 180)  # saturated camera footage
    frame[100:] = (250, 250, 250)  # paper
    panel = frames.find_panel(frame)
    assert 95 <= panel.top <= 105
    assert panel.bottom >= 199


def test_pale_rules_reach_the_marks_mask_but_not_the_ink_mask() -> None:
    page = render_system([(0, 100, "7")])
    marks = staff_mod.marks(page)
    ink = staff_mod.to_ink(page)
    row = TAB_TOP + 2 * SPACING
    assert marks[row, 300], "a pale staff line must register as a mark"
    assert not ink[row, 300], "a pale staff line must not register as note ink"


def print_hairline_zero(page: np.ndarray, string_index: int, x: int) -> None:
    """
    Print an open-string `0` the way the reference video really prints one.

    The rest of this suite draws its notes solid and near-black, which is what
    let a real bug through. A fret number in a 1080p video is about ten pixels
    tall and its stroke is *thinner than one pixel*, so almost none of the digit
    is the ink's own grey: it is the midtones between that and the paper, and
    they vary around the ring. Only where the stroke runs along the pixel grid
    does it darken to near its printed value.

    Drawn oversized with a sub-pixel stroke and scaled down, which is how the
    video makes it.
    """
    supersample = 4
    radius_x, radius_y = 4, 6
    pad = 6
    size = ((radius_y + pad) * 2 * supersample, (radius_x + pad) * 2 * supersample)
    patch = np.full(size, PAPER, dtype=np.uint8)
    cv2.ellipse(
        patch,
        ((pad + radius_x) * supersample, (pad + radius_y) * supersample),
        (radius_x * supersample, radius_y * supersample),
        0,
        0,
        360,
        GLYPH_GREY,
        max(1, int(supersample * 0.55)),
        cv2.LINE_AA,
    )
    small = cv2.resize(
        patch,
        (patch.shape[1] // supersample, patch.shape[0] // supersample),
        interpolation=cv2.INTER_AREA,
    )
    line_y = TAB_TOP + string_index * SPACING
    top = line_y - small.shape[0] // 2
    page[line_y, x - 2 : x + small.shape[1] + 2] = PAPER  # the line breaks behind the number
    window = page[top : top + small.shape[0], x : x + small.shape[1]]
    np.minimum(window, small, out=window)


def test_a_hairline_digit_is_mostly_midtones() -> None:
    """Say what the fixture above imitates, so it cannot quietly drift solid."""
    page = render_system([])
    print_hairline_zero(page, 5, 300)
    printed = page[TAB_TOP + 5 * SPACING - 9 : TAB_TOP + 5 * SPACING + 9, 298:314]
    body = printed[printed < PAPER - 15]

    assert body.min() < 140, "part of the stroke darkens to near its printed grey"
    assert np.median(body) > 150, "but most of the digit is lighter than that"


def test_a_hairline_digit_is_read_whole_beside_darker_ink_elsewhere() -> None:
    """
    A grey digit has to come back as one mark, whatever else is on the panel.

    This is the bug that made the reader miss notes. The ink threshold was a
    fraction of the page's *dynamic range*, so anything truly black elsewhere on
    the panel — a logo, a title card, the camera — dragged it down onto the
    engraving itself and kept only each digit's darkest specks. A `0` on the low
    E came back as two one-pixel walls and two one-pixel arcs, none of them
    glyph-shaped, so the note was not read at all.
    """
    page = render_system([])
    print_hairline_zero(page, 5, 300)
    page[0:12, 0:80] = 0  # something black elsewhere on the panel

    rules = staff_mod.find_rules(staff_mod.marks(page))
    tab = staff_mod.find_staves(rules, 6)[0]
    found = glyphs.components_on_staff(staff_mod.remove_rules(staff_mod.to_ink(page), rules), tab)

    assert len(found) == 1, "a printed digit is one mark, not a handful of fragments"
    assert found[0].height >= SPACING * 0.45, "and it keeps the height it was printed at"
    assert found[0].width >= SPACING * 0.3
    assert abs(found[0].cy - (TAB_TOP + 5 * SPACING)) < SPACING * 0.5


def test_finds_the_tab_staff_with_its_spacing() -> None:
    page = render_system([(0, 100, "7"), (3, 200, "5")])
    rules = staff_mod.find_rules(staff_mod.marks(page))
    # Five notation lines plus six tab lines.
    assert len(rules) == 11

    staves = staff_mod.find_staves(rules, 6)
    assert len(staves) == 1
    assert abs(staves[0].spacing - SPACING) < 0.6
    assert abs(staves[0].top - TAB_TOP) < 1.5


def _rule(y: float, x0: float = 20.0, x1: float = 780.0) -> staff_mod.Rule:
    return staff_mod.Rule(y=y, x0=x0, x1=x1, thickness=2)


def test_a_notation_staff_plus_a_stray_rule_is_not_a_tab_staff() -> None:
    """
    The five lines of a notation staff and one stray rule below them are six
    almost-evenly-spaced lines, and used to be read as a tab staff — which put a
    phantom staff on a third of the systems in the reference video and fed note
    heads into recognition. These y values are measured from one of those frames.
    """
    rules = [_rule(y) for y in (187.5, 203.5, 219.5, 233.5, 247.5, 265.5)]
    assert staff_mod.find_staves(rules, 6) == []


def test_a_real_tab_staff_is_still_found() -> None:
    # Also measured from the reference video: regular to within a pixel.
    rules = [_rule(y) for y in (365.5, 385.0, 404.0, 423.5, 442.5, 462.0)]
    found = staff_mod.find_staves(rules, 6)
    assert len(found) == 1
    assert abs(found[0].spacing - 19.3) < 0.2


def test_merges_a_line_reported_as_two_bands() -> None:
    # One printed line whose middle row fell under the coverage threshold.
    merged = staff_mod._merge_split_rules([_rule(442.5), _rule(443.5), _rule(462.0)])
    assert [round(r.y, 1) for r in merged] == [443.0, 462.0]


def test_keeps_lines_that_are_merely_close() -> None:
    # A tight engraving is not a split line; 13px is the narrowest seen.
    merged = staff_mod._merge_split_rules([_rule(100.0), _rule(113.0)])
    assert len(merged) == 2


def test_finds_the_barlines_crossing_the_tab_staff() -> None:
    page = render_system([(2, 150, "9")], barlines=(20, 400, 780))
    marks = staff_mod.marks(page)
    tab = staff_mod.find_staves(staff_mod.find_rules(marks), 6)[0]
    found = sorted(round(bar.x) for bar in staff_mod.find_barlines(marks, tab))
    assert found == [20, 400, 780]


def test_removing_rules_leaves_a_pale_engraving_untouched() -> None:
    page = render_system([(1, 120, "7"), (4, 300, "12")])
    ink = staff_mod.to_ink(page)
    rules = staff_mod.find_rules(staff_mod.marks(page))
    # The rules are not in the ink mask, so nothing may be cut from it.
    assert staff_mod.remove_rules(ink, rules).sum() == ink.sum()


def test_removing_rules_cuts_dark_lines_and_keeps_the_digits() -> None:
    page = render_system([(1, 120, "7"), (4, 300, "9")], rule_grey=INK)
    ink = staff_mod.to_ink(page)
    rules = staff_mod.find_rules(staff_mod.marks(page))
    cut = staff_mod.remove_rules(ink, rules)
    assert cut.sum() < ink.sum(), "dark staff lines should be removed"

    tab = staff_mod.find_staves(rules, 6)[0]
    # With the lines gone the two numbers are separate marks again, rather than
    # one component threaded along the string they sit on.
    found = glyphs.components_on_staff(cut, tab)
    assert len(found) >= 2


def test_reads_one_component_for_each_printed_digit() -> None:
    printed = [(0, 100, "7"), (2, 220, "5"), (5, 340, "9")]
    page = render_system(printed)
    marks = staff_mod.marks(page)
    tab = staff_mod.find_staves(staff_mod.find_rules(marks), 6)[0]
    found = glyphs.components_on_staff(staff_mod.to_ink(page), tab)
    assert len(found) == len(printed)

    # Each lands on the line it was printed on.
    for component, (string_index, _, _) in zip(found, printed):
        expected = TAB_TOP + string_index * SPACING
        assert abs(component.cy - expected) < SPACING * 0.5


def test_groups_a_two_digit_number_but_not_two_separate_notes() -> None:
    page = render_system([(1, 100, "12"), (1, 300, "5")])
    marks = staff_mod.marks(page)
    tab = staff_mod.find_staves(staff_mod.find_rules(marks), 6)[0]
    found = glyphs.components_on_staff(staff_mod.to_ink(page), tab)
    runs = glyphs.group_runs(found, tab)

    assert len(runs) == 2
    assert len(runs[0].components) == 2, "the digits of 12 belong to one number"
    assert len(runs[1].components) == 1


def test_notes_on_different_strings_never_join() -> None:
    # Same x, adjacent strings: close on the page, but two notes.
    page = render_system([(1, 200, "7"), (2, 204, "9")])
    marks = staff_mod.marks(page)
    tab = staff_mod.find_staves(staff_mod.find_rules(marks), 6)[0]
    runs = glyphs.group_runs(glyphs.components_on_staff(staff_mod.to_ink(page), tab), tab)
    assert all(len(run.components) == 1 for run in runs)


def test_splits_a_component_that_is_two_touching_glyphs() -> None:
    mask = np.zeros((10, 14), dtype=bool)
    mask[:, 0:6] = True
    mask[:, 8:14] = True
    mask[5, 6:8] = True  # a one-pixel-tall bridge
    pieces = glyphs._split_fused(mask, typical_width=7.0)
    assert len(pieces) == 2
    assert pieces[0][0] == 0 and pieces[1][0] > 0


def test_leaves_a_normal_width_glyph_whole() -> None:
    mask = np.ones((10, 7), dtype=bool)
    assert len(glyphs._split_fused(mask, typical_width=7.0)) == 1


def test_clusters_identical_shapes_and_separates_different_ones() -> None:
    page = render_system([(0, 100, "7"), (2, 220, "7"), (4, 340, "5")])
    marks = staff_mod.marks(page)
    tab = staff_mod.find_staves(staff_mod.find_rules(marks), 6)[0]
    found = glyphs.components_on_staff(staff_mod.to_ink(page), tab)
    assignment, centroids = glyphs.cluster(found)

    assert len(centroids) == 2, "two sevens and a five are two shapes"
    assert assignment[0] == assignment[1]
    assert assignment[2] != assignment[0]


def test_members_of_a_shape_come_from_different_systems_first() -> None:
    """
    Agreement between exemplars only means something if they are different marks.

    Three crops of one printing is one observation shown three times; one from
    each of three systems is three, which is what makes a disagreement between
    them evidence rather than noise.
    """
    readings = [
        cli.Reading(
            frames.Page(
                index=index,
                start_s=0.0,
                end_s=1.0,
                image=render_system([(0, 100, "7"), (2, 220, "7")]),
            )
        )
        for index in range(3)
    ]
    shapes = pipeline.find_shapes(readings)
    sevens = max(range(len(shapes)), key=lambda index: shapes.counts[index])

    members = pipeline.shape_members(readings, shapes, sevens, limit=3)
    owners = {id(pipeline._owners(readings)[id(member)]) for member in members}

    assert len(members) == 3
    assert len(owners) == 3, "one from each system before a second from any"


def test_members_fall_back_to_one_system_when_that_is_all_there_is() -> None:
    readings = [
        cli.Reading(
            frames.Page(
                index=0,
                start_s=0.0,
                end_s=1.0,
                image=render_system([(0, 100, "7"), (2, 220, "7")]),
            )
        )
    ]
    shapes = pipeline.find_shapes(readings)
    sevens = max(range(len(shapes)), key=lambda index: shapes.counts[index])

    members = pipeline.shape_members(readings, shapes, sevens, limit=3)

    assert len(members) == 2, "two printings exist, so two are returned rather than a repeat"
    assert members[0] is not members[1]


def test_a_context_render_shows_the_whole_number_and_marks_one_glyph() -> None:
    """
    The context render is what makes a ten-pixel digit legible: the glyph beside
    it fixes the size and the lines under it fix the baseline. It must therefore
    contain the whole printed number, the staff, and an outline around the one
    mark being asked about.
    """
    page = render_system([(1, 120, "12")])
    reading = cli.Reading(frames.Page(index=0, start_s=0.0, end_s=1.0, image=page))
    shapes = pipeline.find_shapes([reading])
    run = next(run for _, run in reading.runs if len(run.components) == 2)
    scale = 6

    context = pipeline.shape_context([reading], run.components[0], scale=scale)

    assert context is not None
    # Both digits of the number, and the staff band, are inside the crop.
    assert context.shape[1] >= (run.x1 - run.x0) * scale
    staff = reading.staves[0]
    band = (staff.bottom - staff.top) + 2 * staff.spacing * glyphs.BAND_MARGIN
    assert context.shape[0] >= band * scale * 0.9
    # Outlined in a colour, because the question is which of the two digits is
    # being asked about — and a grey box got answered about the whole number.
    assert context.ndim == 3 and context.shape[2] == 3
    assert (context == np.array(pipeline.CONTEXT_OUTLINE, np.uint8)).all(axis=2).any(), (
        "the mark in question is outlined"
    )
    # And the outline is the only colour on the page, so nothing else competes.
    coloured = context[context[:, :, 0] != context[:, :, 2]]
    assert len(coloured) > 0
    assert (coloured == np.array(pipeline.CONTEXT_OUTLINE, np.uint8)).all()
    assert shapes.label_of(run.components[0]) != shapes.label_of(run.components[1])


def test_a_context_render_leaves_out_the_note_on_the_next_string() -> None:
    """
    Six strings share a staff, so a note one string away sits directly above the
    mark being asked about. Rendering the whole staff band put it in frame and it
    was read as part of the same number: a `4` with a `2` above it came back as
    "a 4 sitting below a 2", and the shape — 123 marks, 5% of the reference clip
    — went unnamed. Worse, once the prompt acknowledged fused digits at all, the
    pair was confidently named `24`.

    A number fills about three quarters of the string spacing, so the clear air
    between two strings' notes is narrow but real, and the crop has to stay
    inside it.
    """
    page = render_system([(1, 120, "2"), (2, 120, "4")])
    reading = cli.Reading(frames.Page(index=0, start_s=0.0, end_s=1.0, image=page))
    upper, lower = sorted(
        (run for _, run in reading.runs), key=lambda run: min(m.y0 for m in run.components)
    )
    scale = 6

    context = pipeline.shape_context([reading], lower.components[0], scale=scale)

    assert context is not None
    # Read the red channel: the page is grey so every channel carries it, while
    # the outline is pure red and reads as paper here instead of as a dark mark.
    # Staff lines print at 225 and digits far darker.
    ink = context[:, :, 2]
    staff = reading.staves[0]
    crop_top = staff.top - staff.spacing * glyphs.BAND_MARGIN
    where = upper.components[0]
    rows = slice(int((where.y0 - crop_top) * scale), int((where.y1 - crop_top + 1) * scale))
    assert ink[rows].size > 0, "the other string's note is inside the crop"
    assert ink[rows].min() > 160, "but nothing of it is left to read"
    # The staff still reaches well past this number, which is the whole point:
    # the room and the lines are what make a ten-pixel digit legible.
    assert context.shape[0] > (max(m.y1 for m in lower.components) - where.y0) * scale


def test_a_context_render_declines_rather_than_raising_for_a_stray_mark() -> None:
    """A component from nowhere has no staff and no run, so there is nothing to show."""
    stray = glyphs.Component(x0=0, y0=0, x1=3, y1=3, template=np.zeros((20, 20), np.float32))
    page = render_system([(1, 120, "7")])
    reading = cli.Reading(frames.Page(index=0, start_s=0.0, end_s=1.0, image=page))

    assert pipeline.shape_context([reading], stray) is None
    assert pipeline.component_crop([reading], stray) is None


def test_emits_only_staff_lines_each_with_one_shared_extent() -> None:
    """
    Ruled clutter above the staff must not reach the parser.

    The parser walks rules in order and a run of one accepts any gap, so an
    irregular rule just above a staff would start its own run and then swallow
    the staff's first line — leaving five and hiding the staff. The y values are
    a notation staff and a stray measured off a frame where that happened.
    """
    page = render_system(
        [(1, 120, "7"), (4, 300, "9")],
        clutter=(
            (60, 100, 700),
            (76, 100, 700),
            (92, 100, 700),
            (106, 100, 700),
            (120, 100, 700),
            (138, 100, 700),
        ),
    )
    reading = cli.Reading(frames.Page(index=0, start_s=0.0, end_s=1.0, image=page))
    assert len(reading.staves) == 1, "the clutter must not read as a second staff"

    emitted = pipeline.emit([reading], pipeline.Shapes.of(list(reading.components)), {}).pages

    horizontals = [s for s in emitted[0].segments if abs(s.y1 - s.y0) < 0.01]
    assert len(horizontals) == 6, "only the six lines of the tab staff belong in the output"
    assert len({(round(s.x0, 3), round(s.x1, 3)) for s in horizontals}) == 1

    verticals = [s for s in emitted[0].segments if abs(s.x1 - s.x0) < 0.01]
    assert len(verticals) == 3, "the barlines are still emitted"


def test_declared_page_keeps_rules_inside_the_parser_window() -> None:
    """
    The parser accepts a staff line between 20% and 98% of the page width.

    A rule spanning the whole crop would be read as a sheet border and dropped,
    so the declared page has to be wider than the image it came from.
    """
    image_width = 1920
    declared, _, dx = primitives.page_frame(image_width, 500)
    span = (image_width + dx) - dx
    assert 0.2 < span / declared < 0.98


def _run_of(texts: list[str]) -> glyphs.Run:
    parts = []
    for index, _ in enumerate(texts):
        template = np.zeros((glyphs.TEMPLATE_SIZE, glyphs.TEMPLATE_SIZE), dtype=np.float32)
        parts.append(
            glyphs.Component(x0=index * 8, y0=0, x1=index * 8 + 7, y1=10, template=template)
        )
    return glyphs.Run(parts)


def test_a_one_pixel_sliver_is_not_taken_for_a_glyph() -> None:
    """
    A leftover stem or a piece of a slur is a mark, but it is not a character.

    It matters because templates are scaled onto a fixed square, so a sliver
    normalises into something indistinguishable from a narrow digit and then
    clusters with it. In the reference video that put 12% of all marks into the
    same shape as the digit 1, which read out as hundreds of phantom fret-1 notes.
    """
    page = render_system([(1, 120, "7")])
    ink = staff_mod.to_ink(page)
    # A one-pixel-wide vertical mark, as tall as a digit, on another string.
    line = TAB_TOP + 3 * SPACING
    ink[line - 5 : line + 5, 400] = True

    tab = staff_mod.find_staves(staff_mod.find_rules(staff_mod.marks(page)), 6)[0]
    found = glyphs.components_on_staff(ink, tab)
    assert all(c.width >= tab.spacing * glyphs.MIN_GLYPH_WIDTH for c in found)
    assert len(found) == 1, "only the printed 7 is a glyph"


def _tab_staff() -> staff_mod.Staff:
    """Six lines twenty pixels apart, as a tab staff is."""
    return staff_mod.Staff(lines=[100.0 + 20 * i for i in range(6)], x0=0.0, x1=800.0)


def _mark(x0: int, x1: int, cy: int, height: int = 9, bow: float = 0.0) -> glyphs.Component:
    template = np.zeros((glyphs.TEMPLATE_SIZE, glyphs.TEMPLATE_SIZE), dtype=np.float32)
    return glyphs.Component(
        x0=x0, y0=cy - height // 2, x1=x1, y1=cy - height // 2 + height, template=template, bow=bow
    )


def test_the_digits_of_a_two_digit_fret_are_read_as_one_number() -> None:
    """
    Measured on the reference video: the digits of one number sit up to about
    two-thirds of a glyph height apart, while consecutive notes on a string are at
    least two and a half heights apart. Joining only what nearly touches split half
    the two-digit frets into two confident wrong notes — a "12" became a 1 and a 2 —
    which is worse than an admitted gap.
    """
    staff = _tab_staff()
    # A tens and a units digit six pixels apart, as measured.
    runs = glyphs.group_runs([_mark(0, 4, 100), _mark(10, 17, 100)], staff)
    assert len(runs) == 1, "one number, not two notes"
    assert len(runs[0].components) == 2


def test_a_note_on_another_string_does_not_break_a_two_digit_fret() -> None:
    """
    Six strings interleave in x, so a note on one string routinely sits between
    the two digits of a number on another — measured overlapping them by a few
    pixels in the reference video. Walking every mark in one pass and testing only
    neighbouring pairs therefore split 125 of 297 two-digit frets, each into two
    confident wrong notes.
    """
    staff = _tab_staff()
    # A "10" on the top line, with a note on the third line printed between them.
    tens, units = _mark(0, 4, 100), _mark(10, 17, 100)
    intruder = _mark(6, 13, 140)
    runs = glyphs.group_runs([tens, intruder, units], staff)

    assert len(runs) == 2, "the number and the other note, not three fragments"
    pair = next(r for r in runs if len(r.components) == 2)
    assert {id(c) for c in pair.components} == {id(tens), id(units)}


def test_a_number_with_a_dropped_digit_is_reported_not_read() -> None:
    """
    A units digit too small to be captured must not leave the tens digit readable.

    Otherwise a "10" whose 0 was dropped spells a bare "1" and is emitted as a
    confident note on fret 1. In the reference video that made fret 1 a fifth of
    every note read, which no guitar part does — and a wrong note is far worse than
    an admitted gap, since nothing downstream can tell it was wrong.
    """
    ink = np.zeros((60, 60), dtype=bool)
    tens = _mark(10, 14, 30)
    ink[tens.y0 : tens.y1, tens.x0 : tens.x1] = True
    # Ink for a units digit that never became a component, right beside it.
    ink[28:34, 16:21] = True

    runs = [glyphs.Run([tens])]
    glyphs.flag_truncated(ink, _tab_staff(), runs, [tens])
    assert runs[0].truncated


def test_a_complete_number_is_not_called_truncated() -> None:
    ink = np.zeros((60, 60), dtype=bool)
    marks = [_mark(10, 14, 30), _mark(15, 22, 30)]
    for m in marks:
        ink[m.y0 : m.y1, m.x0 : m.x1] = True

    runs = [glyphs.Run(list(marks))]
    glyphs.flag_truncated(ink, _tab_staff(), runs, marks)
    assert not runs[0].truncated, "both digits were captured, so nothing is missing"


def test_a_lone_digit_with_clear_space_beside_it_is_read() -> None:
    ink = np.zeros((60, 60), dtype=bool)
    only = _mark(10, 17, 30)
    ink[only.y0 : only.y1, only.x0 : only.x1] = True

    runs = [glyphs.Run([only])]
    glyphs.flag_truncated(ink, _tab_staff(), runs, [only])
    assert not runs[0].truncated


def test_runs_come_back_in_reading_order() -> None:
    """Grouping by string must not reorder the music the parser is handed."""
    staff = _tab_staff()
    runs = glyphs.group_runs(
        [_mark(200, 207, 100), _mark(40, 47, 160), _mark(120, 127, 120)], staff
    )
    assert [r.x0 for r in runs] == sorted(r.x0 for r in runs)


def test_two_notes_a_note_spacing_apart_stay_separate() -> None:
    staff = _tab_staff()
    # Thirty-odd pixels apart is the between-note population.
    runs = glyphs.group_runs([_mark(0, 7, 100), _mark(38, 45, 100)], staff)
    assert len(runs) == 2, "two notes, not a two-digit fret"


def test_digits_on_different_strings_never_join() -> None:
    """Adjacent on the page but on different lines is two notes, however close."""
    staff = _tab_staff()
    runs = glyphs.group_runs([_mark(0, 4, 100), _mark(6, 13, 120)], staff)
    assert len(runs) == 2


def _emit_one(spelled: str, labels: list[str]) -> tuple[list, "pipeline._StaffTexts"]:
    """Run one spelled token through a staff emitter, returning its texts."""
    run = _run_of(labels)
    emitter = pipeline._StaffTexts(_tab_staff(), 0.0)
    emitter.add_run(run, spelled)
    return emitter.resolve(), emitter


def test_an_impossible_fret_from_one_mark_is_dropped() -> None:
    texts, emitter = _emit_one("79", ["79"])
    assert texts == []
    assert emitter.unread == 1


def test_an_impossible_fret_from_two_marks_becomes_a_legato_pair() -> None:
    """
    `79` is a hammer-on from 7 to 9, and the frets say so without any arc.

    Two frets only share a run when they are printed tighter than notes are ever
    spaced, which in this notation is a legato figure. The reference clip has 111
    of these — `79` thirty-seven times — and engraves most of them with no arc at
    all, so they used to come out as two unrelated notes.
    """
    texts, _ = _emit_one("79", ["7", "9"])
    assert [token.str for token in texts] == ["7", "9", "h"]


def test_a_descending_pair_in_one_run_is_a_pull_off() -> None:
    texts, _ = _emit_one("54", ["5", "4"])
    assert [token.str for token in texts] == ["5", "4", "p"]


def test_a_reachable_two_digit_fret_survives() -> None:
    """Fewest tokens wins, so `12` stays fret 12 rather than becoming 1 then 2."""
    texts, _ = _emit_one("12", ["1", "2"])
    assert [token.str for token in texts] == ["12"]


def test_three_digits_split_where_only_one_reading_is_playable() -> None:
    """
    `911` is a 9 hammering on to 11: `91` is off the fretboard, so nothing else fits.

    Spacing cannot answer this — on the reference clip the 9 sits closer to the
    first 1 than the two 1s sit to each other — and reading it per character gives
    9, 1, 1, one right note and two invented ones. The fretboard answers it.
    """
    texts, emitter = _emit_one("911", ["9", "1", "1"])
    assert [token.str for token in texts] == ["9", "11", "h"]
    assert emitter.unread == 0


def test_digits_with_two_equally_short_readings_are_reported_unread() -> None:
    """`121` is a 12 then a 1, or a 1 then a 21, and the ink does not say which."""
    texts, emitter = _emit_one("121", ["1", "2", "1"])
    assert texts == []
    assert emitter.unread == 1


# --- technique marks -------------------------------------------------------
#
# The video font fuses techniques into the tokens themselves — a hammer-on is a
# small digit against a full one, a pull-off an arc over the pair, a slide a dash
# beside its number. The emitter turns those labels into the below-staff `h`,
# `p` and `sl.` vocabulary the parser already reads from PDFs.


def _below_staff(item, staff) -> bool:
    return staff.bottom + staff.spacing * 0.9 <= item.y <= staff.bottom + staff.spacing * 4


def test_a_fused_hammer_pair_becomes_two_notes_and_a_mark() -> None:
    staff = _tab_staff()
    # As wide as a real fused pair: two digits and the join, about a staff space.
    fused = _mark(100, 121, int(staff.lines[2]))
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_run(glyphs.Run([fused]), "4h6")
    texts = emitter.resolve()
    notes = [t for t in texts if t.str.isdigit()]
    marks = [t for t in texts if not t.str.isdigit()]
    assert [n.str for n in notes] == ["4", "6"]
    assert [m.str for m in marks] == ["h"]
    assert _below_staff(marks[0], staff)
    # The mark sits between the notes it joins, which is how the parser knows
    # the second note is the one hammered onto.
    left, right = (n.x + n.width / 2 for n in notes)
    mark_cx = marks[0].x + marks[0].width / 2
    assert left < mark_cx < right
    # The two onsets must not merge back into a chord.
    assert right - left > staff.spacing * 0.3


def test_a_fused_pull_pair_keeps_its_two_digit_frets() -> None:
    texts, _ = _emit_one("12p10", ["12p10"])
    assert [t.str for t in texts] == ["12", "10", "p"]


def test_a_trailing_dash_is_a_slide_after_its_number() -> None:
    texts, _ = _emit_one("12-", ["12-"])
    assert [t.str for t in texts] == ["12", "sl."]
    note, slide = texts
    assert slide.x + slide.width / 2 > note.x + note.width / 2


def test_a_leading_dash_is_a_slide_into_its_number() -> None:
    texts, _ = _emit_one("-12", ["-12"])
    assert [t.str for t in texts] == ["12", "sl."]
    note, slide = texts
    assert slide.x + slide.width / 2 < note.x + note.width / 2


def _pair_with_arc(left: str, right: str) -> list:
    """Two notes on one string with a lone slur arc between them."""
    staff = _tab_staff()
    a = _mark(100, 107, int(staff.lines[2]))
    b = _mark(130, 137, int(staff.lines[2]))
    arc = _mark(110, 126, int(staff.lines[2]) - 8, height=3, bow=2.5)
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_run(glyphs.Run([a]), left)
    emitter.add_run(glyphs.Run([b]), right)
    emitter.add_flat(arc, "~")
    return emitter.resolve()


def test_an_arc_over_a_rising_pair_is_a_hammer_on() -> None:
    texts = _pair_with_arc("7", "9")
    assert [t.str for t in texts] == ["7", "9", "h"]


def test_an_arc_over_a_falling_pair_is_a_pull_off() -> None:
    texts = _pair_with_arc("4", "2")
    assert [t.str for t in texts] == ["4", "2", "p"]


def test_an_arc_with_nothing_beside_it_is_counted_rather_than_forgotten() -> None:
    """
    An arc can be found, clustered and named and still print nothing, because the
    notes it reaches for are missing. That is the same silent loss as an unnamed
    shape one layer further on, so it is counted where it can be reported.
    """
    staff = _tab_staff()
    arc = _mark(110, 126, int(staff.lines[2]) - 8, height=3, bow=2.5)
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_flat(arc, "~")
    assert emitter.resolve() == []
    assert emitter.unattached == 1


def test_an_arc_over_a_pair_the_run_already_joined_does_not_say_it_twice() -> None:
    staff = _tab_staff()
    a = _mark(100, 107, int(staff.lines[2]))
    b = _mark(108, 115, int(staff.lines[2]))
    arc = _mark(103, 113, int(staff.lines[2]) - 8, height=3, bow=2.5)
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_run(glyphs.Run([a, b]), "79")
    emitter.add_flat(arc, "~")
    assert [t.str for t in emitter.resolve()] == ["7", "9", "h"]


def test_an_arc_between_different_strings_is_not_a_slur() -> None:
    staff = _tab_staff()
    a = _mark(100, 107, int(staff.lines[2]))
    b = _mark(130, 137, int(staff.lines[3]))
    arc = _mark(110, 126, int(staff.lines[2]) - 8, height=3, bow=2.5)
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_run(glyphs.Run([a]), "7")
    emitter.add_run(glyphs.Run([b]), "9")
    emitter.add_flat(arc, "~")
    assert [t.str for t in emitter.resolve()] == ["7", "9"]


def test_an_arc_fused_to_its_digit_resolves_against_the_next_note() -> None:
    staff = _tab_staff()
    a = _mark(100, 112, int(staff.lines[2]))
    b = _mark(130, 137, int(staff.lines[2]))
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_run(glyphs.Run([a]), "4~")
    emitter.add_run(glyphs.Run([b]), "2")
    assert [t.str for t in emitter.resolve()] == ["4", "2", "p"]


def test_a_lone_dash_shape_is_a_slide_mark() -> None:
    staff = _tab_staff()
    dash = _mark(110, 124, int(staff.lines[2]), height=2)
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_flat(dash, "-")
    texts = emitter.resolve()
    assert [t.str for t in texts] == ["sl."]
    assert _below_staff(texts[0], staff)


def test_a_bend_arrow_is_a_mark_and_not_a_character() -> None:
    """
    A bend arrow is taller than any digit and narrower than one. Left among the
    glyphs it normalises into the same template as the digit 1 and clusters with
    it — 32 of them did on the reference clip, each a phantom note on fret 1.
    """
    page = render_system([(2, 150, "7")])
    line_y = TAB_TOP + 2 * SPACING
    ink = staff_mod.to_ink(page)
    # Rising from just right of the 7: three pixels wide, taller than a space.
    ink[line_y - 22 : line_y - 2, 160:163] = True

    tab = staff_mod.find_staves(staff_mod.find_rules(staff_mod.marks(page)), 6)[0]
    glyph_texts = [c.width for c in glyphs.components_on_staff(ink, tab)]
    assert len(glyph_texts) == 1, "only the 7 is a character"
    marks = glyphs.marks_on_staff(ink, tab)
    assert len(marks) == 1, "the arrow is collected as a technique mark"
    assert marks[0].height >= tab.spacing


def _above_staff(item, staff) -> bool:
    return staff.top - staff.spacing * 4.5 <= item.y <= staff.top - staff.spacing * 0.5


def test_a_bend_arrow_fused_to_its_digit_becomes_a_bend_mark() -> None:
    staff = _tab_staff()
    texts, _ = _emit_one("12b", ["1", "2b"])
    assert [t.str for t in texts] == ["12", "bend"]
    note, bend = texts
    # The word goes where the parser reads bend amounts from: above the staff,
    # anchored at the note it belongs to.
    assert _above_staff(bend, staff)
    assert abs(bend.x - (note.x + note.width / 2)) < 2


def test_a_bend_arrow_grouped_before_its_digit_is_the_same_bend() -> None:
    """
    Which side of the digit the arrow groups on is an accident of its stem.

    It leans over the note rather than sitting beside it, so `group_runs` puts it
    first about as often as last. Only the trailing order was in the grammar, so
    a leading one spelled `b10`, matched no pattern, and went out as a note whose
    text the parser's fret regex rejects — dropped without even being counted.
    Fifteen notes on the reference clip.
    """
    texts, _ = _emit_one("b10", ["b", "1", "0"])
    assert [t.str for t in texts] == ["10", "bend"]


def test_an_arrow_shaped_mark_is_a_bend_whatever_its_cluster_is_called() -> None:
    """
    The arrow's template normalises into the same square as the digit 1 and
    clusters with it — 32 did on the reference clip — so the cluster's confirmed
    name is often "1". The name says a person looked; the geometry says which
    members are arrows.
    """
    staff = _tab_staff()
    arrow = _mark(120, 124, int(staff.lines[2]) - 12, height=22)
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_flat(arrow, "1")
    texts = emitter.resolve()
    assert [t.str for t in texts] == ["bend"]
    assert _above_staff(texts[0], staff)


def test_a_lone_bend_arrow_is_a_bend_mark_too() -> None:
    # The arrow rises from the top of its digit, so it often lands in the
    # string bucket above and arrives as a run of its own.
    staff = _tab_staff()
    texts, _ = _emit_one("b", ["b"])
    assert [t.str for t in texts] == ["bend"]
    assert _above_staff(texts[0], staff)


def test_a_flat_marks_own_curve_outranks_its_label() -> None:
    """
    Arcs and dashes flatten into near-identical templates and can share one
    cluster, so a single label covers marks of both kinds. Each mark's own bow
    is the only per-occurrence truth, and it is what decides.
    """
    staff = _tab_staff()
    a = _mark(100, 107, int(staff.lines[2]))
    b = _mark(130, 137, int(staff.lines[2]))

    # Bowed but labelled as a dash: still a slur.
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_run(glyphs.Run([a]), "7")
    emitter.add_run(glyphs.Run([b]), "9")
    emitter.add_flat(_mark(110, 126, int(staff.lines[2]) - 8, height=3, bow=2.5), "-")
    assert [t.str for t in emitter.resolve()] == ["7", "9", "h"]

    # Straight but labelled as an arc: still a slide.
    emitter = pipeline._StaffTexts(staff, 0.0)
    emitter.add_flat(_mark(110, 126, int(staff.lines[2]) - 8, height=2), "~")
    assert [t.str for t in emitter.resolve()] == ["sl."]


def test_an_unlabelled_shape_makes_the_whole_number_unread() -> None:
    run = _run_of(["1", "2"])
    assignment = [0, 1]
    index_of = {id(run.components[0]): 0, id(run.components[1]): 1}
    # A half-read number would be worse than an admitted gap.
    assert glyphs.spell(run, assignment, index_of, {"0": "1", "1": ""}) is None
