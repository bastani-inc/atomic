import { visibleWidth } from "./text-helpers.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

export function previousGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  let prev = 0;
  for (const s of graphemeSegmenter.segment(text)) {
    if (s.index >= c) break;
    prev = s.index;
  }
  return prev;
}

export function nextGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  for (const s of graphemeSegmenter.segment(text)) {
    if (s.index >= c) return Math.min(text.length, s.index + s.segment.length);
    if (s.index + s.segment.length > c) return s.index + s.segment.length;
  }
  return text.length;
}

export function clampGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  if (c === text.length) return c;
  for (const s of graphemeSegmenter.segment(text)) {
    if (s.index === c) return c;
    if (s.index > c) break;
  }
  return previousGraphemeOffset(text, c);
}

function visualColumn(text: string, caret: number): number {
  return visibleWidth(text.slice(0, clampGraphemeOffset(text, caret)));
}

function offsetAtVisualColumn(text: string, targetCol: number): number {
  let col = 0;
  for (const s of graphemeSegmenter.segment(text)) {
    const w = visibleWidth(s.segment);
    if (col + w > targetCol) return s.index;
    col += w;
  }
  return text.length;
}

export function isPrintableGrapheme(data: string): boolean {
  if (data.length === 0 || data.includes("\x1b")) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return graphemes(data).length === 1;
}

/**
 * Move the caret one logical line up inside a multi-line text field.
 * Returns the new caret offset, or `null` when the caret is already on
 * the first logical line — that's the boundary signal the caller uses to
 * fall through to focus-prev. The visual cell column is preserved across
 * lines, matching pi-tui Editor behaviour for CJK/emoji-width text.
 */
export function caretLineUp(raw: string, caret: number): number | null {
  const safe = clampGraphemeOffset(raw, caret);
  const lineStart = raw.lastIndexOf("\n", safe - 1) + 1;
  if (lineStart === 0) return null; // first logical line — boundary
  const prevLineEnd = lineStart - 1;
  const prevLineStart = raw.lastIndexOf("\n", prevLineEnd - 1) + 1;
  const colInLine = visualColumn(raw.slice(lineStart, safe), safe - lineStart);
  const prevLine = raw.slice(prevLineStart, prevLineEnd);
  return prevLineStart + offsetAtVisualColumn(prevLine, colInLine);
}

/**
 * Move the caret one logical line down inside a multi-line text field.
 * Returns the new caret offset, or `null` when the caret is already on
 * the last logical line.
 */
export function caretLineDown(raw: string, caret: number): number | null {
  const safe = clampGraphemeOffset(raw, caret);
  const nextNl = raw.indexOf("\n", safe);
  if (nextNl === -1) return null; // last logical line — boundary
  const lineStart = raw.lastIndexOf("\n", safe - 1) + 1;
  const colInLine = visualColumn(raw.slice(lineStart, safe), safe - lineStart);
  const nextLineStart = nextNl + 1;
  const nextNlAfter = raw.indexOf("\n", nextLineStart);
  const nextLineEnd = nextNlAfter === -1 ? raw.length : nextNlAfter;
  const nextLine = raw.slice(nextLineStart, nextLineEnd);
  return nextLineStart + offsetAtVisualColumn(nextLine, colInLine);
}

// ── Bracketed paste handling ─────────────────────────────────────────────
// Pi's host terminal enables bracketed paste mode and forwards the wrap
// markers verbatim to our editor. Wrappers from xterm-compatible
// terminals — same constants pi-tui's Editor uses.
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/**
 * `true` when `data` is a multi-character chunk that looks like raw
 * pasted text (no escape sequences, only printable + LF/TAB). Used as a
 * fallback for hosts that don't enable bracketed paste — bursts of
 * printable input are still treated as paste rather than ignored, while
 * single keystrokes continue to flow through the normal key router.
 */
export function isPrintableTextChunk(data: string): boolean {
  if (data.includes("\x1b")) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0);
    if (code === undefined) return false;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

