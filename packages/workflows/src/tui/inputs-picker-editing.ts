import {
  graphemes,
  graphemeSegments,
  visibleWidth,
} from "./text-helpers.js";

export function previousGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  let prev = 0;
  for (const s of graphemeSegments(text)) {
    if (s.index >= c) break;
    prev = s.index;
  }
  return prev;
}

export function nextGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  for (const s of graphemeSegments(text)) {
    if (s.index >= c) return Math.min(text.length, s.index + s.segment.length);
    if (s.index + s.segment.length > c) return s.index + s.segment.length;
  }
  return text.length;
}

export function clampGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  if (c === text.length) return c;
  for (const s of graphemeSegments(text)) {
    if (s.index === c) return c;
    if (s.index > c) break;
  }
  return previousGraphemeOffset(text, c);
}

export function headToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  for (const g of graphemes(text)) {
    const w = visibleWidth(g);
    if (used + w > width) break;
    out += g;
    used += w;
  }
  return out;
}

export function tailToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  const gs = graphemes(text);
  for (let i = gs.length - 1; i >= 0; i--) {
    const g = gs[i]!;
    const w = visibleWidth(g);
    if (used + w > width) break;
    out = g + out;
    used += w;
  }
  return out;
}

export function isPrintableGrapheme(data: string): boolean {
  if (data.length === 0 || data.includes("\x1b")) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return graphemes(data).length === 1;
}

export interface TextLayoutLine {
  text: string;
  start: number;
  end: number;
}

export function layoutEditableText(raw: string, usable: number): TextLayoutLine[] {
  const width = Math.max(1, Math.floor(usable));
  const lines: TextLayoutLine[] = [];
  let line = "";
  let lineStart = 0;
  let lineWidth = 0;
  for (const s of graphemeSegments(raw)) {
    const offset = s.index;
    const g = s.segment;
    if (g === "\n") {
      lines.push({ text: line, start: lineStart, end: offset });
      line = "";
      lineStart = offset + g.length;
      lineWidth = 0;
      continue;
    }
    const w = visibleWidth(g);
    if (line !== "" && lineWidth + w > width) {
      lines.push({ text: line, start: lineStart, end: offset });
      line = "";
      lineStart = offset;
      lineWidth = 0;
    }
    line += g;
    lineWidth += w;
    if (lineWidth >= width) {
      lines.push({ text: line, start: lineStart, end: offset + g.length });
      line = "";
      lineStart = offset + g.length;
      lineWidth = 0;
    }
  }
  lines.push({ text: line, start: lineStart, end: raw.length });
  return lines;
}

function visualColumnAt(text: string, caret: number): number {
  return visibleWidth(text.slice(0, clampGraphemeOffset(text, caret)));
}

function offsetAtVisualColumn(text: string, targetCol: number): number {
  let col = 0;
  for (const s of graphemeSegments(text)) {
    const w = visibleWidth(s.segment);
    if (col + w > targetCol) return s.index;
    col += w;
  }
  return text.length;
}

export function caretLineUp(raw: string, caret: number): number | null {
  const safe = clampGraphemeOffset(raw, caret);
  const lineStartOffset = raw.lastIndexOf("\n", safe - 1) + 1;
  if (lineStartOffset === 0) return null;
  const prevLineEnd = lineStartOffset - 1;
  const prevLineStart = raw.lastIndexOf("\n", prevLineEnd - 1) + 1;
  const col = visualColumnAt(raw.slice(lineStartOffset, safe), raw.slice(lineStartOffset, safe).length);
  const prevLine = raw.slice(prevLineStart, prevLineEnd);
  return prevLineStart + offsetAtVisualColumn(prevLine, col);
}

export function caretLineDown(raw: string, caret: number): number | null {
  const safe = clampGraphemeOffset(raw, caret);
  const nextNl = raw.indexOf("\n", safe);
  if (nextNl === -1) return null;
  const lineStartOffset = raw.lastIndexOf("\n", safe - 1) + 1;
  const col = visualColumnAt(raw.slice(lineStartOffset, safe), raw.slice(lineStartOffset, safe).length);
  const nextLineStart = nextNl + 1;
  const nextNlAfter = raw.indexOf("\n", nextLineStart);
  const nextLineEnd = nextNlAfter === -1 ? raw.length : nextNlAfter;
  const nextLine = raw.slice(nextLineStart, nextLineEnd);
  return nextLineStart + offsetAtVisualColumn(nextLine, col);
}
