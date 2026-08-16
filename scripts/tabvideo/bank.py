"""
Remembered shape names, so a font only ever has to be read once.

Naming shapes is the step that does not come free, and the reason it is bearable
is that it does not repeat: one video is one font at one size, and a second video
from the same source prints the same glyphs. Keeping every confirmed name against
the template it was confirmed for turns the second video into no work at all —
and where `namer.py` read the shapes rather than a person, it means the model is
asked once per font instead of once per video.

Names carry who gave them for that reason. A person and a model are not equally
authoritative about what a glyph says, so a model's reading can never displace or
sit beside a name someone confirmed, while a correction from a person overrides
whatever was there. See `remember`.

This is also the only recognition here that is trustworthy. Matching a glyph
against *system fonts* was measured at 38% on real video pixels, and Tesseract at
7-24%, because fret digits are around ten pixels tall — well under the ~14px any
OCR needs. Matching against a template a person already confirmed, from the same
rendering, is the case template distance was measured to handle cleanly: two
renderings of one character land within 0.133 of each other while different
characters start at 0.189.
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .glyphs import CLUSTER_RADIUS, TEMPLATE_SIZE

# A remembered template has to be at least this close to be taken as the same
# character. It is the same measured radius the clustering uses, which sits in
# the gap between the same-character and different-character populations.
MATCH_RADIUS = CLUSTER_RADIUS

# ...and the nearest entry with a *different* name has to be this much further
# away again. The measured gap between the two populations is 0.056 wide, so
# requiring a clear margin inside it keeps a near-tie from being decided by
# compression noise. A tie is reported as unknown and asked about instead.
MATCH_MARGIN = 0.03

# Bounded so a long-lived bank cannot grow without limit. Fonts contribute a few
# dozen shapes each, so this is many videos' worth.
MAX_ENTRIES = 4000

# Who confirmed a name. The distinction is not bookkeeping: a person looked at
# the shape and a model read it, and where the two disagree the person is right
# by definition. Entries written before this existed were all named by hand, so
# a missing value reads as `HUMAN`.
HUMAN = "human"
MODEL = "model"


def default_path() -> Path:
    """Where the bank lives, overridable so tests never touch the real one."""
    override = os.environ.get("NOODLEBOX_GLYPH_BANK")
    if override:
        return Path(override)
    return Path.home() / ".noodlebox" / "glyph-bank.json"


def _encode(template: np.ndarray) -> str:
    """Templates are 0..1 coverage maps; a byte per pixel is ample precision."""
    quantised = np.clip(template * 255.0, 0, 255).astype(np.uint8)
    return base64.b64encode(quantised.tobytes()).decode("ascii")


def _decode(payload: str) -> np.ndarray | None:
    try:
        raw = base64.b64decode(payload, validate=True)
    except Exception:
        return None
    if len(raw) != TEMPLATE_SIZE * TEMPLATE_SIZE:
        return None
    flat = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 255.0
    return flat.reshape((TEMPLATE_SIZE, TEMPLATE_SIZE))


@dataclass
class Entry:
    """One confirmed name and the shape it was confirmed for."""

    label: str
    """The character, or empty for a shape confirmed as not part of a fret number."""

    template: np.ndarray

    by: str = HUMAN
    """`HUMAN` or `MODEL`. Decides which entry wins where two disagree."""


class Bank:
    """Confirmed shape names, matched by template distance."""

    def __init__(self, entries: list[Entry] | None = None, path: Path | None = None) -> None:
        self.entries = entries or []
        self.path = path or default_path()

    def __len__(self) -> int:
        return len(self.entries)

    def _nearest(self, template: np.ndarray) -> list[tuple[float, str]]:
        # Sorted by distance, and a human-confirmed entry ahead of a machine-read
        # one at the same distance, so a person's answer wins any tie.
        ranked = sorted(
            (float(np.abs(entry.template - template).mean()), entry.by != HUMAN, entry.label)
            for entry in self.entries
        )
        return [(distance, label) for distance, _, label in ranked]

    def recognise(self, centroids: list[np.ndarray]) -> dict[int, str]:
        """
        Name whichever shapes have been confirmed before.

        Only shapes the bank is sure about appear in the result: a shape with no
        close match, or one caught between two different names, is left out for a
        person to decide. An empty string is a real answer — it means the shape
        was confirmed as something other than a fret number, like a slur
        fragment — so callers must test for membership, not truthiness.
        """
        out: dict[int, str] = {}
        for index, centroid in enumerate(centroids):
            ranked = self._nearest(centroid)
            if not ranked:
                continue
            distance, label = ranked[0]
            if distance > MATCH_RADIUS:
                continue
            contrary = next((d for d, other in ranked if other != label), None)
            if contrary is not None and contrary - distance < MATCH_MARGIN:
                continue
            out[index] = label
        return out

    def remember(self, centroids: list[np.ndarray], labels: dict[str, str], by: str = HUMAN) -> int:
        """
        Keep the names that were confirmed, and report how many were new.

        A name already covered by an equally-labelled entry is not stored again,
        so re-reading the same video does not grow the bank. Only shapes the
        caller actually decided about are taken: a label missing from the mapping
        was never looked at, which is not the same as a shape confirmed to be
        nothing.

        A confirmation that *contradicts* a stored entry replaces it. A person
        renaming a shape the bank already claimed to know is a correction — it
        happened when a bend arrow fused to a digit had been banked as the digit
        alone — and merely appending would leave two labels at one distance,
        which reads as a tie and gets asked about on every video for ever.

        Where a machine's reading contradicts a name a person confirmed, the
        person is right and nothing is written: a model must never be able to
        evict, or quietly sit beside, an answer someone looked at the shape to
        give. In the other direction a person's confirmation replaces whatever a
        model had said, and also takes ownership of a name a model had guessed
        correctly, so no later run can overturn it.
        """
        added = 0
        for index, centroid in enumerate(centroids):
            key = str(index)
            if key not in labels:
                continue
            label = labels[key]
            if not isinstance(label, str):
                continue
            template = centroid.astype(np.float32)
            close = [
                entry
                for entry in self.entries
                if float(np.abs(entry.template - template).mean()) <= MATCH_RADIUS
            ]
            contradicted = [entry for entry in close if entry.label != label]
            if by != HUMAN and any(entry.by == HUMAN for entry in contradicted):
                continue
            # Contradictions go first, so a correction also clears the tie it
            # would otherwise leave behind. Distances between different
            # characters were measured to start at 0.189, well outside the
            # radius, so anything this close under another name is wrong.
            # Removal is by identity: comparing entries with == reaches their
            # numpy templates, which refuse to be a single truth value.
            wrong = {id(entry) for entry in contradicted}
            if wrong:
                self.entries = [entry for entry in self.entries if id(entry) not in wrong]
            agreed = [entry for entry in close if entry.label == label]
            if agreed:
                if by == HUMAN:
                    for entry in agreed:
                        entry.by = HUMAN
                continue
            if len(self.entries) >= MAX_ENTRIES:
                break
            self.entries.append(Entry(label=label, template=template.copy(), by=by))
            added += 1
        return added

    def save(self) -> None:
        payload = [
            {"label": entry.label, "template": _encode(entry.template), "by": entry.by}
            for entry in self.entries
        ]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Written beside the target and moved into place, so an interrupted write
        # cannot leave the bank truncated.
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        temporary.replace(self.path)


def load(path: Path | None = None) -> Bank:
    """
    Read the bank, treating any damage as an empty one.

    A bank is a cache of decisions that can always be made again, so failing to
    read it must never stop a video being processed.
    """
    target = path or default_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return Bank(path=target)
    if not isinstance(raw, list):
        return Bank(path=target)
    entries: list[Entry] = []
    for item in raw[:MAX_ENTRIES]:
        if not isinstance(item, dict):
            continue
        label = item.get("label")
        template = _decode(item["template"]) if isinstance(item.get("template"), str) else None
        if not isinstance(label, str) or template is None:
            continue
        # Banks written before names could come from a model hold only names a
        # person gave, so an absent or unrecognised value is a human one.
        by = MODEL if item.get("by") == MODEL else HUMAN
        entries.append(Entry(label=label, template=template, by=by))
    return Bank(entries=entries, path=target)
