# tabvideo — read engraved tab out of a video

Lesson videos often show the tablature on screen while it plays. This reads the
notation off the frames and hands it to the tab parser in `src/tabpdf`, so a part
can be studied in the app without scrubbing the video.

It reads the *printed* notation. It does not listen to the audio — nothing here
attempts to transcribe sound, which is a much harder and far less accurate job.

## Paste a link into the app

This runs as a local service, so reading a video is something the app does rather
than something you do first:

    pip install -r scripts/tabvideo/requirements.txt
    npm run dev

`npm run dev` starts the service alongside Vite, which proxies `/api` to it. Paste
a video link into the library and it downloads, reads, and — for a font it has not
seen — shows you the printed shapes to name. Everything else in the app works
without the service running; only video links need it.

The service binds to the loopback interface and is not built to be exposed. It
downloads whatever URL it is handed and spends real CPU doing it, so putting it on
a public address would need authentication and rate limiting first. It refuses
links that resolve into the local network, refuses videos over 40 minutes before
downloading any of them, and refuses requests that arrive under a hostname other
than localhost, which is what stops a page on another origin from driving it.

Only the video stream is fetched — nothing here reads audio — so there is no
muxing and `ffmpeg` is not a dependency. yt-dlp is told to use Node explicitly:
without a JavaScript runtime it falls back to a limited client, which both hides
the high-resolution formats and fails mid-download with `HTTP Error 403`.

A 403 also happens with a runtime present, because the media URL is signed for one
address and moment and YouTube sometimes refuses one on first use — twice in a row
here, on a video that then downloaded fine. yt-dlp will not retry that itself: its
downloader re-raises any status under 500 immediately, so `retries` covers dropped
connections and server faults but never this. Recovering means extracting again for
a freshly signed URL, which the service does up to five times before giving up. If
*every* video fails this way instead, yt-dlp is out of date: `pip install -U yt-dlp`.

## Why naming the shapes is left to a person

It is the one step here that is not automatic, so it is worth saying plainly that
this is a measured limit and not an unfinished corner.

Fret digits are around ten pixels tall in a 1080p panel. Measured against the
shapes in the reference video that had been named by hand:

| approach                                    | accuracy |
| ------------------------------------------- | -------- |
| nearest match among ~200 system fonts        | 38%      |
| Tesseract, single character, digit whitelist | 7-24%    |

The decision margins were around 0.01 on a 0..1 scale, so no confidence threshold
separates the right answers from the wrong ones either. Sweeping glyph height on
clean synthetic digits shows why: Tesseract reaches 48% at 8px, 62% at 10px and
90% only at 14px. **The binding constraint is resolution, not the font** — which
also means a higher-resolution source would move these numbers, and is why the
downloader asks for the largest stream it can get.

A wrong name becomes a wrong note everywhere that shape occurs, while an unnamed
one is counted and reported. So nothing guesses.

## Techniques have names too

The video font fuses playing techniques into the printed marks, and a shape can be
named as what it says rather than left empty:

| what the shape shows                        | name it   | comes out as        |
| ------------------------------------------- | --------- | ------------------- |
| a small digit tight against a full one      | `4h6`     | hammer-on 4→6       |
| two digits under one arc                     | `4p2`     | pull-off 4→2        |
| a lone slur arc between two notes            | `~`       | hammer-on or pull-off, decided by which way the frets go |
| an arc fused to its digit                    | `4~`/`~4` | same, joined to the next/previous note |
| a dash after or before a number              | `12-`/`-12` | slide             |
| a lone slide dash                            | `-`       | slide               |
| an up arrow beside a number                  | `12b`/`b12` | bend              |
| a lone bend arrow                            | `b`       | bend                |
| a muted-note cross                           | `x`       | dead note           |

This font prints no bend amount, only the arrow, so the bend is shown as `12↑` —
what the page actually says — rather than an invented target fret.

The arrow needed more than a name. It is taller than any digit and narrower than
one, and left among the glyphs it normalises into the same template as the digit
1 and clusters with it: 32 arrows sat inside the clusters named "1" on the
reference clip, each one emitted as a phantom note on fret 1. Arrows are now
collected as technique marks by that geometry, never as characters. Renaming a
shape the bank already claimed to know also *replaces* the wrong entry rather
than leaving a tie beside it, so one correction heals every later video.

Slur arcs and slide dashes are wide and only a few pixels tall — the opposite of a
digit — so they are collected separately from the glyph filters, which were
measured against fragments that cluster into phantom notes. Claiming them also
fixes something quieter: unclaimed ink beside a number is how truncation is
detected, so before this every note a mark decorated was silenced as incomplete —
223 runs read as truncated on the reference clip against 195 once marks are claimed.

