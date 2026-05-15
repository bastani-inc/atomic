import {
  matchesKey as piMatchesKey,
  truncateToWidth as piTruncateToWidth,
  visibleWidth,
  type KeyId,
} from "@earendil-works/pi-tui";

export { visibleWidth };

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
  return piMatchesKey(data, key as KeyId);
}
