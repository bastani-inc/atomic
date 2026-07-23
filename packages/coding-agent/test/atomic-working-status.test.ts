import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ATOMIC_WORKING_BOLD_PHASES,
	ATOMIC_WORKING_FRAME_MS,
	ATOMIC_WORKING_FRAMES,
	ATOMIC_WORKING_PHASES,
	AtomicWorkingLoader,
	AtomicWorkingStatusComponent,
	atomicWorkingFrame,
} from "../src/modes/interactive/components/atomic-working-status.ts";
import { WorkingStatusComponent } from "../src/modes/interactive/components/working-status.ts";
import {
	initTheme,
	setThemeInstance,
	Theme,
	type ThemeBg,
	type ThemeColor,
} from "../src/modes/interactive/theme/theme.ts";
import { loadTheme, loadThemeFromContent, loadThemeJson } from "../src/modes/interactive/theme/theme-loading.ts";
import { WHIMSICAL_WORKING_MESSAGES } from "../src/modes/interactive/whimsical-messages.ts";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
const renderedContent = (loader: AtomicWorkingLoader): string => plain(loader.render(64)[1]!).trimEnd();
const rgb = (text: string): string | undefined => {
	const match = /\u001b\[38;2;(\d+);(\d+);(\d+)m/.exec(text);
	return match ? `#${match.slice(1).map((value) => Number(value).toString(16).padStart(2, "0")).join("")}` : undefined;
};
const indexed = (text: string): number | undefined => {
	const match = /\u001b\[38;5;(\d+)m/.exec(text);
	return match ? Number(match[1]) : undefined;
};

function restoreEnv(name: "ATOMIC_REDUCED_MOTION" | "NO_COLOR", value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function customTheme(): Theme {
	return new Theme(
		{ dim: "#303030", accent: "#4080c0", text: "#f0f0f0" } as Record<ThemeColor, string>,
		{ selectedBg: "#101010" } as Record<ThemeBg, string>,
		"truecolor",
		{ name: "spinner-test" },
	);
}

afterEach(() => {
	vi.useRealTimers();
	delete process.env.ATOMIC_REDUCED_MOTION;
	delete process.env.NO_COLOR;
	initTheme("dark");
});

describe("Atomic working status", () => {
	it("keeps exact literal one-cell identity through the approved ten-phase ramp", () => {
		expect(ATOMIC_WORKING_FRAMES).toEqual(Array(10).fill("∀"));
		expect(ATOMIC_WORKING_FRAMES.map(visibleWidth)).toEqual(Array(10).fill(1));
		expect(ATOMIC_WORKING_BOLD_PHASES).toEqual([
			false, false, false, false, true, true, true, false, false, false,
		]);
		expect(ATOMIC_WORKING_PHASES).toEqual([
			"dark", "lift", "muted", "accent", "bright",
			"peak", "bright", "accent", "muted", "lift",
		]);
	});

	it("interpolates a custom theme dark to accent to bright and back with a bold peak", () => {
		setThemeInstance(customTheme());
		const rendered = ATOMIC_WORKING_FRAMES.map((_, frame) =>
			new AtomicWorkingStatusComponent({ frame, messageColor: String }).render(64)[1]!,
		);
		expect(rendered.map(rgb)).toEqual([
			"#101010", "#1c2c3c", "#2d537a", "#4080c0", "#a1beda",
			"#f0f0f0", "#a1beda", "#4080c0", "#2d537a", "#1c2c3c",
		]);
		expect(rendered.map((line) => plain(line).trimEnd())).toEqual(Array(10).fill(" ∀ Working..."));
		expect(rendered.map((line) => line.includes("\u001b[1m"))).toEqual(ATOMIC_WORKING_BOLD_PHASES);
	});

	it("matches the approved high-contrast Catppuccin Mocha role ramp in truecolor", () => {
		setThemeInstance(loadTheme("catppuccin-mocha", "truecolor"));
		const colors = ATOMIC_WORKING_FRAMES.map((_, frame) =>
			rgb(new AtomicWorkingStatusComponent({ frame, messageColor: String }).render(64)[1]!),
		);
		expect(colors).toEqual([
			"#6c7086", "#7f849c", "#789bd0", "#89b4fa", "#b8d2ff",
			"#eef4ff", "#b8d2ff", "#89b4fa", "#789bd0", "#7f849c",
		]);
	});

	it("reads a supplied caller palette lazily on every render", () => {
		setThemeInstance(loadTheme("dark", "truecolor"));
		let palette = {
			dark: "#101010", lift: "#202020", muted: "#303030",
			accent: "#4080c0", bright: "#a0c0e0", peak: "#f0f0f0",
		};
		const component = new AtomicWorkingStatusComponent({ frame: 0, palette: () => palette });
		expect(rgb(component.render(64)[1]!)).toBe("#101010");
		palette = { ...palette, dark: "#202020" };
		expect(rgb(component.render(64)[1]!)).toBe("#202020");
	});

	it("quantizes caller-supplied workflow palettes to the detected 256-color mode", () => {
		setThemeInstance(loadTheme("dark", "256color"));
		const palette = {
			dark: "#45475a", lift: "#6c7086", muted: "#789bd0",
			accent: "#89b4fa", bright: "#b8d2ff", peak: "#eef4ff",
		};
		const rendered = new AtomicWorkingStatusComponent({ frame: 0, palette, messageColor: String }).render(64)[1]!;
		expect(indexed(rendered)).toBe(59);
		expect(rgb(rendered)).toBeUndefined();
	});

	it("accepts partial working-indicator palettes and derives omitted tones", () => {
		const source = {
			...loadThemeJson("catppuccin-mocha"),
			name: "partial-spinner",
			workingIndicator: { accent: "#ff0000" },
		};
		setThemeInstance(loadThemeFromContent("partial-spinner.json", JSON.stringify(source), "truecolor"));
		const accent = new AtomicWorkingStatusComponent({ frame: 3, messageColor: String }).render(64)[1]!;
		const muted = new AtomicWorkingStatusComponent({ frame: 2, messageColor: String }).render(64)[1]!;
		expect(rgb(accent)).toBe("#ff0000");
		expect(rgb(muted)).toBe("#b51c24");
	});

	it("preserves configured ANSI indices 0 through 15 exactly", () => {
		const source = {
			...loadThemeJson("dark"),
			name: "indexed-spinner",
			workingIndicator: { dark: 1, lift: 2, muted: 3, accent: 4, bright: 5, peak: 6 },
		};
		setThemeInstance(loadThemeFromContent("indexed-spinner.json", JSON.stringify(source), "256color"));
		const expected = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2];
		const rendered = ATOMIC_WORKING_FRAMES.map((_, frame) =>
			new AtomicWorkingStatusComponent({ frame, messageColor: String }).render(64)[1]!,
		);
		expect(rendered.map((line, index) => line.includes(`\u001b[38;5;${expected[index]}m∀`))).toEqual(Array(10).fill(true));
	});

	it("derives omitted tones from standard ANSI indices while preserving explicit indices", () => {
		const derivedMuted = (accent: number): { accent: number | undefined; muted: string | undefined } => {
			const source = {
				...loadThemeJson("catppuccin-mocha"),
				name: `partial-index-${accent}`,
				workingIndicator: { accent },
			};
			setThemeInstance(loadThemeFromContent("partial-index.json", JSON.stringify(source), "truecolor"));
			return {
				accent: indexed(new AtomicWorkingStatusComponent({ frame: 3, messageColor: String }).render(64)[1]!),
				muted: rgb(new AtomicWorkingStatusComponent({ frame: 2, messageColor: String }).render(64)[1]!),
			};
		};
		const red = derivedMuted(1);
		const blue = derivedMuted(4);
		expect(red.accent).toBe(1);
		expect(blue.accent).toBe(4);
		expect(red.muted).not.toBe(blue.muted);
	});

	it("keeps the Catppuccin outward pulse readable after 256-color quantization", () => {
		setThemeInstance(loadTheme("catppuccin-mocha", "256color"));
		const colors = ATOMIC_WORKING_FRAMES.slice(0, 6).map((_, frame) =>
			indexed(new AtomicWorkingStatusComponent({ frame, messageColor: String }).render(64)[1]!),
		);
		expect(colors).toEqual([60, 103, 104, 111, 153, 231]);
	});

	it("uses live dark and light theme roles and follows dynamic theme changes", () => {
		const components = [0, 3].map((frame) => new AtomicWorkingStatusComponent({ frame }));
		setThemeInstance(loadTheme("dark", "truecolor"));
		const dark = components.map((component) => rgb(component.render(64)[1]!));
		setThemeInstance(loadTheme("light", "truecolor"));
		const light = components.map((component) => rgb(component.render(64)[1]!));
		expect(dark).toEqual(["#666666", "#8abeb7"]);
		expect(light).toEqual(["#767676", "#5a8080"]);
		expect(light).not.toEqual(dark);
	});

	it("preserves explicit legacy regular and bold styling options", () => {
		const regular = new WorkingStatusComponent({
			frame: 0,
			spinnerColor: (text) => `<regular>${text}</regular>`,
			spinnerBoldColor: (text) => `<bold>${text}</bold>`,
			messageColor: String,
		}).render(64)[1]!;
		const bold = new WorkingStatusComponent({
			frame: 4,
			spinnerColor: (text) => `<regular>${text}</regular>`,
			spinnerBoldColor: (text) => `<bold>${text}</bold>`,
			messageColor: String,
		}).render(64)[1]!;
		expect(regular.trimEnd()).toBe(" <regular>∀</regular> Working...");
		expect(bold.trimEnd()).toBe(" <bold>∀</bold> Working...");
	});

	it("uses an exact 88ms cadence with a ten-phase 880ms cycle", () => {
		expect(ATOMIC_WORKING_FRAME_MS).toBe(88);
		expect(atomicWorkingFrame(0)).toBe(0);
		expect(atomicWorkingFrame(87)).toBe(0);
		expect(atomicWorkingFrame(88)).toBe(1);
		expect(atomicWorkingFrame(439)).toBe(4);
		expect(atomicWorkingFrame(440)).toBe(5);
		expect(atomicWorkingFrame(879)).toBe(9);
		expect(atomicWorkingFrame(880)).toBe(0);
	});

	it("renders one identity cell and keeps every randomized message in 64 columns", () => {
		expect(WHIMSICAL_WORKING_MESSAGES).toHaveLength(453);
		const longest = WHIMSICAL_WORKING_MESSAGES.reduce((current, message) =>
			visibleWidth(message) > visibleWidth(current) ? message : current);
		expect(longest).toBe("Archeologically analyzing the architecture...");
		for (const message of WHIMSICAL_WORKING_MESSAGES) {
			const lines = new AtomicWorkingStatusComponent({ frame: 5, message, messageColor: String }).render(64).map(plain);
			expect(lines).toHaveLength(2);
			expect(lines[1]!.trimEnd()).toBe(` ∀ ${message}`);
			expect(lines[1]!.match(/∀/g)).toEqual(["∀"]);
			expect(lines.every((line) => visibleWidth(line) <= 64)).toBe(true);
		}
	});

	it("keeps the main status container compact beside existing history", () => {
		const root = new Container();
		root.addChild(new Text("history-1\nhistory-2", 0, 0));
		root.addChild(new AtomicWorkingStatusComponent({ frame: 0, message: "Schlepping...", messageColor: String }));
		const lines = root.render(64).map(plain);
		expect(lines.slice(0, 2).map((line) => line.trimEnd())).toEqual(["history-1", "history-2"]);
		expect(lines.slice(2).map((line) => line.trimEnd())).toEqual(["", " ∀ Schlepping..."]);
	});

	it("restores phase zero with a fresh 88ms cadence after an extension override", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const loader = new AtomicWorkingLoader({ requestRender } as never, undefined, String, "Working...");
		expect(renderedContent(loader)).toBe(" ∀ Working...");
		vi.advanceTimersByTime(352);
		expect(loader.render(64)[1]).toContain("\u001b[1m");
		loader.setIndicator({ frames: ["X"] });
		expect(renderedContent(loader)).toBe(" X Working...");
		const callsAfterReplacement = requestRender.mock.calls.length;
		vi.advanceTimersByTime(176);
		expect(requestRender).toHaveBeenCalledTimes(callsAfterReplacement);
		loader.setIndicator();
		expect(loader.render(64)[1]).not.toContain("\u001b[1m");
		vi.advanceTimersByTime(87);
		expect(requestRender).toHaveBeenCalledTimes(callsAfterReplacement);
		vi.advanceTimersByTime(1);
		expect(requestRender).toHaveBeenCalledTimes(callsAfterReplacement + 1);
		loader.stop();
	});

	it("preserves extension frames and cadence verbatim", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const loader = new AtomicWorkingLoader(
			{ requestRender } as never,
			(text) => `[${text}]`,
			String,
			"Extension status",
			{ frames: ["X", "Y"], intervalMs: 137 },
		);
		expect(renderedContent(loader)).toBe(" X Extension status");
		const callsAfterStart = requestRender.mock.calls.length;
		vi.advanceTimersByTime(136);
		expect(renderedContent(loader)).toBe(" X Extension status");
		expect(requestRender).toHaveBeenCalledTimes(callsAfterStart);
		vi.advanceTimersByTime(1);
		expect(renderedContent(loader)).toBe(" Y Extension status");
		expect(requestRender).toHaveBeenCalledTimes(callsAfterStart + 1);
		loader.stop();
	});

	it("keeps regular/bold activity under NO_COLOR without foreground escapes", () => {
		process.env.NO_COLOR = "";
		const rendered = ATOMIC_WORKING_FRAMES.map((_, frame) =>
			new AtomicWorkingStatusComponent({ frame }).render(64)[1]!,
		);
		expect(rendered.every((line) => !line.includes("\u001b[38;"))).toBe(true);
		expect(rendered.every((line) => plain(line).trimEnd() === " ∀ Working...")).toBe(true);
		expect(rendered.map((line) => line.includes("\u001b[1m"))).toEqual(ATOMIC_WORKING_BOLD_PHASES);
	});

	it("renders a static regular accent identity with no timer under reduced motion", () => {
		const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
		vi.useFakeTimers();
		process.env.ATOMIC_REDUCED_MOTION = "1";
		setThemeInstance(customTheme());
		try {
			const requestRender = vi.fn();
			const loader = new AtomicWorkingLoader({ requestRender } as never, undefined, String, "Working...");
			expect(atomicWorkingFrame(800)).toBe(3);
			expect(rgb(loader.render(64)[1]!)).toBe("#4080c0");
			expect(loader.render(64)[1]).not.toContain("\u001b[1m");
			expect(vi.getTimerCount()).toBe(0);
			loader.start();
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(800);
			expect(requestRender).not.toHaveBeenCalled();
			loader.stop();
		} finally {
			restoreEnv("ATOMIC_REDUCED_MOTION", previousReducedMotion);
		}
	});
});
