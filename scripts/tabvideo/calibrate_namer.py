"""
Score the automatic shape namer against names a person confirmed.

Automatic naming is only safe if it is wrong approximately never: an unnamed
shape is reported as unread, while a wrongly named one becomes a wrong note on
every occurrence of that shape in the piece. That is not something to take on
faith from a model's own confidence, so this measures it.

Nothing has to be run before the app — the service names shapes automatically
whenever `.env` points it at a model. This is for answering "can that model
actually read this font", which is a question worth having a number for. Import
the video once and name its shapes by hand, which banks them, then:

    python3 -m scripts.tabvideo.calibrate_namer clip.mp4

**The bar is zero wrong names.** Coverage is reported too, but it is not the
measure: abstentions cost a person one naming screen and are banked afterwards,
while a single wrong name is silently wrong music. A run that turns up wrong
names is a reason to try another model or clear `TABVIDEO_VLM_URL`, since the
reader has no way to tell a confident misreading from a correct one.

Ground truth is the **glyph bank**, and it is matched the way the reader matches
it: by template distance. This started out reading a labels file keyed by shape
index instead, and that was wrong in a way worth recording, because it did not
fail — it produced a confident, detailed, entirely fictitious verdict. Shape
indices only mean anything within one clustering run. Scored against a labels
file written when the pipeline produced 127 shapes, a run that produced 45
reported 21 wrong names and "79.9% of marks named wrongly", when the model had in
fact been describing each mark accurately and being compared against a different
one. A measuring instrument that can be silently mis-aligned is worse than no
instrument, so alignment is now by content and the bank is the only source.

The namer never sees the bank, so this measures the model rather than what has
already been confirmed; nothing is written back.

Nothing here is part of the test suite: it needs an endpoint and a video, and
lesson videos are copyrighted, so this is run by hand.
"""

from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

from . import bank as bank_mod, env as env_mod, namer as namer_mod, pipeline

# The same settings the service uses, so this measures what the app will do.
env_mod.apply()

# Below this share of the notation carrying a confirmed name, a verdict is not
# worth printing: "no wrong names" over a handful of shapes says nothing about
# the ones it never checked, and reads as a pass.
MIN_JUDGED_FRACTION = 0.5

# Everything the emitter prints that is not a fret number. `x` is a muted note
# rather than a technique, but it is a token the parser knows. Anything outside
# this and the frets is a token nothing downstream is expecting, which is worth
# saying out loud: `(5h6` is a ghost bracket that grouped with a fused pair, and
# it reaches the parser as five characters of nonsense.
TECHNIQUES = ("h", "p", "sl.", "bend", "x")


def _truth(shapes: pipeline.Shapes, path: Path | None) -> dict[int, str]:
    """
    The names a person confirmed, aligned to this run's shapes by template.

    Only human entries count. A model's own earlier answer is not evidence about
    a model — banking it as truth would let the namer mark its own homework, and
    a mistake it makes consistently would score as a pass.
    """
    every = bank_mod.load(path)
    human = bank_mod.Bank([entry for entry in every.entries if entry.by == bank_mod.HUMAN])
    return human.recognise(shapes.centroids)


