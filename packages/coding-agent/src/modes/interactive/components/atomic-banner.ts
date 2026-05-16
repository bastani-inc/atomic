import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Theme } from "../theme/theme.js";

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
