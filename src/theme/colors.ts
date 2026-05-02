import { supportsColor, supportsTrueColor } from "../services/system/detect.ts";
import { flavors, type ColorName } from "@catppuccin/palette";

/**
 * ANSI color and formatting codes for CLI output
 * Respects the NO_COLOR environment variable
 */
const ANSI_CODES = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
} as const;

const NO_COLORS = {
  bold: "",
  dim: "",
  reset: "",
  red: "",
  green: "",
  yellow: "",
  blue: "",
} as const;

export const COLORS = supportsColor() ? ANSI_CODES : NO_COLORS;

// ---------------------------------------------------------------------------
// Catppuccin Mocha palette — shared across all CLI commands
//
// Truecolor terminals get the full palette via 24-bit ANSI SGR; legacy
// terminals degrade to basic ANSI; NO_COLOR emits plain text.
// ---------------------------------------------------------------------------

export type PaletteKey = "text" | "dim" | "accent" | "success" | "error" | "warning" | "mauve" | "info";

export function paletteRgb(name: ColorName): readonly [number, number, number] {
  const { r, g, b } = flavors.mocha.colors[name].rgb;
  return [r, g, b];
}

export const PALETTE: Record<PaletteKey, readonly [number, number, number]> = {
  text:    paletteRgb("text"),
  dim:     paletteRgb("overlay1"),
  accent:  paletteRgb("blue"),
  success: paletteRgb("green"),
  error:   paletteRgb("red"),
  warning: paletteRgb("yellow"),
  mauve:   paletteRgb("mauve"),
  info:    paletteRgb("sky"),
};

export interface PaintOptions {
  bold?: boolean;
}

export type Paint = (key: PaletteKey, text: string, opts?: PaintOptions) => string;

/**
 * Build a colour-aware painter for the current terminal.
 *
 * Truecolor terminals get the full Catppuccin palette; legacy terminals
 * degrade to basic ANSI; NO_COLOR emits plain text. The optional `bold`
 * flag adds weight contrast — essential for typographic hierarchy in a
 * monospace medium where size and family are fixed.
 */
export function createPainter(): Paint {
  if (supportsTrueColor()) {
    return (key, text, opts) => {
      const [r, g, b] = PALETTE[key];
      const sgr = opts?.bold
        ? `\x1b[1;38;2;${r};${g};${b}m`
        : `\x1b[38;2;${r};${g};${b}m`;
      return `${sgr}${text}\x1b[0m`;
    };
  }
  if (supportsColor()) {
    const ANSI: Record<PaletteKey, string> = {
      text:    "",
      dim:     "\x1b[2m",
      accent:  "\x1b[34m",
      success: "\x1b[32m",
      error:   "\x1b[31m",
      warning: "\x1b[33m",
      mauve:   "\x1b[35m",
      info:    "\x1b[36m",
    };
    return (key, text, opts) => {
      const weight = opts?.bold ? "\x1b[1m" : "";
      return `${weight}${ANSI[key]}${text}\x1b[0m`;
    };
  }
  return (_key, text) => text;
}
