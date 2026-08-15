"""
Fetch the video a link points at.

Only the video stream is wanted — nothing here looks at audio — so no muxing and
no ffmpeg is involved.

The URL comes from whoever is using the app, so it is treated as untrusted:
`check_url` rejects anything that is not a public http(s) address before yt-dlp
sees it, and the download is bounded in both duration and size. Note the limit of
that check — yt-dlp resolves a page to a media URL on a CDN and follows it, so the
guard covers what was submitted, not every host subsequently contacted. That is
why the service binds to the loopback interface by default rather than relying on
this alone.
"""

from __future__ import annotations

import ipaddress
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

# A lesson video is minutes long. The cap is generous enough for a full song and
# mean enough to stop an accidental eight-hour livestream archive.
MAX_DURATION_S = 40 * 60

# Video-only streams of a 40 minute 1080p lesson land well inside this.
MAX_BYTES = 600 * 1024 * 1024

# Resolution is the binding constraint on reading small print: fret digits are
# around ten pixels tall in a 1080p panel, and clustering gets cleaner as they
# grow. Prefer the largest sensible stream, falling back rather than failing.
FORMAT = "bv*[height<=1440][ext=mp4]/bv*[height<=1440]/bv*/b"

# yt-dlp only enables deno by default; without a JavaScript runtime it falls back
# to a limited client, which hides the high-resolution formats and then fails
# mid-download with HTTP 403. The Python API wants {runtime: {config}} — note that
# this is *not* the shape the `--js-runtimes` command line option parses into, which
# the CLI converts before constructing YoutubeDL.
JS_RUNTIMES = {"node": {}}

# A media URL is signed for one address and one moment, and YouTube hands out
# ones that are refused on first use often enough to matter — a whole reading was
# lost to it. yt-dlp will not retry that itself: its downloader re-raises any
# status below 500 immediately, so `retries` covers transport errors and server
# faults but never a 403. Getting a usable URL means extracting again, which is
# why the retry lives out here rather than in the downloader's options.
#
# Five, not two: the refusal was seen twice in a row on the same video, so the
# rate is high enough that three attempts would still lose a reading now and
# then. A wasted attempt costs one extraction and the delay below, which is
# nothing beside re-reading a whole video. The delay does not grow — each attempt
# is signed afresh, so this is a bad URL rather than a rate limit, and waiting
# longer buys nothing.
DOWNLOAD_ATTEMPTS = 5
RETRY_DELAY_S = 2.0


class UrlRejected(Exception):
    """The submitted link is not something worth handing to a downloader."""


class DownloadFailed(Exception):
    """The video could not be fetched."""


@dataclass(frozen=True)
class Fetched:
    path: Path
    title: str
    duration_s: float
    source_url: str


def _is_public(host: str) -> bool:
    """
    True when every address a hostname resolves to is a public one.

    Checking all of them matters: a name that resolves to both a public address
    and 127.0.0.1 would otherwise pass on the strength of the public one.
    """
    try:
        resolved = socket.getaddrinfo(host, None)
    except socket.gaierror as problem:
        raise UrlRejected(f"{host} could not be resolved.") from problem
    addresses = {info[4][0] for info in resolved}
    if not addresses:
        return False
    for text in addresses:
        try:
            address = ipaddress.ip_address(text.split("%")[0])
        except ValueError:
            return False
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            return False
    return True


def check_url(raw: str) -> str:
    """Validate a submitted link, returning it cleaned. Raises `UrlRejected`."""
    candidate = raw.strip()
    if not candidate:
        raise UrlRejected("No link was given.")
    if len(candidate) > 2048:
        raise UrlRejected("That link is too long.")
    parsed = urlparse(candidate)
    if parsed.scheme not in ("http", "https"):
        raise UrlRejected("Only http and https links can be fetched.")
    if not parsed.hostname:
        raise UrlRejected("That link has no host in it.")
    if not _is_public(parsed.hostname):
        raise UrlRejected(
            "That link points inside the local network, which this service will not fetch."
        )
    return candidate


