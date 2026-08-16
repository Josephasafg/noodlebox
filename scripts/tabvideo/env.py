"""
Settings that live with the project instead of in a shell.

The reader is not something anyone starts by hand — `npm run dev` starts it — so
configuration that has to be exported first is configuration that is missing the
first time, and every time a new terminal is opened. A `.env` beside the app is
read instead, which makes pointing the reader at a vision model a one-line edit
that survives a reboot.

    TABVIDEO_VLM_URL=http://127.0.0.1:8000/v1
    TABVIDEO_VLM_MODEL=Qwen/Qwen2.5-VL-32B-Instruct

Real environment variables win over the file, so a value exported for one run
still overrides, and `.env.local` wins over `.env` — the same order Vite uses, so
there is only one convention to know. `scripts/devEnv.mjs` reads the same files,
because Vite's proxy needs `TABVIDEO_PORT` before this process exists; its tests
mirror this module's case for case, since two parsers for one format are only
safe while they agree.

The format is deliberately the boring subset: `KEY=value`, `#` comments, and
optional quotes. No interpolation, no multi-line values, no shell. A config file
that can surprise you is worse than one that cannot express much.
"""

from __future__ import annotations

import os
from pathlib import Path

# `.env` holds a cluster address and possibly a token, so both are in .gitignore.
FILENAMES = (".env", ".env.local")

ROOT = Path(__file__).resolve().parents[2]

QUOTES = ("'", '"')


def parse(text: str) -> dict[str, str]:
    """Read `KEY=value` lines, ignoring anything that is not one."""
    found: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in QUOTES:
            value = value[1:-1]
        found[key] = value
    return found


def read(root: Path | None = None) -> dict[str, str]:
    """Everything the project's env files set, later files winning."""
    base = ROOT if root is None else root
    found: dict[str, str] = {}
    for name in FILENAMES:
        path = base / name
        if not path.is_file():
            continue
        try:
            found.update(parse(path.read_text(encoding="utf-8")))
        except OSError as problem:
            # Not fatal: the reader works without any of this. But a file that
            # exists and was not read is a setting someone believes is applied.
            print(f"could not read {path}: {problem}", flush=True)
    return found


def apply(root: Path | None = None, environ: dict[str, str] | None = None) -> dict[str, str]:
    """Fill gaps in the environment from the project's env files."""
    target = os.environ if environ is None else environ
    applied = {key: value for key, value in read(root).items() if key not in target}
    target.update(applied)
    return applied
