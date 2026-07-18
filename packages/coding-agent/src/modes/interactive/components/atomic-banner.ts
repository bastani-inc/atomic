import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../theme/theme.ts";

const ATOMIC_FORALL_BANNER_LINES: readonly string[] = [
  "  ██████▙                  ▟██████  ",
  "   ██████▙                ▟██████   ",
  "    ██████▙              ▟██████    ",
  "     ██████▙            ▟██████     ",
  "      ████████████████████████      ",
  "       ██████▛        ▜██████       ",
  "        ██████▛      ▜██████        ",
  "         ██████▛    ▜██████         ",
  "          ██████▛  ▜██████          ",
  "            ████████████            ",
];

const SHADOW_CHAR = "░";

export function renderAtomicAnsiBanner(
  theme: Theme,
  thinkingLevel: ThinkingLevel,
): string[] {
  const colorize = theme.getThinkingBorderColor(thinkingLevel);
  const shadow = (text: string) => theme.fg("dim", text);

  const blankLine = " ".repeat(ATOMIC_FORALL_BANNER_LINES[0]?.length ?? 0);

  return [...ATOMIC_FORALL_BANNER_LINES, blankLine].map((line, row) => {
    const chars = [...line];
    const previousLine = ATOMIC_FORALL_BANNER_LINES[row - 1];
    if (previousLine !== undefined) {
      for (const [column, char] of [...previousLine].entries()) {
        const shadowColumn = column + 1;
        if (char !== " " && chars[shadowColumn] === " ") {
          chars[shadowColumn] = SHADOW_CHAR;
        }
      }
    }

    return chars
      .map((char) =>
        char === SHADOW_CHAR ? shadow(char) : theme.bold(colorize(char)),
      )
      .join("");
  });
}

/**
 * Compose the logo art with the identity meta column. Side-by-side only when
 * every combined row fits maxWidth (a wrapped row would shred the logo art
 * mid-line); otherwise stack the meta lines under the logo, and drop the art
 * entirely when the terminal is narrower than the logo itself.
 */
export function composeStartupIdentity(
  markLines: readonly string[],
  metaLines: readonly string[],
  maxWidth?: number,
): string {
  const markWidth = Math.max(...markLines.map((line) => visibleWidth(line)));
  const metaWidth = Math.max(...metaLines.map((line) => visibleWidth(line)));

  if (maxWidth === undefined || maxWidth >= markWidth + 2 + metaWidth) {
    return markLines
      .map((line, index) => `${line}  ${metaLines[index] ?? ""}`.trimEnd())
      .join("\n");
  }
  if (maxWidth >= markWidth) {
    return [...markLines, ...metaLines].join("\n");
  }
  return metaLines.join("\n");
}
