---
name: effective-liteparse
description: Use this skill whenever a task involves a document file (PDF, DOCX, PPTX, XLSX, or image) and you need to read it or pull text, tables, or specific values out of it — to answer a question about its contents, look up a figure, or extract data. Provides fast, local, model-free extraction via the `lit` CLI with disciplined, low-cost search patterns.
compatibility: Requires Node 18+ and `@llamaindex/liteparse` (`npm i -g @llamaindex/liteparse`, verify `lit --version`). LibreOffice for Office files; ImageMagick for images. The bundled search.py helper needs `uv`.
license: MIT
metadata:
  author: LlamaIndex
  version: "1.0.0"
---

# Effective LiteParse

Extract text from documents locally with the `lit` CLI — a fast, model-free parser. This skill is
about using it **cheaply**: each `lit parse` re-runs full extraction, and every line you dump into
the conversation is paid for on every subsequent turn. The patterns below come from analyzing real
agent traces where the same PDF was parsed up to **9 times** and single image reads cost
**140k+ characters** of context. Don't repeat those mistakes.

## The golden rule: parse ONCE to a file, then search the file

`lit parse` re-extracts the whole document every time you call it. Re-parsing per search is the #1
waste seen in traces. Parse a document exactly once, to a temp file, then run all your searches
against that file:

```bash
# ONE TIME, per document. --no-ocr for born-digital PDFs (almost all reports) — much faster.
lit parse "/abs/path/doc.pdf" --format text --no-ocr -o /tmp/doc.txt && wc -l /tmp/doc.txt
```

Then search the file with cheap shell tools — **never** re-run `lit parse` to search again.

## Search discipline — minimize ROUND-TRIPS, then keep results small

Every Bash call is a full model round-trip (latency + re-read of context). The biggest waste after
parsing is a **serial** loop: grep → look → grep again → `sed` to read the window → grep again. In
traces this doubled the turn count versus just reading the doc. Two rules fix it:

**1. Get context in the SAME command — don't grep then `sed`.** Use `grep -C` so the surrounding
lines come back with the hit. This removes the follow-up `sed` turn for the common case:

```bash
grep -n -i -C4 "total assets" /tmp/doc.txt | head -40      # location AND its window, one turn
```

Only fall back to `sed -n 'A,Bp'` when you already know the exact line and need a *wider* window
than `-C` gave you.

**2. Batch independent lookups into ONE command.** When a question needs several distinct facts
(e.g. emissions *and* revenue), don't spend one turn per term. Probe them together with labels:

```bash
for q in "carbon intensity" "scope 1" "total revenue"; do \
  echo "=== $q ==="; grep -n -i -C3 "$q" /tmp/doc.txt | head -25; done
```

Then keep results small:

- **Always bound output** with `head` and use `-n` for line numbers.
- **Don't fan out blindly.** Aim to resolve a question in ≤3 search commands. If two targeted greps
  don't pin it down, switch to `search.py` (below) — don't keep firing keyword variations one per turn.
- Prefer **Bash `grep`/`sed` on the saved file over the Read and Grep tools** — fewer round-trips and
  you control output size precisely.

## Ranked search when keywords are uncertain (bundled helper)

When two targeted greps haven't pinned the answer, **stop greping** — don't iterate keyword variants
one turn at a time. Run the bundled BM25 ranker ONCE to surface the most relevant line-windows in a
single command:

```bash
./.claude/skills/effective-liteparse/scripts/search.py /tmp/doc.txt -q "materiality assessment priority topics" -k 8 -e 5
```

`-k` = number of matches, `-e` = lines of context around each (so the window comes back inline — no
follow-up `sed` turn). It returns ranked windows with line numbers. Use a rich natural-language query
(several synonyms in one string), not a single keyword. This replaces a long chain of speculative greps.

## Born-digital vs scanned

- **Born-digital PDF** (real text layer — nearly all corporate/finance/ESG reports): always pass
  `--no-ocr`. It's much faster and the text is identical. Leaving OCR on wastes time.
- **Scanned PDF / image**: drop `--no-ocr`. If the value is missing or digits look wrong, read the
  page visually (see below) rather than trusting OCR.

## Reading a page visually — last resort, ONE screenshot, modest DPI

Screenshots are the most expensive thing you can put in context: a single high-DPI page PNG ran
**~140k characters** in one trace, and agents often rendered the same page twice (default + hi-res).

Only screenshot when text/tables genuinely can't answer the question (dense multi-column tables,
figures, charts). Then:

- Render **one** page at a time with `--target-pages "N"` (note: it's `--target-pages`, NOT `--pages`).
- Use **modest DPI (~150–200)**. Do not start at 300+; do not re-render the same page at higher DPI
  unless the text is actually illegible.

```bash
lit screenshot "/abs/path/doc.pdf" --target-pages "13" --dpi 150 -o /tmp/shots/   # then Read the PNG
```

## Many questions about the same document

Parsing once to a file already covers this: keep the `/tmp/doc.txt` and reuse it across every
question instead of re-parsing.

## Don't waste turns on preamble

Skip `lit --version`, `ls -la`, and `lit … --help` unless something actually failed. Go straight to
the parse. Core flags you need:

`--format text|json` · `--no-ocr` · `--target-pages "1-5,10"` · `--dpi <n>` (default 150) ·
`--ocr-language <iso>`. Use `--format json` only when you need bounding boxes/layout — it's much
larger; still search it, never load it whole.

## Setup

PDFs work out of the box. If `lit` is missing: `npm i -g @llamaindex/liteparse`. Office docs need
LibreOffice; images need ImageMagick (both auto-converted to PDF).
