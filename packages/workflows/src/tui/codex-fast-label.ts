/**
 * Footer-parity Codex fast-tier label suffix.
 *
 * Mirrors `@bastani/atomic`'s `formatCodexFastModeModelLabel` (`<label> fast`
 * when the fast/priority tier applies) but is re-implemented locally so the
 * workflow TUI never imports the heavy `@bastani/atomic` package barrel into
 * its module graph. Importing that barrel here pulls the whole coding-agent
 * index — which fails to evaluate under the `pi-tui`-mocked overlay test
 * subprocesses (see overlay-adapter-hidden-render / -autowrap tests) with
 * "Export named 'formatCodexFastModeModelLabel' not found".
 *
 * cross-ref: packages/coding-agent/src/core/codex-fast-mode.ts
 */
export function codexFastModeLabel(label: string, enabled: boolean): string {
  return enabled ? `${label} fast` : label;
}
