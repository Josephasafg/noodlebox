"""
Serialise detected geometry into the shape `src/tabpdf` already parses.

`TabPagePrimitives` was deliberately defined in terms of plain numbers rather
than pdf.js objects, so a video frontend only has to produce the same primitives
a PDF would have: long horizontal rules, the verticals that cross them, and
positioned text. Everything after that — strings, measures, beats, articulations
— is the existing parser's job.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

# The parser discards any horizontal rule wider than 98% of the page, on the
# grounds that it is a sheet border rather than a staff line. Staff lines in a
# video fill the panel almost exactly, so the emitted page declares a margin
# around the crop and offsets everything into it.
MARGIN_FRACTION = 0.05


@dataclass(frozen=True)
class Segment:
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass(frozen=True)
class Text:
    str: str
    x: float
    y: float
    fontSize: float
    width: float


@dataclass(frozen=True)
class PagePrimitives:
    pageIndex: int
    width: float
    height: float
    segments: list[Segment]
    texts: list[Text]


def page_frame(image_width: int, image_height: int) -> tuple[float, float, float]:
    """Declared page size for a crop, plus the x offset to place it inside."""
    declared_width = image_width / (1.0 - 2.0 * MARGIN_FRACTION)
    return declared_width, float(image_height), declared_width * MARGIN_FRACTION


def write(pages: list[PagePrimitives], path: Path) -> None:
    """Write the primitives as JSON the TypeScript parser can read directly."""
    payload = [asdict(page) for page in pages]
    path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