def probe_options() -> dict:
    """Options for reading a link without downloading it."""
    return {
        "quiet": True,
        # `quiet` does not cover the progress line, and the service reports
        # progress through its hook rather than the console.
        "noprogress": True,
        "no_warnings": True,
        "noplaylist": True,
        "js_runtimes": JS_RUNTIMES,
    }


def download_options(into: Path, hook=None) -> dict:
    """Options for fetching the video stream only, bounded in size."""
    return {
        **probe_options(),
        "format": FORMAT,
        "outtmpl": str(into / "clip.%(ext)s"),
        "max_filesize": MAX_BYTES,
        "progress_hooks": [hook] if hook else [],
        # Nothing here reads audio or needs a container rebuilt, so no
        # post-processing is wanted and ffmpeg is not a dependency.
        "postprocessors": [],
    }


def probe(url: str) -> dict:
    """Read what a link offers without downloading it."""
    import yt_dlp

    options = probe_options()
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=False)
    except Exception as problem:  # yt-dlp raises a wide variety
        raise DownloadFailed(f"That link could not be read: {problem}") from problem
    if info is None:
        raise DownloadFailed("Nothing was found at that link.")
    if info.get("_type") == "playlist":
        entries = [entry for entry in (info.get("entries") or []) if entry]
        if not entries:
            raise DownloadFailed("That link is an empty playlist.")
        info = entries[0]
    return info


def check_limits(info: dict) -> None:
    """Refuse a video that is too long before any of it is downloaded."""
    duration = info.get("duration")
    if isinstance(duration, (int, float)) and duration > MAX_DURATION_S:
        raise UrlRejected(
            f"That video is {duration / 60:.0f} minutes long; "
            f"the limit is {MAX_DURATION_S // 60} minutes."
        )


def _empty(into: Path) -> None:
    """
    Clear a working directory between download attempts.

    Resuming would be faster, but a second attempt may settle on a different
    format with the same extension, and yt-dlp would append it to the part file
    left by the first — a file that decodes as neither. Starting over is cheap
    beside reading the video and cannot produce that.
    """
    for path in sorted(into.iterdir()):
        if path.is_file():
            path.unlink(missing_ok=True)


def download(url: str, into: Path, on_progress=None, on_retry=None) -> Fetched:
    """
    Fetch the video stream into `into`, bounded in length and size.

    `on_progress` is called with a 0..1 fraction where one is known, because a
    download is the slowest part of reading a video and the app is showing it.
    `on_retry` is called with the attempt that just failed, so a retry reads as
    progress rather than as a stall.
    """
    import yt_dlp

    into.mkdir(parents=True, exist_ok=True)
    info = probe(url)
    check_limits(info)

    def hook(status: dict) -> None:
        if status.get("status") != "downloading" or on_progress is None:
            return
        done = status.get("downloaded_bytes") or 0
        total = status.get("total_bytes") or status.get("total_bytes_estimate") or 0
        if total:
            on_progress(min(1.0, done / total))

    # `probe` already reached this video, so it is public and of a readable
    # length; a download that fails now is far likelier to be a refused URL than
    # anything permanent, and each attempt extracts again to get a fresh one.
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        _empty(into)
        try:
            with yt_dlp.YoutubeDL(download_options(into, hook)) as downloader:
                downloader.download([url])
            break
        except Exception as problem:  # yt-dlp raises a wide variety
            if attempt == DOWNLOAD_ATTEMPTS:
                raise DownloadFailed(
                    f"That video could not be downloaded after {DOWNLOAD_ATTEMPTS} "
                    f"attempts: {problem}. If every video fails this way, run "
                    "`pip install -U yt-dlp` — video sites change and an old copy "
                    "stops being able to read them."
                ) from problem
            if on_retry:
                on_retry(attempt)
            time.sleep(RETRY_DELAY_S)

    files = sorted(p for p in into.iterdir() if p.is_file() and p.stat().st_size > 0)
    if not files:
        raise DownloadFailed(
            "The video stream was not saved, which usually means it was larger than "
            f"{MAX_BYTES // (1024 * 1024)} MB."
        )
    largest = max(files, key=lambda p: p.stat().st_size)
    return Fetched(
        path=largest,
        title=str(info.get("title") or "video"),
        duration_s=float(info.get("duration") or 0.0),
        source_url=url,
    )
