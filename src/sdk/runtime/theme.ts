/**
 * Terminal color theme using Catppuccin palettes.
 *
 * Uses OpenTUI's built-in dark/light mode detection (via the renderer's
 * themeMode property) to select the appropriate palette:
 * - Mocha for dark terminals (and as fallback)
 * - Latte for light terminals
 */

import type { ThemeMode } from "@opentui/core";
import { flavors, type CatppuccinFlavor } from "@catppuccin/palette";

// ---------------------------------------------------------------------------
// Theme type
// ---------------------------------------------------------------------------

export interface TerminalTheme {
  bg: string;
  backgroundPanel: string;
  backgroundElement: string;
  surface: string;
  selection: string;
  border: string;
  borderDim: string;
  accent: string;
  text: string;
  textMuted: string;
  dim: string;
  info: string;
  success: string;
  error: string;
  warning: string;
  mauve: string;
}

function buildTerminalTheme(flavor: CatppuccinFlavor): TerminalTheme {
  const { colors } = flavor;
  return {
    bg: colors.base.hex,
    backgroundPanel: colors.mantle.hex,
    backgroundElement: colors.crust.hex,
    surface: colors.surface0.hex,
    selection: colors.surface1.hex,
    border: colors.overlay0.hex,
    borderDim: colors.surface2.hex,
    accent: colors.blue.hex,
    text: colors.text.hex,
    textMuted: flavor.dark ? colors.subtext0.hex : colors.subtext1.hex,
    dim: colors.overlay1.hex,
    info: colors.sky.hex,
    success: colors.green.hex,
    error: colors.red.hex,
    warning: colors.yellow.hex,
    mauve: colors.mauve.hex,
  };
}

const CATPPUCCIN_MOCHA = buildTerminalTheme(flavors.mocha);
const CATPPUCCIN_LATTE = buildTerminalTheme(flavors.latte);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the terminal theme from the renderer's detected theme mode.
 * Returns Catppuccin Latte for light terminals, Mocha for dark or unknown.
 */
export function resolveTheme(mode: ThemeMode | null): TerminalTheme {
  return mode === "light" ? CATPPUCCIN_LATTE : CATPPUCCIN_MOCHA;
}
