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
    cp .env.example .env          # optional: point it at a vision model
    npm run dev

`npm run dev` starts the service alongside Vite, which proxies `/api` to it. Paste
a video link into the library and it downloads and reads it. With a vision model
configured it reads the printed shapes too and the whole thing runs through to a
tab with nothing to click; without one — or for a shape the model will not commit
to — it shows you those shapes to name. Everything else in the app works without
the service running; only video links need it.

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

## Naming the shapes

Naming the shapes is the step that is not arithmetic, and one rule sits behind
every decision about it: **a wrong name becomes a wrong note everywhere that
shape occurs, while an unnamed one is counted and reported.** Those outcomes are
not comparable — a gap is recoverable and wrong music is not — so nothing here
guesses, and anything unsure abstains.

Local recognition cannot clear that bar. Fret digits are around ten pixels tall
in a 1080p panel, and measured against the shapes in the reference video that had
been named by hand:

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

What does clear it is a vision model shown the shape properly: the mark magnified
with its aspect ratio intact, and the *same mark outlined inside the number and
staff it belongs to*. The context is most of the difference — the glyph beside a
digit fixes its size and the lines under it fix the baseline, which is much of
what separates a `6` from a `5`. Point the reader at one and naming happens by
itself; point it at nothing and the app asks, exactly as it always did.

Two things keep that safe, both in `namer.py`:

- **A name needs agreement across different printings.** Each shape is shown
  several times, using marks from different systems where the video has them, and
  a name is taken only when the answers agree. A disagreement abstains outright
  rather than taking a majority: two readings of one mark is precisely when a
  name is least trustworthy.
- **Every failure is an abstention.** A timeout, a refused connection, prose
  instead of JSON, a name outside the grammar, an impossible fret, a spent time
  budget — each one leaves the shape unnamed rather than guessed at.

### Pointing it at a model

Any OpenAI-compatible vision endpoint serves; it is run here against a
self-hosted Qwen 2.5-VL. Nothing is sent anywhere unless `TABVIDEO_VLM_URL` is
set.

Settings live in a `.env` beside the app rather than in a shell, because nothing
here is started by hand — `npm run dev` starts it, and a variable that has to be
exported first is one that is missing the first time and after every reboot. Copy
`.env.example`, fill in two lines, and the app reads the shapes from then on:

    TABVIDEO_VLM_URL=http://127.0.0.1:8000/v1
    TABVIDEO_VLM_MODEL=Qwen/Qwen2.5-VL-32B-Instruct

`.env.local` is read after `.env` and wins, which is where a token belongs; both
are ignored by git. Anything already exported overrides both, so a one-off run
against a different endpoint still works. The service says on startup which way
it came up, and `/api/health` reports the same thing — the library says "reads
the printed shapes itself" instead of "shapes to name" when a model is answering.

| variable | default | meaning |
| --- | --- | --- |
| `TABVIDEO_VLM_URL` | *unset* | Base URL, e.g. `http://127.0.0.1:8000/v1`. Unset means shapes are named by hand. |
| `TABVIDEO_VLM_MODEL` | *required with the URL* | Model name as served, e.g. `Qwen/Qwen2.5-VL-32B-Instruct`. |
| `TABVIDEO_VLM_KEY` | `not-needed` | Bearer token, where the server wants one. |
| `TABVIDEO_VLM_EXEMPLARS` | `3` | Independent looks per shape. |
| `TABVIDEO_VLM_CONCURRENCY` | `4` | Requests in flight. |
| `TABVIDEO_VLM_TIMEOUT` | `60` | Seconds per call. |
| `TABVIDEO_VLM_BUDGET` | `300` | Seconds for the whole naming step; whatever is left abstains. |

Where the model runs is only a URL, so a `kubectl port-forward` and an ingress
are both just values here. Note what it changes about the service, though: it
still binds loopback and is still not exposed, but it now makes *outbound* calls
carrying crops of the notation — which is usually copyrighted — to whatever
address it is given.