Arcs and dashes flatten into near-identical templates and can end up in one
cluster, so a single label can cover marks of both kinds. Either technique name
(`~` or `-`) confirms the cluster holds technique marks; which kind each mark is
comes from its own curve. Measured over the clip's 56 flat marks: the 11 dashes
bow at most 0.5px, 45 of the 46 arcs bow 0.9–1.8px, and the one shallow arc at
0.5px is misread as a slide — a decoration wobble, never a wrong note.

A lone arc cannot say which way it goes. Its direction is resolved from the two
notes it joins — rising is a hammer-on, falling a pull-off — and an arc whose
neighbours cannot be read stays silent rather than guessing.

## Names are remembered

What makes this bearable is that it does not repeat. One video is one font at one
size, so every confirmed name is kept in `~/.noodlebox/glyph-bank.json` against the
template it was confirmed for, and the next video in that font is read without
anyone being asked anything.

Matching against a template a person already confirmed is the one recognition
regime that measured cleanly: two renderings of a character land within 0.133 of
each other while different characters start at 0.189. A match must be inside that
gap *and* clear of the nearest different name, or the shape is asked about
instead.

## Use from the command line

The service is the way to read a video. This is for working on the reader itself,
where the contact sheet and the intermediate files are what you want to look at.

Recognition runs in two passes, because naming glyph shapes is the one step a
machine should not guess at.

    # 1. find every distinct shape in the video
    python3 -m scripts.tabvideo.cli clip.mp4 --out build/tab

This writes `build/tab/clusters.png` — one magnified crop per shape, numbered —
and `build/tab/labels.json` with an empty entry for each. Fill it in:

- a fret number's digit → `"7"`
- a muted note → `"x"`, a ghost note's brackets → `"("` and `")"`
- anything that is not part of a fret number → `""` (leave it empty)

Slur fragments, slide marks and beam pieces all turn up as shapes; leaving them
empty is correct. So is leaving a shape you cannot read with confidence empty —
an unread number is counted and reported, while a guessed one becomes a wrong
note wherever that shape occurs.

    # 2. emit the score
    python3 -m scripts.tabvideo.cli clip.mp4 --out build/tab --labels build/tab/labels.json

The result is `build/tab/primitives.json` in the `TabPagePrimitives` shape from
`src/tabpdf/types.ts`, which `parseScore` reads with no special case:

    TAB_VIDEO_PRIMITIVES="build/tab/primitives.json" npx vitest run scripts/verify-tab-video.test.ts

Both passes use the remembered names described above: the first fills in whatever
it already knows, and the second keeps what you confirmed. Pass `--no-bank` to
work without either, which is what you want when checking recognition itself.

Shapes are listed commonest first, and the first pass prints how much of the
notation each prefix accounts for, so you can stop when the rest stops mattering.
On a four-minute reference video — 29 systems, 2402 marks — the whole clip comes
to 43 shapes, and the curve is steep:

| shapes named | marks covered |
| ------------ | ------------- |
| 10           | 90%           |
| 20           | 96%           |
| 38           | 99.7%         |

The tail is a handful of one-off shapes: a pair of digits kerned tightly enough
to arrive as one mark, a piece of a slide line.

This used to read 145 shapes for 1732 marks, with 40 names needed to reach 88%.
Almost all of that difference was debris rather than notation — see the ink
threshold in `staff.py`, which was set dark enough to break digits into pieces,
each piece then clustering as a shape of its own.

### Incomplete numbers are reported, not half-read

Marks too small to be a glyph are dropped, which is right for a speck of
compression noise and wrong for the small units digit of a two-digit fret: losing
that leaves the tens digit alone, spelling a bare `1` that reads as a confident
note on fret 1. On the reference video that made fret 1 a fifth of every note
read, which no guitar part does.

So a token with leftover ink beside it — the size of a dropped digit, at the
token's own height — is reported unread instead. Reading fewer notes is the point:
a gap is recoverable and a wrong note is not.

Most of what this used to catch was a symptom of the ink threshold below, and no
run on the reference clip is truncated now that digits arrive whole. The guard
stays because a genuinely dropped units digit is still possible in a smaller
engraving, and because it costs nothing when there is nothing to catch. A spike
at fret 1 in some other video is still worth treating as this problem rather
than as the music.

### Ink is measured down from the paper, not across the page

A fret number is engraved grey, not black, and at ten pixels almost none of it is
the ink's own value: the digit is held together by the midtones between the ink
and the paper.

The threshold for that was a fraction of the page's *dynamic range*, which is the
one thing on the panel that says nothing about the notation. Anything truly black
sharing the frame — a logo, a title card, the camera itself — pinned it to a
constant 140, below the body of every digit. What survived was each digit's
darkest specks: an open `0` came back as two one-pixel walls and two one-pixel
arcs, none of them glyph-shaped, so the note was not read at all. Measured over
the reference clip, that lost 40% of every mark on the page and more than half the
notes, and open strings almost entirely — one fret-0 note in four minutes.

