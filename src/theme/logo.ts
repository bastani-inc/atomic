/**
 * Atomic ASCII-art logo and Catppuccin gradient colorization.
 *
 * Shared between the init banner and the post-install completion screen.
 */

import {
  supportsTrueColor,
  supports256Color,
  supportsColor,
} from "../services/system/detect.ts";
import { flavors, type CatppuccinFlavor, type ColorName } from "@catppuccin/palette";

export const ATOMIC_BLOCK_LOGO = [
  "█▀▀█ ▀▀█▀▀ █▀▀█ █▀▄▀█ ▀█▀ █▀▀",
  "█▄▄█   █   █  █ █ ▀ █  █  █  ",
  "▀  ▀   ▀   ▀▀▀▀ ▀   ▀ ▀▀▀ ▀▀▀",
];

const GRADIENT_COLOR_NAMES = [
  "rosewater",
  "flamingo",
  "pink",
  "mauve",
  "lavender",
  "blue",
  "sapphire",
  "sky",
  "teal",
] as const satisfies readonly ColorName[];

function gradientFromFlavor(flavor: CatppuccinFlavor): string[] {
  return GRADIENT_COLOR_NAMES.map((name) => flavor.colors[name].hex);
}

/** Catppuccin gradient (dark terminal). */
export const GRADIENT_DARK = gradientFromFlavor(flavors.mocha);

/** Catppuccin gradient (light terminal). */
export const GRADIENT_LIGHT = gradientFromFlavor(flavors.latte);

/** 256-color approximation of the gradient. */
export const GRADIENT_256 = [224, 218, 219, 183, 147, 111, 117, 159, 115];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function interpolateHex(gradient: readonly string[], t: number): [number, number, number] {
  const pos = Math.max(0, Math.min(1, t)) * (gradient.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, gradient.length - 1);
  const frac = pos - lo;
  const [r1, g1, b1] = hexToRgb(gradient[lo]!);
  const [r2, g2, b2] = hexToRgb(gradient[hi]!);
  return [
    Math.round(r1 + (r2 - r1) * frac),
    Math.round(g1 + (g2 - g1) * frac),
    Math.round(b1 + (b2 - b1) * frac),
  ];
}

function interpolate256(gradient: number[], t: number): number {
  const pos = Math.max(0, Math.min(1, t)) * (gradient.length - 1);
  const lo = Math.floor(pos);
  return gradient[lo]!;
}

export function colorizeLineTrueColor(line: string, gradient: readonly string[]): string {
  let out = "";
  const len = line.length;
  for (let i = 0; i < len; i++) {
    const ch = line[i]!;
    if (ch === " ") {
      out += ch;
      continue;
    }
    const [r, g, b] = interpolateHex(gradient, len > 1 ? i / (len - 1) : 0);
    out += `\x1b[38;2;${r};${g};${b}m${ch}`;
  }
  return out + "\x1b[0m";
}

export function colorizeLine256(line: string, gradient: number[]): string {
  let out = "";
  const len = line.length;
  for (let i = 0; i < len; i++) {
    const ch = line[i]!;
    if (ch === " ") {
      out += ch;
      continue;
    }
    const code = interpolate256(gradient, len > 1 ? i / (len - 1) : 0);
    out += `\x1b[38;5;${code}m${ch}`;
  }
  return out + "\x1b[0m";
}

/** Print the Atomic block logo with Catppuccin gradient colorization. */
export function displayBlockBanner(): void {
  const isDark = !(process.env.COLORFGBG ?? "").startsWith("0;");
  const truecolor = supportsTrueColor();
  const color256 = supports256Color();
  const hasColor = supportsColor();

  console.log();
  for (const line of ATOMIC_BLOCK_LOGO) {
    if (truecolor) {
      const gradient = isDark ? GRADIENT_DARK : GRADIENT_LIGHT;
      console.log(`  ${colorizeLineTrueColor(line, gradient)}`);
    } else if (color256 && hasColor) {
      console.log(`  ${colorizeLine256(line, GRADIENT_256)}`);
    } else {
      console.log(`  ${line}`);
    }
  }
  console.log();
}