Requests use constrained decoding (`guided_json`) where the server supports it
and fall back to plain JSON after one refusal, so a server without it costs one
call rather than every call.

### Measure it before trusting it

Nothing has to be run before the app; this is not a step in using it. But whether
a given model can read a given font has an answer, and it is not the model's own
confidence — nor is it obvious from the outside. Asked about the `2` inside a
printed `12` while that mark was outlined in mid-grey, Qwen 2.5-VL 72B answered
`12-`: it described the whole number and read the interrupted staff line as a
slide dash. Three looks out of three agreed, so the consensus rule passed it
through, and nothing downstream could have known. Outlining in red fixed it (see
`CONTEXT_OUTLINE`) — the point being that the failure was silent, systematic, and
found only by checking against known answers:

    python3 -m scripts.tabvideo.calibrate_namer clip.mp4 --truth build/tab/labels.json

That reads the same `.env`, bypasses the bank, scores the namer against labels
named by hand for the same video, and prints what it got right, what it got wrong
and what it declined, per shape and weighted by how many marks each covers.
**The bar is zero wrong names.** Coverage is reported but is not the measure:
abstentions cost one naming screen and are then remembered, while one wrong name
is silently wrong music — and nothing downstream can tell a confident misreading
from a correct one, which is why a model that produces any is one to replace
rather than to tune around.

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

**An unnamed technique shape always asks**, however rare it is. Both of the
thresholds that decide whether an import can finish without a person weigh a
shape by how many marks it covers, and that counts every mark as costing the
same. It does not: a digit fragment left unnamed costs the one note it decorates,
while the cluster the arcs and dashes fall into carries every hammer-on, pull-off
and slide in the piece. On the reference clip that is 73 marks against 1900 —
under 4%, so it slipped under the threshold, and the score came out with no
articulation at all while nothing asked and nothing complained. Which shapes hold
flat marks is already known, so those are exempt from the share.

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
neighbours cannot be read is counted rather than dropped, because that count is
the only thing that can say articulation went missing.

Which two notes those are is decided by the arc's *height*. An arc is printed
over the string it belongs to, and nothing else says which string that is:
reaching left and right for the nearest number picks one on another string as
soon as two strings are played in parallel, which this notation does constantly,
and the search for its partner then runs along the wrong line and comes back
empty. Measured over the clip's 46 arcs, 41 of the 43 that have a same-string
pair beneath them sit 0.41–0.57 staff spaces above its baseline, in one tight
band. Choosing the string by height agrees with the old rule on every arc it
settled (34) and settles 8 more, leaving 3 genuinely unattached.

### Most legato figures have no arc at all

The bigger source of hammer-ons is not the arcs, it is the numbers. A legato pair
is engraved with its two frets pressed together, and this font usually draws no
arc over them: `79` is a hammer-on from 7 to 9, and `911` is a 9 hammering to 11.
The clip prints 111 of these and every one used to come out as unrelated notes,
or — where the digits happened to spell a playable fret — as one wrong note.

Spacing cannot separate them from a real two-digit fret. Measured on the clip,
digits inside a legato pair sit at gap/height 0.00–0.07 and digits inside a
genuine two-digit fret at 0.00–0.74, median 0.07: not two overlapping
populations, the same population. The fretboard separates them instead. A run's
digits are divided into playable frets, fewest tokens winning, which is the
assumption the grouping already made — digits belong to one number unless they
cannot. `91` is no fret, so `911` has one short reading. A tie (`121` is a 12 then
a 1, or a 1 then a 21) is reported unread. That recovered 114 hammer-ons, 7
pull-offs and 14 previously unreadable runs.

Where the frets of that figure are placed matters as much as finding them, and
the engraving is precise about it: **a figure is set with its last fret in the
column, the earlier ones hanging left of it.** Measured over the clip, a lone
number printed on a neighbouring string inside a figure's box sits at the centre
of that last fret, every family agreeing to a hundredth:

| the figure's frets | e.g.     | neighbour sits at | that fret's centre |
| ------------------ | -------- | ----------------- | ------------------ |
| 1 digit + 1        | `57`     | 0.76 of the box (83 of them) | 0.75    |
| 1 digit + 2        | `912`    | 0.64–0.66         | 0.67               |
| 2 digits + 2       | `1719`   | 0.78              | 0.75               |
| three of 2 digits  | `181618` | 0.86              | 0.83               |

The note that is *struck*, though, is the figure's **first** fret. So leaving the
frets where they are drawn puts the chord alongside the wrong one: a strum of
`7655` whose top string hammers to 7 came out as a lone 5, then a chord of `765`
with the 7 in it. The figure is shifted to put its first fret in the column, and
the rest follow — a claim about time rather than ink, and the only place here
where a note is moved off where it was printed. Of the clip's 99 legato figures
printed inside a chord, 12 used to strum with their column and all 99 now do.

Aligning on the box's centre instead is the tempting near-miss: it works for two
one-digit frets, where centre and last-fret differ by less than the parser's
tolerance, and drifts out of reach as the figure gets wider — 96 of 99, failing
exactly on `1719` and `181618`.

### The last case: two digits that spell a fret and a figure alike

`24` is fret 24, and equally a hammer-on from 2 to 4. Both are on the fretboard,
so fewest-tokens takes the fret, and on this clip that is wrong five times. `12`
is worse: the clip prints it 94 times, 91 of them really fret 12 and three of them
a hammer-on from 1 to 2. So there is no answer to give for the *pattern* — one
verdict for `12` is wrong either three times or ninety-one. The unit has to be the
printing.

Two measurements settle it, and a printing is split only where both agree.

**Its bar.** A bar that lives on frets 0 to 2 does not contain a fret 12. So a
printing is suspect where its joined reading falls further outside the range of
frets its bar plays than that range is wide, while every fret of the split reading
falls inside it. No threshold — the bar sets its own scale, and a bar that roams
the neck is hard to surprise. Other printings of the same digits are left out of
the evidence, or two `12`s in one bar would vouch for each other, which on this
clip they would: both are the hammer-on. Over 275 contested printings this picks
out eight, the five `24`s and the three `12`s, and nothing else.

**Its column.** A legato figure is set with its last fret in the column, so a lone
number on a neighbouring string inside the box lands where that fret is rather
than in the middle. All eight suspect printings have their neighbour at 0.65–0.75
of the box; all 21 unsuspected two-digit frets with a neighbour have it at
0.38–0.44. Nothing in between, and `12` appears in both groups depending on the
printing — so what separates them is the setting, not the shape of the digits.

The two are measured from different things and agree on all eight, which is what
makes acting on them safe. Where they disagree, the fret reading stands.

A vision model is asked only where nothing is printed beside the run, so the
column has nothing to say. It is not asked to confirm the rest, and that is a
measured decision rather than a saving: against Qwen 2.5-VL-72B it reads `24`
correctly and `12` wrongly at every crop from 4 to 20 staff spaces, and its own
descriptions say why — "bar with notes at frets 0, 12, and 1", "bar with repeated
4-2 legato pairs". It is judging which fret is plausible, not reading how the
digits are set, and plausibility is the question the bar has already answered
better. An earlier version of this shortlisted patterns and let the model decide
them; it split `24` correctly and would have blocked all three `12`s.

The prompt is still worth recording. Its first version returned nothing but
abstentions while describing the bar accurately — one answer read "notes mostly
low on the neck, with a 24 and a 4-2 legato" and then set `certain` false. It had
been told that hesitation was the safe answer once too often. Telling it instead
that a description which already answers the question is not an uncertain one, and
naming the specific evidence to look for, is what turned three abstentions into
three agreeing answers.