It is measured down from the paper now, like the rule threshold. The window is
wide: every value from 160 to 200 reads the reference clip identically, bounded
below by the digit's body and above by the staff lines, which have to stay out of
this mask. Nothing else changed, and the read went from 801 notes to 1928.

### Every threshold measured downstream of it had to be re-measured

Whole glyphs are bigger than the fragments they used to arrive as, and several
constants here are ratios against glyph size, so the fix moved their inputs.
Both of the ones that matter had drifted onto the wrong side of their own
measurement:

- `JOIN_GAP_FRACTION` decides where one printed number ends. The gap between two
  notes did not change, but the font height it is divided by grew, so the
  between-notes population fell from "2.50 and up" to "1.4 and up" — and the
  threshold of 1.5 was suddenly inside it. `9` and `11` were being joined into
  "911" and then spelled out per character as three notes. Re-measured over 2193
  same-line pairs the valley is 0.8-1.3, so it is 1.0.
- Three or more digits in one run are at least two numbers, and where to cut is
  not recoverable — on this clip the `9` sits closer to the `11` than the two
  `1`s sit to each other. Those runs are reported unread rather than split.

Fret 1 was 4.1% of every note read before any of this, which no guitar part does;
it is 0.3% now. Almost all of it was invented by the two mechanisms above.

## How it works

1. `frames.py` finds the notation panel by row statistics in HSV — engraved paper
   is bright and grey, camera footage is not — then splits the timeline where the
   panel changes wholesale and median-combines several frames of each held
   system. The median is what erases a playback cursor: the highlight moves
   between samples while the notation underneath does not.
2. `staff.py` finds the long horizontal rules and the verticals crossing them.
   Rules get a far more permissive threshold than notes, because engravers draw
   staff lines much lighter than the glyphs sitting on them.
3. `glyphs.py` extracts each mark on the tab staff, splits pairs that touch,
   groups neighbours into numbers, and clusters the shapes so each one is named
   once.
4. `primitives.py` emits the geometry the parser expects. Everything after that —
   which string, which measure, which beat — is already implemented in
   `src/tabpdf/parse.ts`, which recovers rhythm from horizontal spacing.

`pipeline.py` holds steps 1-4 with no opinion about who is driving them, so the
service and the command line cannot drift apart. `fetch.py` downloads and vets the
link, `bank.py` remembers confirmed names, and `server.py` is the HTTP surface the
app talks to. It answers with primitives rather than a score, so `parse.ts` stays
the only implementation of what a tab means.

## Limits

- **Only videos that hold each system still.** Continuously scrolling notation
  has to be mosaicked into one long image first; the tool measures the drift and
  refuses rather than emitting fragments.
- **Resolution matters.** Fret digits are around ten pixels tall in a 1080p
  panel. At 480p they are not reliably recoverable.
- **Rhythm is inferred from spacing**, not read from stems and beams, so it
  follows the phrasing rather than the printed note values. The parser says as
  much in its warnings.
- **Articulations attached to a digit** — a slide line, a tie — can make it a
  separate shape from the same digit printed clean, so expect a few extra
  clusters to label.
- **Two digits printed touching cannot always be told from one number.** `56` is
  impossible as a fret and comes back as two notes; `17` is a reachable fret and
  comes back as one. Nothing in the spacing separates them — measured on the
  reference clip, the pairs read as `24` are kerned exactly like the ones read as
  `12`. A part that lives high on the neck is where this would show.
- **Repeats, D.C. and multi-voice parts** are not interpreted; systems are read
  in the order they appear.

Check the output before trusting it. `parseScore` reports `unreadCount`, and a
number well above zero means shapes were left unlabelled or a pass went wrong.

A zero, though, proves nothing. `unreadCount` counts tokens the reader *found*
and could not name; it cannot count a note that never reached it. While the ink
threshold was breaking digits into pieces the reference clip reported an
`unreadCount` of 0 and was missing 60% of its notes. The count that catches that
is how many marks came off the page at all, against how many shapes they cluster
into: notation that reads cleanly gives a few dozen shapes covering nearly every
mark, and a long tail of one-off shapes means something upstream is producing
debris.

## What reaches the parser

Only the staves themselves and their barlines, not every ruled line on the page.

Two things forced that. A notation staff and one stray rule below it are six
nearly-evenly-spaced lines, which used to read as a second tab staff — putting a
phantom staff on a third of the systems and feeding note heads into recognition.
And because the parser walks rules in order, where a run of one accepts any gap,
an irregular rule just above a staff would start its own run and then swallow the
staff's first line, hiding the staff altogether.

The cost is that the notation staff is not emitted, so the parser cannot pair one
with a tab staff. Nothing here needs it: barlines are emitted directly, and bend
marks are read from a band measured off the tab staff.

## Copyright

Videos and the transcriptions in them are usually copyrighted. Nothing fetched or
produced here is committed to the repository, and `scripts/verify-tab-video.test.ts`
skips unless pointed at a local file. Keep extracted material to personal study
unless you have the rights to it.
