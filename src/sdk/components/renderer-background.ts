import type { CliRenderer } from "@opentui/core";

export function setRendererBackground(
  renderer: CliRenderer,
  color: string,
  { syncTerminalDefault = false }: { syncTerminalDefault?: boolean } = {},
): void {
  renderer.setBackgroundColor(color);
  if (syncTerminalDefault) {
    process.stdout.write(wrapForTmuxIfNeeded(terminalBackgroundColorSequence(color)));
  }
}

export function requestRendererBackgroundRepaint(renderer: CliRenderer): void {
  // OpenTUI 0.1.103+ no longer syncs the renderer background to the terminal
  // default via OSC 11. Force the next frame so blank cells with this background
  // are emitted instead of being skipped as unchanged initial buffer contents.
  Object.assign(renderer, { forceFullRepaintRequested: true });
  renderer.requestRender();
}

export function resetRendererTerminalBackground(renderer: CliRenderer): void {
  if (process.env.TMUX) {
    process.stdout.write(wrapForTmuxIfNeeded("\x1b]111\x07"));
    return;
  }

  renderer.resetTerminalBgColor();
}

export function terminalBackgroundColorSequence(color: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!match) {
    throw new Error(`Cannot sync terminal background for non-hex color: ${color}`);
  }

  const hex = match[1]!;
  return `\x1b]11;rgb:${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4, 6)}\x07`;
}

export function wrapForTmuxIfNeeded(sequence: string): string {
  if (!process.env.TMUX) return sequence;

  let escaped = "";
  for (const char of sequence) {
    escaped += char === "\x1b" ? "\x1b\x1b" : char;
  }
  return `\x1bPtmux;${escaped}\x1b\\`;
}
