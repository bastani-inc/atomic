import { visibleWidth } from "@earendil-works/pi-tui";
import { matchesKey } from "./text-helpers.js";
import {
  type KeybindingsLike,
  deleteRange,
  matchesAction,
} from "./keybindings-adapter.js";
import type { PromptCardState } from "./prompt-card-state.js";

export interface GraphemePart {
  text: string;
  start: number;
  end: number;
  width: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeParts(value: string): GraphemePart[] {
  const parts: GraphemePart[] = [];
  for (const segment of segmenter.segment(value)) {
    const text = segment.segment;
    parts.push({
      text,
      start: segment.index,
      end: segment.index + text.length,
      width: visibleWidth(text),
    });
  }
  return parts;
}

export function previousGraphemeBoundary(value: string, caret: number): number {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  let prev = 0;
  for (const part of graphemeParts(value)) {
    if (part.start >= safeCaret) break;
    prev = part.start;
  }
  return prev;
}

export function nextGraphemeBoundary(value: string, caret: number): number {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  for (const part of graphemeParts(value)) {
    if (part.end > safeCaret) return part.end;
  }
  return value.length;
}

function clampGraphemeBoundary(value: string, caret: number): number {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  if (safeCaret === value.length) return safeCaret;
  for (const part of graphemeParts(value)) {
    if (part.start === safeCaret) return safeCaret;
    if (part.start > safeCaret) break;
  }
  return previousGraphemeBoundary(value, safeCaret);
}

export function isPrintableText(data: string): boolean {
  return data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data);
}

export function insertText(state: PromptCardState, text: string): void {
  const caret = Math.max(0, Math.min(state.caret, state.rawText.length));
  state.rawText = state.rawText.slice(0, caret) + text + state.rawText.slice(caret);
  state.caret = caret + text.length;
}

export function matchesTextAction(
  keybindings: KeybindingsLike | undefined,
  data: string,
  action: string,
  fallback?: Parameters<typeof matchesKey>[1],
): boolean {
  return matchesAction(keybindings, data, action) || (fallback !== undefined && matchesKey(data, fallback));
}

export function matchesAnyKey(
  data: string,
  keys: readonly Parameters<typeof matchesKey>[1][],
): boolean {
  return keys.some((key) => matchesKey(data, key));
}

export function applyDeleteRange(state: PromptCardState, start: number, end: number, caret: number): void {
  const result = deleteRange(state.rawText, start, end, caret);
  state.rawText = result.text;
  state.caret = result.caret;
}

function visualColumnAt(text: string, caret: number): number {
  return visibleWidth(text.slice(0, clampGraphemeBoundary(text, caret)));
}

function offsetAtVisualColumn(text: string, targetCol: number): number {
  let col = 0;
  for (const part of graphemeParts(text)) {
    const width = part.width;
    if (col + width > targetCol) return part.start;
    col += width;
  }
  return text.length;
}

export function caretLineUp(raw: string, caret: number): number | null {
  const safe = clampGraphemeBoundary(raw, caret);
  const lineStartOffset = raw.lastIndexOf("\n", safe - 1) + 1;
  if (lineStartOffset === 0) return null;
  const prevLineEnd = lineStartOffset - 1;
  const prevLineStart = raw.lastIndexOf("\n", prevLineEnd - 1) + 1;
  const col = visualColumnAt(raw.slice(lineStartOffset, safe), raw.slice(lineStartOffset, safe).length);
  const prevLine = raw.slice(prevLineStart, prevLineEnd);
  return prevLineStart + offsetAtVisualColumn(prevLine, col);
}

export function caretLineDown(raw: string, caret: number): number | null {
  const safe = clampGraphemeBoundary(raw, caret);
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