### What is not on the page cannot be read

Bar 4 of the reference clip plays `4 2` on the D string and means `4p2`; the
engraver drew no arc over it, though the same figure a string above has one. There
is nothing in the ink to find. The reader prints the two notes it can see and says
nothing about a slur, which is the only honest reading — inferring one from the
bar above is the kind of guess that becomes a wrong note somewhere else.

## Names are remembered

What makes this bearable is that it does not repeat. One video is one font at one
size, so every confirmed name is kept in `~/.noodlebox/glyph-bank.json` against the
template it was confirmed for, and the next video in that font is read without
anyone being asked anything — and without anything being sent anywhere, since the
bank is consulted before the model is.

Names carry who gave them. A person and a model are not equally authoritative
about what a glyph says, so a model's reading can never displace a name someone
confirmed, or sit beside it as a tie that gets asked about for ever; a correction
from a person overrides whatever was there, and also takes ownership of a name a
model happened to get right, so no later run can overturn it. Banks written
before any of this existed hold only hand-typed names, which is how they are
read.

Matching against a template a person already confirmed is the one recognition
regime that measured cleanly: two renderings of a character land within 0.133 of
each other while different characters start at 0.189. A match must be inside that
gap *and* clear of the nearest different name, or the shape is asked about
instead.

## Use from the command line

The service is the way to read a video. This is for working on the reader itself,
where the contact sheet and the intermediate files are what you want to look at.

Recognition runs in two passes here, with the names written into a file between
them. The CLI does not call a model — automatic naming belongs to the service, and
this is the path for looking at what recognition itself produced.

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
link, `bank.py` remembers confirmed names, `namer.py` reads the shapes the bank
does not know, and `server.py` is the HTTP surface the app talks to. It answers
with primitives rather than a score, so `parse.ts` stays the only implementation
of what a tab means.

Naming is deliberately not in `pipeline.py`. It is the one step with an outside
dependency and a policy attached — who is allowed to decide what a glyph says —
and keeping it out means the recognition path stays the same whether a model is
configured or not.

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
- **Automatic naming is only as good as the model reading it**, and agreement
  across printings bounds that without eliminating it: a model that misreads the
  same glyph the same way every time will agree with itself. That is what the
  calibration run above is for, and why it gates the feature rather than
  decorating it.

Check the output before trusting it — and more so when nobody named anything,
since a run that asked no questions also gave no chance to notice a problem. The
app says which of the two happened: a tab read this way carries a note that its
shapes were named automatically, and another giving the number of printed numbers
left unread. `parseScore` reports `unreadCount` too, and a number well above zero
means shapes were left unnamed or a pass went wrong.

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

### A legato mark cannot say which string it is on

Hammer-ons, pull-offs and slides reach the parser as the letters engravers print
below the staff — `h`, `p`, `sl.` — which is what a tab PDF looks like, so nothing
downstream has to know videos exist. The price is that the band below the staff
belongs to all six strings at once. This reader knows exactly which string a
legato figure is on, having read it off one, and the format has nowhere to put it.

The parser recovers it by asking what could actually be played: a mark goes to
the notes in its column whose string sounded a fret it can move from, in the
direction the symbol means. Usually exactly one qualifies; where a chord really
is slurred together, several do; where none does, the mark is dropped. Handing it
to the whole column instead — which is what happened before — turned a chord
whose top string hammers 5 to 7 into `5h7657` where the music reads `7655h7`, and
left stray `h`s hanging off strings that had sounded nothing to lead out of. On
the reference clip it printed 285 legato symbols, 9 of them attached to nothing;
asking what is playable prints 181, none of them stranded.

## Copyright

Videos and the transcriptions in them are usually copyrighted. Nothing fetched or
produced here is committed to the repository, and `scripts/verify-tab-video.test.ts`
skips unless pointed at a local file. Keep extracted material to personal study
unless you have the rights to it.
