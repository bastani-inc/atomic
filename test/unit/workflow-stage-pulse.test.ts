import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { refreshColorEnvironment } from "../../packages/coding-agent/src/modes/interactive/theme/color-utils.js";
import {
	getBuiltinThemes,
	loadTheme,
	loadThemeFromContent,
} from "../../packages/coding-agent/src/modes/interactive/theme/theme-loading.js";
import {
	deriveGraphTheme,
	deriveGraphThemeFromPiTheme,
	type GraphTheme,
} from "../../packages/workflows/src/tui/graph-theme.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";

const statuses = [
	["running", "warning"],
	["awaiting_input", "info"],
] as const;
const steps = 20;

function border(theme: GraphTheme, status: "running" | "awaiting_input", step: number, focused = false): string {
	const stage = { id: "build", name: "build", status, parentIds: [], toolEvents: [] };
	const bottom = renderNodeCard(stage, { theme, pulsePhase: step / steps, focused }).at(-1)!;
	return bottom.slice(0, bottom.indexOf("╰")).replace("\x1b[49m", "");
}

function rgb(fg: string): number[] {
	const match = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(fg);
	assert.ok(match, JSON.stringify(fg));
	return match.slice(1).map(Number);
}

afterEach(() => {
	refreshColorEnvironment();
});

test("indexed stage pulses dim the same status slot instead of choosing another palette colour (#5596)", () => {
	for (const env of [{ FORCE_COLOR: "2" }, {}]) {
		refreshColorEnvironment(env);
		for (const name of ["system", ...Object.keys(getBuiltinThemes())]) {
			const host = loadTheme(name, "256color");
			const theme = deriveGraphThemeFromPiTheme(host);
			for (const [status, role] of statuses) {
				const index = Number(/;5;(\d+)m$/.exec(host.getFgAnsi(role === "info" ? "accent" : role))![1]);
				const fg = index < 16 ? `\x1b[${index < 8 ? 30 + index : 90 + index - 8}m` : `\x1b[38;5;${index}m`;
				assertPalettePulse(theme, status, fg);
			}
		}
	}
});

test("basic-colour stage borders use one native hue, and an open graph drops both colour and faint under NO_COLOR (#5596)", () => {
	for (const name of ["system", ...Object.keys(getBuiltinThemes())]) {
		refreshColorEnvironment({ FORCE_COLOR: "1" });
		const theme = deriveGraphThemeFromPiTheme(loadTheme(name, "truecolor"));
		const warning = border(theme, "running", 0, true);
		assert.match(warning, /^\x1b\[(?:33|93)m$/, `${name} yellow`);
		const info = border(theme, "awaiting_input", 0, true);
		assert.match(info, /^\x1b\[(?:3[0-7]|9[0-7])m$/, `${name} info`);
		assertPalettePulse(theme, "running", warning);
		assertPalettePulse(theme, "awaiting_input", info);
		refreshColorEnvironment({ NO_COLOR: "1", FORCE_COLOR: "3" });
		for (const [status] of statuses) {
			for (let step = 0; step <= steps; step++) {
				assert.equal(border(theme, status, step), "");
				assert.equal(border(theme, status, step, true), "");
			}
		}
	}
});

test("custom warning and info tokens, not fixed status colours, select the basic palette slots (#5596)", () => {
	refreshColorEnvironment({ FORCE_COLOR: "1" });
	const base = getBuiltinThemes().dark!;
	const custom = { ...base, colors: { ...base.colors, warning: "#00ffff", accent: "#ff00ff" } };
	const theme = deriveGraphThemeFromPiTheme(
		loadThemeFromContent("contrast.json", JSON.stringify(custom), "truecolor"),
	);
	assertPalettePulse(theme, "running", "\x1b[96m");
	assertPalettePulse(theme, "awaiting_input", "\x1b[95m");
});

function assertPalettePulse(theme: GraphTheme, status: "running" | "awaiting_input", fg: string): void {
	const intensity: number[] = [];
	for (let step = 0; step <= steps; step++) {
		const frame = border(theme, status, step);
		assert.equal(frame.replace("\x1b[2m", ""), fg);
		intensity.push(frame.includes("\x1b[2m") ? 0 : 1);
		assert.equal(border(theme, status, step, true), fg);
	}
	assert.equal(intensity[0], 0);
	assert.equal(intensity[steps / 2], 1);
	assert.equal(intensity[steps], 0);
	for (let i = 1; i <= steps; i++) {
		assert.ok(i <= steps / 2 ? intensity[i]! >= intensity[i - 1]! : intensity[i]! <= intensity[i - 1]!);
	}
}

test("black status ink stays neutral and visibly pulses on a high-contrast light canvas (#5596)", () => {
	refreshColorEnvironment({ FORCE_COLOR: "3" });
	const theme = deriveGraphTheme({ warning: "#000000", info: "#000000", bg: "#ffffff", borderDim: "#ff00ff" });
	for (const [status] of statuses) {
		const shades = Array.from({ length: steps + 1 }, (_, step) => {
			const [r, g, b] = rgb(border(theme, status, step));
			assert.equal(r, g);
			assert.equal(r, b);
			assert.deepEqual(rgb(border(theme, status, step, true)), [0, 0, 0]);
			return r!;
		});
		assert.ok(shades[0]! > 0 && shades[0]! < 255);
		assert.equal(shades[steps / 2], 0);
		assert.equal(shades[steps], shades[0]);
		for (let i = 1; i <= steps; i++) {
			assert.ok(i <= steps / 2 ? shades[i]! <= shades[i - 1]! : shades[i]! >= shades[i - 1]!);
		}
	}
});

test("a one-step RGB status still pulses without losing its only coloured channel (#5596)", () => {
	refreshColorEnvironment({ FORCE_COLOR: "3" });
	const theme = deriveGraphTheme({ warning: "#010100", info: "#000001", bg: "#ffffff" });
	for (const [status] of statuses) {
		assertPalettePulse(theme, status, border(theme, status, steps / 2, true));
	}
});

test("stage borders breathe in their own hue for a full cycle and hold that hue at full brightness when focused (#5596)", () => {
	refreshColorEnvironment({ FORCE_COLOR: "3" });
	const themes = Object.keys(getBuiltinThemes()).map((name) =>
		deriveGraphThemeFromPiTheme(loadTheme(name, "truecolor")),
	);
	themes.push(deriveGraphTheme(), deriveGraphTheme({ warning: "#ffff00", info: "#00ffff", borderDim: "#ff00ff" }));
	for (const theme of themes) {
		for (const [status, role] of statuses) {
			const peak = theme[role]
				.slice(1)
				.match(/../g)!
				.map((byte) => Number.parseInt(byte, 16));
			const levels: number[] = [];
			for (let step = 0; step <= steps; step++) {
				const actual = rgb(border(theme, status, step));
				const scale = Math.max(...actual) / Math.max(...peak);
				for (const [channel, value] of actual.entries()) {
					assert.ok(
						Math.abs(value - peak[channel]! * scale) <= 1,
						`${status} ${theme[role]} at ${step}: ${actual}`,
					);
				}
				levels.push(scale);
				assert.deepEqual(rgb(border(theme, status, step, true)), peak);
			}
			assert.ok(levels[0]! > 0 && levels[0]! < 1, "the quiet border is visible but dimmed");
			assert.equal(levels[steps / 2], 1);
			assert.equal(levels[steps], levels[0]);
			for (let i = 1; i <= steps; i++) {
				assert.ok(i <= steps / 2 ? levels[i]! >= levels[i - 1]! : levels[i]! <= levels[i - 1]!);
			}
		}
	}
});
