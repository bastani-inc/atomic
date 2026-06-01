/**
 * Unit tests for the additive Pi runtime theme bridge in
 * `src/tui/graph-theme.ts`. The bridge accepts a live Pi `Theme`-
 * shaped object and converts its ANSI colour tokens into the hex
 * tokens consumed by every renderer in `src/tui/`.
 *
 * cross-ref:
 *   - src/tui/graph-theme.ts `deriveGraphThemeFromPiTheme`
 *   - node_modules/@bastani/atomic/src/modes/theme/theme.ts
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
    deriveGraphTheme,
    deriveGraphThemeFromPiTheme,
} from "../../packages/workflows/src/tui/graph-theme.js";

/** Mirror Pi's truecolor SGR shape. */
function truecolorFg(r: number, g: number, b: number): string {
    return `\x1b[38;2;${r};${g};${b}m`;
}
function truecolorBg(r: number, g: number, b: number): string {
    return `\x1b[48;2;${r};${g};${b}m`;
}

/** Mirror Pi's xterm-256 SGR shape. */
function indexedFg(idx: number): string {
    return `\x1b[38;5;${idx}m`;
}

const MOCHA_DEFAULTS = deriveGraphTheme({});

describe("deriveGraphThemeFromPiTheme", () => {
    test("falls back to the Catppuccin defaults when theme is absent", () => {
        assert.deepEqual(
            deriveGraphThemeFromPiTheme(undefined),
            MOCHA_DEFAULTS,
        );
        assert.deepEqual(deriveGraphThemeFromPiTheme(null), MOCHA_DEFAULTS);
        assert.deepEqual(deriveGraphThemeFromPiTheme({}), MOCHA_DEFAULTS);
    });

    test("falls back to the Catppuccin defaults when accessors are missing", () => {
        // Test mocks routinely pass `{}` as the theme argument; the
        // bridge must never crash and must produce a renderable theme.
        const out = deriveGraphThemeFromPiTheme({ unrelated: "value" });
        assert.deepEqual(out, MOCHA_DEFAULTS);
    });

    test("maps truecolor Pi tokens onto GraphTheme roles", () => {
        const fgMap: Record<string, string> = {
            accent: truecolorFg(0x12, 0x34, 0x56),
            border: truecolorFg(0x6c, 0x70, 0x86),
            borderAccent: truecolorFg(0x7f, 0x84, 0x9c),
            borderMuted: truecolorFg(0x58, 0x5b, 0x70),
            success: truecolorFg(0xa6, 0xe3, 0xa1),
            warning: truecolorFg(0xf9, 0xe2, 0xaf),
            error: truecolorFg(0xf3, 0x8b, 0xa8),
            muted: truecolorFg(0xa6, 0xad, 0xc8),
            dim: truecolorFg(0x7f, 0x84, 0x9c),
            text: truecolorFg(0xcd, 0xd6, 0xf4),
        };
        const bgMap: Record<string, string> = {
            customMessageBg: truecolorBg(0x31, 0x32, 0x44),
            toolPendingBg: truecolorBg(0x45, 0x47, 0x5a),
            selectedBg: truecolorBg(0x58, 0x5b, 0x70),
        };
        const piTheme = {
            getFgAnsi: (color: string): string => {
                const out = fgMap[color];
                if (!out) throw new Error(`Unknown theme color: ${color}`);
                return out;
            },
            getBgAnsi: (color: string): string => {
                const out = bgMap[color];
                if (!out)
                    throw new Error(`Unknown theme background color: ${color}`);
                return out;
            },
        };

        const theme = deriveGraphThemeFromPiTheme(piTheme);

        assert.equal(theme.accent, "#123456");
        assert.equal(theme.border, "#6c7086");
        assert.equal(theme.borderActive, "#7f849c");
        assert.equal(theme.borderDim, "#585b70");
        assert.equal(theme.success, "#a6e3a1");
        assert.equal(theme.warning, "#f9e2af");
        assert.equal(theme.error, "#f38ba8");
        assert.equal(theme.textMuted, "#a6adc8");
        assert.equal(theme.dim, "#7f849c");
        assert.equal(theme.text, "#cdd6f4");
        // No Pi `info` token — bridge mirrors `accent`.
        assert.equal(theme.info, "#123456");
        assert.equal(theme.backgroundPanel, "#45475a");
        assert.equal(theme.backgroundElement, "#313244");
        assert.equal(theme.selection, "#585b70");
        // `bg` and `surface` are not in the Pi token set — defaults preserved.
        assert.equal(theme.bg, MOCHA_DEFAULTS.bg);
        assert.equal(theme.surface, MOCHA_DEFAULTS.surface);
        assert.equal(theme.mauve, MOCHA_DEFAULTS.mauve);
    });

    test("decodes xterm-256 indices into the canonical palette", () => {
        // Index 196 → top-right of the 6×6×6 cube → bright red (#ff0000).
        const piTheme = {
            getFgAnsi: (color: string): string => {
                if (color === "error") return indexedFg(196);
                throw new Error("nope");
            },
        };
        const theme = deriveGraphThemeFromPiTheme(piTheme);
        assert.equal(theme.error, "#ff0000");
        // Other tokens fall back to Mocha because the accessor throws.
        assert.equal(theme.success, MOCHA_DEFAULTS.success);
        assert.equal(theme.warning, MOCHA_DEFAULTS.warning);
    });

    test("falls back when a Pi accessor throws for an unknown token", () => {
        const piTheme = {
            getFgAnsi: (color: string): string => {
                if (color === "accent") return truecolorFg(0x89, 0xb4, 0xfa);
                throw new Error(`unknown: ${color}`);
            },
        };
        const theme = deriveGraphThemeFromPiTheme(piTheme);
        // Resolved token threads through.
        assert.equal(theme.accent, "#89b4fa");
        // Every other token falls back to Mocha — the throw is contained.
        assert.equal(theme.success, MOCHA_DEFAULTS.success);
        assert.equal(theme.warning, MOCHA_DEFAULTS.warning);
        assert.equal(theme.error, MOCHA_DEFAULTS.error);
        assert.equal(theme.border, MOCHA_DEFAULTS.border);
        assert.equal(theme.text, MOCHA_DEFAULTS.text);
    });

    test("falls back when a Pi accessor returns a terminal-default reset", () => {
        // `\x1b[39m` / `\x1b[49m` mean "default colour"; the bridge has no
        // hex to bind, so it must roll back to the Mocha defaults rather
        // than emitting garbage.
        const piTheme = {
            getFgAnsi: () => "\x1b[39m",
            getBgAnsi: () => "\x1b[49m",
        };
        assert.deepEqual(deriveGraphThemeFromPiTheme(piTheme), MOCHA_DEFAULTS);
    });

    test("falls back when xterm-256 index is in the ambient (0-15) range", () => {
        // Indices 0-15 are user-configurable and have no canonical hex —
        // the bridge must fall back rather than guess.
        const piTheme = {
            getFgAnsi: () => indexedFg(7), // ambient "white"
        };
        const out = deriveGraphThemeFromPiTheme(piTheme);
        assert.deepEqual(out, MOCHA_DEFAULTS);
    });

    test("returned theme is structurally identical to deriveGraphTheme output", () => {
        // The bridge must produce the same shape so every existing
        // renderer (status-list, dispatch-confirm, etc.) keeps working.
        const piTheme = {
            getFgAnsi: () => truecolorFg(10, 20, 30),
            getBgAnsi: () => truecolorBg(40, 50, 60),
        };
        const out = deriveGraphThemeFromPiTheme(piTheme);
        const reference = deriveGraphTheme({});
        assert.deepEqual(
            Object.keys(out).sort(),
            Object.keys(reference).sort(),
        );
    });
});
