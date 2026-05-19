import {
  matchesKey as piMatchesKey,
  truncateToWidth as piTruncateToWidth,
  visibleWidth,
  type KeyId,
} from "@earendil-works/pi-tui";
import { decodePrintableKey as piDecodePrintableKey } from "@earendil-works/pi-tui/dist/keys.js";

export { visibleWidth };

const ANSI_ESCAPE_RE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x1b]*(?:\x1b\\))/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function readAnsiCode(text: string, offset: number): string | null {
  const match = ANSI_ESCAPE_RE.exec(text.slice(offset));
  return match?.[0] ?? null;
}

/**
 * Compatibility wrapper over pi-tui's ANSI-aware truncation helper.
 *
 * The workflows TUI historically exposed a fourth `preserveAnsi` parameter.
 * pi-tui now preserves active ANSI runs by default; keep the old signature so
 * existing workflow renderers can move to the upstream primitive without a
 * broad call-site churn. The fourth argument is intentionally not forwarded to
 * pi-tui because pi-tui uses that slot for `pad`.
 */
export function truncateToWidth(
  text: string,
  width: number,
  suffix = "",
  _preserveAnsi = false,
): string {
  return piTruncateToWidth(text, width, suffix, false);
}

/** Use pi-tui's key parser/matcher while preserving the local string API. */
export function matchesKey(data: string, key: string): boolean {
  return data === key || piMatchesKey(data, key as KeyId);
}

/** Decode CSI-u / Kitty printable-key sequences emitted by terminals such as VSCode. */
export function decodePrintableKey(data: string): string | undefined {
  return piDecodePrintableKey(data);
}

export function sliceColumns(
  line: string,
  startCol: number,
  length: number,
  strict = false,
): string {
  if (length <= 0) return "";

  const endCol = startCol + length;
  let result = "";
  let currentCol = 0;
  let offset = 0;
  let pendingAnsi = "";

  while (offset < line.length) {
    const ansiCode = readAnsiCode(line, offset);
    if (ansiCode) {
      if (currentCol >= startCol && currentCol < endCol) {
        result += ansiCode;
      } else if (currentCol < startCol) {
        pendingAnsi += ansiCode;
      }
      offset += ansiCode.length;
      continue;
    }

    let textEnd = offset;
    while (textEnd < line.length && !readAnsiCode(line, textEnd)) {
      textEnd++;
    }

    for (const { segment } of segmenter.segment(line.slice(offset, textEnd))) {
      const width = visibleWidth(segment);
      const inRange = currentCol >= startCol && currentCol < endCol;
      const fits = !strict || currentCol + width <= endCol;

      if (inRange && fits) {
        if (pendingAnsi) {
          result += pendingAnsi;
          pendingAnsi = "";
        }
        result += segment;
      }

      currentCol += width;
      if (currentCol >= endCol) break;
    }

    offset = textEnd;
    if (currentCol >= endCol) break;
  }

  return result;
}
