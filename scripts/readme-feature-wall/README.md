# README feature wall

The root `README.md` splits 40 capability rows into a six-row **Atomic Verifiable Runtime**
showcase directly after the user metrics and a 34-row table after the complete **Get started**
section. Together they cover all 27 core lessons from the
[Atomic crash course](https://github.com/bastani-inc/atomic-crash-course), three distinct
workflow-use paths, and all ten Extras A.1 through A.10. One manifest owns the exact 6+34
order, and every row has its own real recording.

Nothing here is mocked. Every frame is the installed `atomic` binary driven by real
keystrokes in a real terminal, answering with real model output. Clips are trimmed and
sped up for pace, and one field is masked for privacy. No UI, tool output, workflow state,
or model response is fabricated.

## Layout

| Path | What it is |
|---|---|
| `manifest.json` | The single source of truth: exact six-feature and 34-remaining order, 40 exact lesson labels, optional visible `display_title`, public Atomic docs and crash-course links, capture-source paths, copy, interactions, media paths, render windows, and privacy notes |
| `tapes/<id>.tape` | The visible beats for one row, in VHS tape syntax |
| `tapes/<id>.prepare.sh` | Optional off-camera setup for one row; it may seed lesson files but never visible output |
| `lib/theme.tape` | Shared terminal size, font, and colours |
| `lib/workspace.sh` | Throwaway HOME and clean crash-course clone per row |
| `capture.sh` | Records one or more rows |
| `render.sh` | Raw capture to shipped GIF and JPG poster; optional ordered segments can cut dead time from one real recording |
| `contact-sheet.sh` | 3x3 review grids that honor GIF frame delays, plus a longest-held-frame report |
| `visual-review.md` | Fresh 40/40 sampled-frame review for feature relevance, crop, readability, and privacy |
| `build-readme.mjs` | Generates both marked README regions from the manifest; `--check` fails when either is stale |
| `validate.mjs` | The independent gate for the exact split, placement, hierarchy, links, unique coverage, local 19 + 28 + 15 badge contract, SVG shape, and all media and privacy rules |

Intermediates (raw 1080p captures, frames, sheets) live outside the repository, under
`$FW_BUILD`, default `/private/tmp/atomic-feature-wall`. Only the final GIFs and posters
are committed, under `assets/feature-wall/`.

## Ordering and links

The first generated region begins directly after the user metrics under the exact heading
`## Atomic Verifiable Runtime`. Its order is:

```text
W.1 → 6.2 → 6.5 → 6.4 → 5.3 → 6.6
```

6.6 keeps the crash-course identity `6.6 Security review with a repair loop`, its Workflows
docs link, and the real `27-security-review-repair-loop` media. Only its visible README title
uses `display_title: "Verification built in"`.

The featured region links to `#more-atomic-capabilities`. The second generated region follows
the complete `## Get started` section and contains every other row in this exact order:

```text
A.8 → A.10 → W.3 → 5.2 → 5.4 → A.9 → A.5 → 5.5 → 5.1 → A.6
→ 6.3 → 6.1 → W.2 → 2.2 → 1.2 → 1.3 → A.2 → 3.2 → 3.3 → 4.3
→ 3.1 → 3.4 → 4.2 → 4.1 → 2.1 → 2.3 → 1.1 → 1.4 → 5.6 → A.7
→ A.4 → A.3 → A.1 → 3.5
```

The stable markers are `feature-wall:featured:start/end` and
`feature-wall:more:start/end`. Do not hand-edit content between them. Each manifest row
owns a course-bound `lesson`, `title`, `docs.label`, and full `docs.url`; only a declared
`display_title` can change the visible `<h4>`. `build-readme.mjs` renders the public link as
`Atomic docs · <label>` above the unchanged crash-course lesson link. `validate.mjs` keeps
an independent copy of the exact split, order, display override, and docs mapping, and
proves all 40 records and all 80 media paths appear once across the two tables.

## Running it

```bash
scripts/readme-feature-wall/capture.sh A.1        # record one row
scripts/readme-feature-wall/capture.sh --all      # record everything
scripts/readme-feature-wall/contact-sheet.sh raw A.1   # pick a trim window
scripts/readme-feature-wall/contact-sheet.sh gif --all # review shipped timelines and holds
scripts/readme-feature-wall/render.sh --all       # encode GIFs and posters
node scripts/readme-feature-wall/build-readme.mjs # regenerate both feature tables
node scripts/readme-badges/generate.mjs           # regenerate local badge assets and README groups
node scripts/readme-feature-wall/validate.mjs     # run the independent feature + badge gate
```

`capture.sh` needs a logged-in Atomic and the VHS toolchain (`vhs`, `ffmpeg`, `gifski`,
`tesseract`). Nothing here installs anything.

### Capturing row 6.5 on its own

6.5 demonstrates durability by really killing the session, and it matches the process by
name. Recording it beside another capture would kill that capture too. Record it alone.

## How privacy is handled

The scope is deliberately narrow. The owner of this repository decided that their own
name, personal file names, unrelated session or workflow-run names, and ordinary local
paths are fine on screen. What must never ship is a **credential** or the operator's
**provider/model label**. Everything below serves those two.

1. **A throwaway HOME per row.** `$FW_BUILD/capture-homes/<id>` holds only `auth.json`,
   `models-store.json`, `settings.json`, and a freshly written `trust.json`, so a capture
   cannot pick up personal skills or prompts it was never meant to run.
2. **A bare shell prompt.** `PS1='$ '` with `HISTFILE=/dev/null`: no shell history on screen.
3. **Structural plus text masking.** For clips that contain chat, a fixed first pass paints
   the provider/model segment and manifest-declared extra pane segments. A pixel pass then
   locates and paints the whole dynamic statusline band without relying on OCR. Graph-only
   or headless windows skip the band pass. A second pass paints provider/model text that
   moves through startup banners and panels,
   matching by reconstructed line and by adjacent line pairs so a terminal wrap cannot
   hide a label. Both paint existing fields with the terminal background; neither adds,
   relabels, or invents UI.

One rule learned the hard way: **watch what a command prints.** The 2.3 clip once dumped
raw session JSONL, whose header carries the provider field, and the terminal wrapped it
across two lines so no contiguous pattern matched. The tape now prints only `type`, `id`,
and `parentId`, and `lib/privacy.mjs` matches against the unwrapped text as well as the
raw text.

`validate.mjs` expands each GIF onto its declared timeline and OCRs the same bounded
sample the old full-frame decode selected, always including the first and last frame, plus
every poster. It writes only those sampled PNGs, removes each clip's files at once, and
removes its temporary root even if decoding or OCR fails. It fails on a provider/model
label or a credential pattern. `FW_OCR_SAMPLES` raises or lowers the per-clip sample count.

`auth.json` is copied with `cp` and is never read, parsed, or printed. `validate.mjs`
enforces that too.

## Render contract

Mirrored in `manifest.json` and enforced by `validate.mjs`:

- 960x540, 16:9, downscaled 2:1 from a 1920x1080 capture with lanczos
- 12 fps, inside an allowed 10-15
- 7 to 16 seconds
- no GIF over 15 MiB, no aggregate GIF payload over 300 MiB, no poster over 500 KiB
- **gifski** encodes every shipped GIF from real capture frames. `ffmpeg` only trims,
  masks, adjusts pace, and downscales. The palette path is rejected outright: it cannot
  hold terminal text legible at a half-width README column for the same bytes.

gifski drops frames identical to their predecessor, so a 12 s clip is often far fewer than
144 stored frames while its duration and pace stay exact. The gate checks declared frame
rate, measured duration, at least 24 distinct decoded frames, at least two distinct frames
per second, and a maximum 7.5-second hold for any one decoded frame. A burst of late motion
therefore cannot hide a padded still. Contact-sheet generation also flags every hold of
three seconds or more for human review, since a shorter hold can still show irrelevant
content even when it passes the hard cap.

For a long real session, `render.segments` may list chronological trim windows from that
row's single raw recording. This removes dead time; it does not mix rows, reorder events,
or create UI output.

## Adding or changing a row

1. Edit the row entry in `manifest.json`, keeping its id, course `title`, optional visible
   `display_title`, capture source, interactions, media, crash-course anchor, and public
   Atomic docs mapping bound together.
2. Write or adjust `tapes/<id>.tape` and any exact off-camera preparation script.
3. `capture.sh <id>`, then `contact-sheet.sh raw <id>` to choose a trim window.
4. Put that window, or ordered windows from the same recording, into the row's `render`
   block, then run `render.sh <id>`.
5. Run `contact-sheet.sh gif --all`; inspect every sampled sheet, every poster, and every
   row flagged in `gif-holds.tsv` before updating `visual-review.md`.
6. Run `build-readme.mjs`, then finish with the full default `validate.mjs` gate.

The row set, 6+34 order, and public docs mapping are fixed. `validate.mjs` carries its own
copy of all 40 required ids, titles, positions, docs labels, and docs paths, so the manifest
cannot quietly redefine the contract.
