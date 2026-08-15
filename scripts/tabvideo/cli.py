"""
Command line entry point: a tab video in, `TabPagePrimitives` JSON out.

The app can do this itself now — paste the link into the library and the local
extraction service runs the same pipeline, naming shapes in the browser instead
of in a file. This exists for working on the reader itself, where the contact
sheet and the intermediate files are what you want to look at.

Recognition runs in two passes, because naming the glyph shapes is the one step a
machine should not guess at. The first pass finds every distinct shape in the
video and writes a contact sheet plus a labels file to fill in; the second reads
the labels and emits the score. Labels are per font — one video is one font at
one size — so the manual step is a few dozen characters, once.

    python -m scripts.tabvideo.cli video.mp4 --out build/tab
    # name the shapes in build/tab/labels.json, then
    python -m scripts.tabvideo.cli video.mp4 --out build/tab --labels build/tab/labels.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2

from . import bank as bank_mod, pipeline, primitives

# Re-exported so the tests and any other caller keep one import site for these.
Reading = pipeline.Reading
MAX_FRET = pipeline.MAX_FRET
SCROLL_LIMIT_PX_PER_S = pipeline.SCROLL_LIMIT_PX_PER_S


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("video", help="video file holding the engraved tab")
    parser.add_argument(
        "--out", required=True, type=Path, help="directory for the contact sheet and output"
    )
    parser.add_argument("--labels", type=Path, help="labels JSON produced by the first pass")
    parser.add_argument("--limit", type=int, help="stop after this many systems (for a quick look)")
    parser.add_argument(
        "--no-bank",
        action="store_true",
        help="ignore remembered shape names instead of pre-filling from them",
    )
    args = parser.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)

    try:
        top, bottom = pipeline.check_scroll(str(args.video))
    except pipeline.UnreadableVideo as problem:
        print(str(problem), file=sys.stderr)
        return 1
    except pipeline.ScrollingVideo as problem:
        print(str(problem), file=sys.stderr)
        return 2
    print(f"panel rows {top}..{bottom}, held systems (no scroll)")

    readings = pipeline.read_video(str(args.video), args.limit)
    if not readings:
        print("no systems found", file=sys.stderr)
        return 1

    shapes = pipeline.find_shapes(readings)
    print(
        f"{len(readings)} systems, {sum(len(r.staves) for r in readings)} tab staves, "
        f"{len(shapes.every)} glyphs, {len(shapes)} distinct shapes"
    )

    if not args.labels:
        remembered = {} if args.no_bank else bank_mod.load().recognise(shapes.centroids)
        sheet = args.out / "clusters.png"
        cv2.imwrite(str(sheet), pipeline.exemplar_sheet(readings, shapes))
        labels_path = args.out / "labels.json"
        labels_path.write_text(
            json.dumps({str(i): remembered.get(i, "") for i in range(len(shapes))}, indent=1),
            encoding="utf-8",
        )

        print("\nshapes are ordered commonest first; naming the first N covers:")
        for milestone in (10, 20, 40, 80):
            if milestone < len(shapes):
                print(f"   {milestone:3d} shapes -> {shapes.coverage(milestone):5.1%} of marks")
        if remembered:
            print(
                f"\n{len(remembered)} of {len(shapes)} shapes were filled in from previously "
                "confirmed names; check them and fill in the rest."
            )
        print(
            f"\nwrote {sheet} and {labels_path}\n"
            'name each shape in the labels file: "7", "x", "(", techniques like\n'
            '"4h6", "4p2", "12-", "12b" or a lone "~" (slur arc), "-" (slide\n'
            'dash), "b" (bend arrow), and "" for anything else. Then re-run with\n'
            "--labels.\n"
            "The tail is mostly beam fragments; leaving it empty is fine."
        )
        return 0

    labels = json.loads(args.labels.read_text(encoding="utf-8"))
    pages, unspelled = pipeline.emit(readings, shapes, labels)
    named = sum(1 for value in labels.values() if value)
    total_texts = sum(len(page.texts) for page in pages)
    out_path = args.out / "primitives.json"
    primitives.write(pages, out_path)
    if not args.no_bank:
        # Confirmed names are worth keeping: the next video in this font starts
        # already labelled.
        remembered = bank_mod.load()
        added = remembered.remember(shapes.centroids, labels)
        remembered.save()
        if added:
            print(f"remembered {added} shape names for future videos")
    print(
        f"{named}/{len(shapes)} shapes named, {total_texts} tokens read, "
        f"{unspelled} skipped as unlabelled\nwrote {out_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