def _census(emitted: pipeline.Emitted) -> tuple[list[str], list[str]]:
    """
    What the reading came out as, and what looks wrong about it without a truth.

    Names were 24 correct out of 24 while the clip was emitting no articulation at
    all, so scoring names says nothing about the music. These are checks on the
    output itself, and none of them needs to know the right answer: a technique
    that was found and never printed, an arc that joined nothing, a run whose
    digits had a second playable reading. Each is a question a person can settle
    by looking at one bar.
    """
    frets: collections.Counter[int] = collections.Counter()
    techniques: collections.Counter[str] = collections.Counter()
    odd: collections.Counter[str] = collections.Counter()
    for page in emitted.pages:
        for text in page.texts:
            bare = text.str.strip("()")
            if bare.isdigit():
                frets[int(bare)] += 1
            elif text.str in TECHNIQUES:
                techniques[text.str] += 1
            else:
                odd[text.str] += 1

    lines = [
        f"{sum(frets.values())} notes, {sum(techniques.values())} technique marks",
        "  techniques: " + (", ".join(f"{k} x{v}" for k, v in techniques.most_common()) or "none"),
        "  frets: " + ", ".join(f"{fret}x{n}" for fret, n in sorted(frets.items())),
        f"  {emitted.runs} printed tokens, {emitted.unspelled} of them unread",
        f"  {emitted.flats} technique marks found: {emitted.silent} unnamed, "
        f"{emitted.unattached} joined nothing, {emitted.ignored} named as something else",
    ]

    contested = sorted(emitted.contested.items(), key=lambda kv: -kv[1])
    if contested:
        lines.append(
            "  digits with a second playable reading (shortest taken): "
            + ", ".join(f"{text} x{n}" for text, n in contested)
        )

    complaints: list[str] = []
    if odd:
        complaints.append(
            "these tokens are neither a fret nor a technique, so the parser will make "
            "what it can of them: " + ", ".join(f"{k!r} x{v}" for k, v in odd.most_common())
        )
    if emitted.silent:
        complaints.append(
            f"{emitted.silent} technique marks have no name, so their hammer-ons, "
            f"pull-offs and slides are missing. Name that shape once and they come back."
        )
    if emitted.ignored:
        complaints.append(
            f"{emitted.ignored} flat marks are named as something a technique cannot use. "
            f"A slur arc named as a digit is a technique lost and a note invented."
        )
    if emitted.unattached:
        complaints.append(
            f"{emitted.unattached} named arcs found no pair of notes to join, so printed nothing."
        )
    if emitted.flats and not techniques:
        complaints.append(
            f"{emitted.flats} technique marks were found and the score has no articulation "
            f"at all. This is the failure that a perfect naming score hides."
        )
    if emitted.split:
        lines.append(
            "  read as legato pairs rather than the fret they spell: "
            + ", ".join(f"{text} x{n}" for text, n in emitted.split.items())
        )
    suspect = [t for t in pipeline.suspect_patterns(emitted) if t not in emitted.split]
    if suspect:
        complaints.append(
            "these read as a fret the piece barely uses, while their legato reading "
            "uses frets it plays constantly, and nothing settled it — check one bar "
            "of each by eye: " + ", ".join(f"{t} x{emitted.contested[t]}" for t in suspect)
        )
    return lines, complaints


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("video", help="video file holding the engraved tab")
    parser.add_argument(
        "--bank",
        type=Path,
        help="glyph bank holding the hand-confirmed names (default: the real one)",
    )
    parser.add_argument("--limit", type=int, help="stop after this many systems")
    parser.add_argument(
        "--shapes",
        type=int,
        help="only ask about the N commonest shapes (the tail is mostly debris)",
    )
    args = parser.parse_args(argv)

    namer = namer_mod.Namer.from_env()
    if namer is None:
        state = namer_mod.availability()
        print(
            state.problem
            or f"No namer configured. Set {namer_mod.URL_VAR} and {namer_mod.MODEL_VAR} in .env.",
            file=sys.stderr,
        )
        return 2

    try:
        pipeline.check_scroll(str(args.video))
    except (pipeline.UnreadableVideo, pipeline.ScrollingVideo) as problem:
        print(str(problem), file=sys.stderr)
        return 1

    readings = pipeline.read_video(str(args.video), args.limit)
    if not readings:
        print("no systems found", file=sys.stderr)
        return 1

    shapes = pipeline.find_shapes(readings)
    truth = _truth(shapes, args.bank)
    total_marks = sum(shapes.counts)
    judged_marks = sum(shapes.counts[index] for index in truth)
    judged_share = judged_marks / max(1, total_marks)
    print(f"{len(readings)} systems, {len(shapes.every)} marks, {len(shapes)} distinct shapes")
    print(
        f"{len(truth)} of them carry a hand-confirmed name, covering "
        f"{judged_share:.1%} of the marks"
    )
    if not truth:
        print(
            "Nothing to score against. Import this video once and name its shapes by "
            "hand; that banks them, and they become the ground truth here.",
            file=sys.stderr,
        )
        return 1

    wanted = list(range(len(shapes)))[: args.shapes] if args.shapes else list(range(len(shapes)))
    jobs = namer_mod.build_jobs(readings, shapes, wanted, exemplars=namer.exemplars)
    print(f"asking about {len(jobs)} shapes, {namer.exemplars} looks each\n")

    outcomes = namer.read(
        jobs, on_progress=lambda done, total: print(f"\r  {done}/{total}", end="", flush=True)
    )
    print("\r" + " " * 20 + "\r", end="")

    correct = wrong = abstained = unjudged = 0
    correct_marks = wrong_marks = named_marks = 0
    rows: list[str] = []

    for outcome in outcomes:
        count = shapes.counts[outcome.index]
        expected = truth.get(outcome.index)
        shows = next((answer.shows for answer in outcome.answers if answer.shows), "")
        if outcome.label is not None:
            named_marks += count
        if expected is None:
            unjudged += 1
            verdict = "?"
        elif outcome.label is None:
            abstained += 1
            verdict = "-"
        elif outcome.label == expected:
            correct += 1
            correct_marks += count
            verdict = "ok"
        else:
            wrong += 1
            wrong_marks += count
            verdict = "WRONG"
        if verdict in ("WRONG", "-") or outcome.label is not None:
            rows.append(
                f"  {verdict:<5} shape {outcome.index:<3} x{count:<5} "
                f"said {outcome.label!r:<8} truth {expected!r:<8} "
                f"({outcome.reason}) {shows[:48]}"
            )

    print("\n".join(rows))
    print(
        f"\n{correct} correct, {wrong} wrong, {abstained} abstained"
        + (f", {unjudged} with no confirmed name to check against" if unjudged else "")
    )
    print(
        f"marks: {correct_marks / max(1, total_marks):.1%} named correctly, "
        f"{wrong_marks / max(1, total_marks):.1%} named wrongly, "
        f"{(total_marks - named_marks) / max(1, total_marks):.1%} left to a person"
    )

    # Then the music. Every number above is about names, and names were perfect
    # through the whole time the reader was dropping every hammer-on it found.
    labels = {str(index): name for index, name in truth.items()}
    labels.update({str(o.index): o.label for o in outcomes if o.label is not None})
    emitted = pipeline.emit(readings, shapes, labels)

    patterns = pipeline.suspect_patterns(emitted)
    if patterns:
        run_jobs = namer_mod.build_run_jobs(readings, shapes, labels, patterns, namer.exemplars)
        print(f"\nasking about {len(run_jobs)} contested digit patterns")
        verdicts = namer.read_runs(run_jobs)
        for verdict in verdicts:
            shows = next((a.shows for a in verdict.answers if a.shows), "")
            mark = "split" if verdict.legato else "left"
            print(
                f"  {mark:<5} {verdict.text:<7} x{emitted.contested[verdict.text]:<4} "
                f"({verdict.reason}) {shows[:60]}"
            )
        legato = {verdict.text for verdict in verdicts if verdict.legato}
        if legato:
            emitted = pipeline.emit(readings, shapes, labels, legato=legato)

    lines, complaints = _census(emitted)
    print("\nwhat came out:")
    print("\n".join(lines))
    for complaint in complaints:
        print(f"\n  ! {complaint}")

    if wrong:
        print(
            f"\nNOT safe to enable: {wrong} shapes were named wrongly, which is "
            f"{wrong_marks} marks of wrong music.",
            file=sys.stderr,
        )
        return 1
    if judged_share < MIN_JUDGED_FRACTION:
        # Not a pass. Saying "no wrong names" here would be a statement about the
        # few shapes that were checked, read as one about the whole font.
        print(
            f"\nNo wrong names, but only {judged_share:.1%} of the marks had a confirmed "
            f"name to check against — too little to conclude anything. Name more shapes "
            f"by hand and run this again.",
            file=sys.stderr,
        )
        return 1
    print("\nNo wrong names. Safe to enable automatic naming.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
