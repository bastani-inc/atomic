import { Container, Text, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ATOMIC_WORKING_BOLD_PHASES,
	ATOMIC_WORKING_FRAME_MS,
	ATOMIC_WORKING_FRAMES,
	ATOMIC_WORKING_PHASES,
	AtomicWorkedStatusComponent,
	AtomicWorkingLoader,
	AtomicWorkingStatusComponent,
	atomicWorkingFrame,
	atomicWorkingGlyph,
	resetAtomicWorkingClock,
	watchAtomicWorkingClock,
} from "../src/modes/interactive/components/atomic-working-status.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import { formatWorkingMeta } from "../src/modes/interactive/components/working-run-meter.ts";
import {
	WorkingStatusComponent,
	type WorkingStatusComponentOptions,
} from "../src/modes/interactive/components/working-status.ts";
import { ansi256ToHex, fgAnsi } from "../src/modes/interactive/theme/color-utils.ts";
import {
	initTheme,
	setThemeInstance,
	Theme,
	type ThemeBg,
	type ThemeColor,
} from "../src/modes/interactive/theme/theme.ts";
import { loadTheme, loadThemeFromContent, loadThemeJson } from "../src/modes/interactive/theme/theme-loading.ts";
import {
	pickWhimsicalWorkingMessage,
	WHIMSICAL_WORKING_MESSAGES,
} from "../src/modes/interactive/whimsical-messages.ts";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
const renderedContent = (loader: AtomicWorkingLoader): string => plain(loader.render(64)[1]!).trimEnd();
const rgb = (text: string): string | undefined => {
	const match = /\u001b\[38;2;(\d+);(\d+);(\d+)m/.exec(text);
	return match
		? `#${match
				.slice(1)
				.map((value) => Number(value).toString(16).padStart(2, "0"))
				.join("")}`
		: undefined;
};
const indexed = (text: string): number | undefined => {
	const match = /\u001b\[38;5;(\d+)m/.exec(text);
	return match ? Number(match[1]) : undefined;
};

const luminance = (hex: string): number => {
	const channels = hex
		.slice(1)
		.match(/../g)
		?.map((value) => Number.parseInt(value, 16) / 255);
	if (channels?.length !== 3) throw new Error(`Invalid hex color: ${hex}`);
	const [red, green, blue] = channels.map((value) =>
		value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};

const contrastRatio = (foreground: string, background: string): number => {
	const foregroundLuminance = luminance(foreground);
	const backgroundLuminance = luminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
};

const quantizedHex = (hex: string): string => {
	const match = /\u001b\[38;5;(\d+)m/.exec(fgAnsi(hex, "256color"));
	if (!match) throw new Error(`Could not quantize color: ${hex}`);
	return ansi256ToHex(Number(match[1]));
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
	it("uses a single ellipsis for built-in working labels without changing custom text (#5350)", () => {
		initTheme("dark", false);
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			expect(plain(new AtomicWorkingStatusComponent().render(80).join("\n"))).toContain("∀ Working…");
			expect(pickWhimsicalWorkingMessage()).toBe("Schlepping…");
			expect(plain(new AtomicWorkingStatusComponent({ message: "Working..." }).render(80).join("\n"))).toContain(
				"∀ Working...",
			);
			expect(plain(new AtomicWorkingStatusComponent({ message: "Custom..." }).render(80).join("\n"))).toContain(
				"Custom...",
			);
		} finally {
			random.mockRestore();
		}
	});
	it("keeps exact literal one-cell identity through the approved ten-phase ramp", () => {
		expect(ATOMIC_WORKING_FRAMES).toEqual(Array(10).fill("∀"));
		expect(ATOMIC_WORKING_FRAMES.map(visibleWidth)).toEqual(Array(10).fill(1));
		expect(ATOMIC_WORKING_BOLD_PHASES).toEqual([false, false, false, false, true, true, true, false, false, false]);
		expect(ATOMIC_WORKING_PHASES).toEqual([
			"dark",
			"lift",
			"muted",
			"accent",
			"bright",
			"peak",
			"bright",
			"accent",
			"muted",
			"lift",
		]);
	});

	it("interpolates a custom theme dark to accent to bright and back with a bold peak", () => {
		setThemeInstance(customTheme());
		const rendered = ATOMIC_WORKING_FRAMES.map(
			(_, frame) => new AtomicWorkingStatusComponent({ frame, messageColor: String }).render(64)[1]!,
		);
		expect(rendered.map(rgb)).toEqual([
			"#101010",
			"#1c2c3c",
			"#2d537a",
			"#4080c0",
			"#a1beda",
			"#f0f0f0",
			"#a1beda",
			"#4080c0",
			"#2d537a",
			"#1c2c3c",
		]);
		expect(rendered.map((line) => plain(line).trimEnd())).toEqual(Array(10).fill(" ∀ Working…"));
		expect(rendered.map((line) => line.includes("\u001b[1m"))).toEqual(ATOMIC_WORKING_BOLD_PHASES);
	});

	it("matches the approved high-contrast Catppuccin Mocha role ramp in truecolor", () => {
		setThemeInstance(loadTheme("catppuccin-mocha", "truecolor"));
		const colors = ATOMIC_WORKING_FRAMES.map((_, frame) =>
			rgb(new AtomicWorkingStatusComponent({ frame, messageColor: String }).render(64)[1]!),
		);
		expect(colors).toEqual([
			"#70759f",
			"#7f849c",
			"#789bd0",
			"#89b4fa",
			"#b8d2ff",
			"#eef4ff",
			"#b8d2ff",
			"#89b4fa",
			"#789bd0",
			"#7f849c",
		]);
	});

	it("reads a supplied caller palette lazily on every render", () => {
		setThemeInstance(loadTheme("dark", "truecolor"));
		let palette = {
			dark: "#101010",
			lift: "#202020",
			muted: "#303030",
			accent: "#4080c0",
			bright: "#a0c0e0",
			peak: "#f0f0f0",
		};
		const component = new AtomicWorkingStatusComponent({ frame: 0, palette: () => palette });
		expect(rgb(component.render(64)[1]!)).toBe("#101010");
		palette = { ...palette, dark: "#202020" };
		expect(rgb(component.render(64)[1]!)).toBe("#202020");
	});

	it("quantizes caller-supplied workflow palettes to the detected 256-color mode", () => {
		setThemeInstance(loadTheme("dark", "256color"));
		const palette = {
			dark: "#45475a",
			lift: "#6c7086",
			muted: "#789bd0",
			accent: "#89b4fa",
			bright: "#b8d2ff",
			peak: "#eef4ff",
		};
		const rendered = new AtomicWorkingStatusComponent({ frame: 0, palette, messageColor: String }).render(64)[1]!;
		// #2550: the nearest ramp entry is closer than cube index 59.
		expect(indexed(rendered)).toBe(238);
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
		const rendered = ATOMIC_WORKING_FRAMES.map(
			(_, frame) => new AtomicWorkingStatusComponent({ frame, messageColor: String }).render(64)[1]!,
		);
		expect(rendered.map((line, index) => line.includes(`\u001b[38;5;${expected[index]}m∀`))).toEqual(
			Array(10).fill(true),
		);
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

	it("keeps every outward Catppuccin pulse phase above 3:1 with increasing contrast", () => {
		const background = "#1e1e2e";
		setThemeInstance(loadTheme("catppuccin-mocha", "truecolor"));
		const truecolor = ATOMIC_WORKING_FRAMES.slice(0, 6).map((_, frame) => {
			const color = rgb(new AtomicWorkingStatusComponent({ frame, messageColor: String }).render(64)[1]!);
			if (!color) throw new Error(`Missing truecolor phase ${frame}`);
			return color;
		});

		setThemeInstance(loadTheme("catppuccin-mocha", "256color"));
		const quantized = ATOMIC_WORKING_FRAMES.slice(0, 6).map((_, frame) => {
			const color = indexed(new AtomicWorkingStatusComponent({ frame, messageColor: String }).render(64)[1]!);
			if (color === undefined) throw new Error(`Missing indexed phase ${frame}`);
			return ansi256ToHex(color);
		});
		// #2550: nearest-color quantization also considers the grayscale ramp.
		expect(quantized).toEqual(["#767676", "#8787af", "#8787d7", "#87afff", "#afd7ff", "#eeeeee"]);

		for (const [colors, phaseBackground] of [
			[truecolor, background],
			[quantized, background],
			[quantized, quantizedHex(background)],
		] as const) {
			const ratios = colors.map((color) => contrastRatio(color, phaseBackground));
			expect(ratios.every((ratio) => ratio >= 3)).toBe(true);
			expect(ratios.slice(1).every((ratio, index) => ratio > ratios[index]!)).toBe(true);
		}
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
		expect(regular.trimEnd()).toBe(" <regular>∀</regular> Working…");
		expect(bold.trimEnd()).toBe(" <bold>∀</bold> Working…");
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
			visibleWidth(message) > visibleWidth(current) ? message : current,
		);
		expect(longest).toBe("Archeologically analyzing the architecture...");
		for (const message of WHIMSICAL_WORKING_MESSAGES) {
			const lines = new AtomicWorkingStatusComponent({ frame: 5, message, messageColor: String })
				.render(64)
				.map(plain);
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

	it("renders a static raw ∀ across all ten phases under NO_COLOR while preserving custom indicator styling (#5224)", () => {
		process.env.NO_COLOR = "";
		const glyphs = ATOMIC_WORKING_FRAMES.map((_, frame) => atomicWorkingGlyph(frame));
		expect(glyphs).toEqual(Array(10).fill("∀"));
		const rendered = ATOMIC_WORKING_FRAMES.map(
			(_, frame) => new AtomicWorkingStatusComponent({ frame }).render(64)[1]!,
		);
		expect(rendered.every((line) => !line.includes("\u001b["))).toBe(true);
		expect(rendered.map((line) => line.trimEnd())).toEqual(Array(10).fill(" ∀ Working…"));
		expect(
			atomicWorkingGlyph({
				frame: 4,
				spinnerColor: (text) => `<regular>${text}</regular>`,
				spinnerBoldColor: (text) => `<bold>${text}</bold>`,
			}),
		).toBe("<bold>∀</bold>");
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

	it("does not arm the reduced-motion meta timer while an extension indicator delegate is active (#5243)", () => {
		const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
		vi.useFakeTimers();
		process.env.ATOMIC_REDUCED_MOTION = "1";
		try {
			const requestRender = vi.fn();
			const loader = new AtomicWorkingLoader({ requestRender } as never, undefined, String, "Working...", {
				frames: ["*"],
			});
			loader.setMeta(() => ({ elapsedMs: 3_000, tokens: 0 }));
			expect(renderedContent(loader)).toBe(" * Working...");
			const callsAfterSetup = requestRender.mock.calls.length;
			vi.advanceTimersByTime(3_000);
			expect(requestRender).toHaveBeenCalledTimes(callsAfterSetup);
			loader.stop();
		} finally {
			restoreEnv("ATOMIC_REDUCED_MOTION", previousReducedMotion);
		}
	});

	it("drives main loader, chat host, and tool-block glyphs from one shared 88ms clock with no leaked listeners (#5224)", () => {
		vi.useFakeTimers();
		setThemeInstance(loadTheme("catppuccin-mocha", "truecolor"));
		const mainRenders = vi.fn();
		const hostRenders = vi.fn();
		const blockOneRenders = vi.fn();
		const blockTwoRenders = vi.fn();
		const loader = new AtomicWorkingLoader({ requestRender: mainRenders } as never, undefined, String, "Working...");
		const host = new ChatSessionHost({
			style: {
				dim: String,
				text: String,
				textMuted: String,
				accent: String,
				accentBold: String,
				workingIndicatorUseGlobalTheme: true,
				rule: (_hex, text) => text,
				cursor: () => "",
				blank: (width) => " ".repeat(width),
				editorRuleColor: () => "#ffffff",
			},
			editorTheme: {
				borderColor: String,
				selectList: {
					selectedPrefix: String,
					selectedText: String,
					description: String,
					scrollInfo: String,
					noMatch: String,
				},
			},
			requestRender: hostRenders,
		});
		let unsubOne: (() => void) | undefined;
		let unsubTwo: (() => void) | undefined;
		try {
			host.applyAgentEvent({ type: "agent_start" } as never);
			unsubOne = watchAtomicWorkingClock(blockOneRenders);
			unsubTwo = watchAtomicWorkingClock(blockTwoRenders);

			expect(vi.getTimerCount()).toBe(1);
			expect(atomicWorkingFrame()).toBe(0);

			vi.advanceTimersByTime(352);
			expect(atomicWorkingFrame()).toBe(4);
			expect(rgb(loader.render(64)[1]!)).toBe("#b8d2ff");
			expect(rgb(host.renderWorkingStatus(64)[1]!)).toBe("#b8d2ff");
			expect(rgb(atomicWorkingGlyph())).toBe("#b8d2ff");
			expect(rgb(atomicWorkingGlyph(atomicWorkingFrame()))).toBe("#b8d2ff");
			expect(blockOneRenders).toHaveBeenCalledTimes(4);
			expect(blockTwoRenders).toHaveBeenCalledTimes(4);

			resetAtomicWorkingClock();
			expect(atomicWorkingFrame()).toBe(0);
			expect(rgb(loader.render(64)[1]!)).toBe("#70759f");
			expect(rgb(host.renderWorkingStatus(64)[1]!)).toBe("#70759f");
			expect(rgb(atomicWorkingGlyph())).toBe("#70759f");
			expect(vi.getTimerCount()).toBe(1);

			unsubOne();
			unsubOne();
			const blockOneAfterUnsub = blockOneRenders.mock.calls.length;
			vi.advanceTimersByTime(88);
			expect(atomicWorkingFrame()).toBe(1);
			expect(blockOneRenders).toHaveBeenCalledTimes(blockOneAfterUnsub);
			expect(blockTwoRenders).toHaveBeenCalledTimes(5);
			expect(vi.getTimerCount()).toBe(1);

			unsubTwo();
			loader.stop();
			expect(vi.getTimerCount()).toBe(1);
			host.dispose();
			expect(vi.getTimerCount()).toBe(0);
			expect(atomicWorkingFrame()).toBe(0);

			const sharedCallback = vi.fn();
			const firstSame = watchAtomicWorkingClock(sharedCallback);
			const secondSame = watchAtomicWorkingClock(sharedCallback);
			expect(vi.getTimerCount()).toBe(1);
			firstSame();
			firstSame();
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(88);
			expect(atomicWorkingFrame()).toBe(1);
			expect(sharedCallback).toHaveBeenCalledTimes(1);
			secondSame();
			expect(vi.getTimerCount()).toBe(0);
			expect(atomicWorkingFrame()).toBe(0);
		} finally {
			unsubOne?.();
			unsubTwo?.();
			loader.stop();
			host.dispose();
		}
	});

	it("new loaders and quick turns join an active shared phase without starving its cadence (#5224)", () => {
		vi.useFakeTimers();
		resetAtomicWorkingClock();
		const releaseSibling = watchAtomicWorkingClock(() => {});
		let loader: AtomicWorkingLoader | undefined;
		try {
			vi.advanceTimersByTime(176);
			expect(atomicWorkingFrame()).toBe(2);
			loader = new AtomicWorkingLoader({ requestRender() {} } as never, undefined, String, "first");
			expect(atomicWorkingFrame()).toBe(2);
			for (let index = 0; index < 5; index++) {
				vi.advanceTimersByTime(40);
				loader.resetForTurn(`turn ${index}`);
			}
			expect(atomicWorkingFrame()).toBe(4);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			loader?.stop();
			releaseSibling();
		}
	});

	it("normalizes legacy outputTokens metadata across public working status boundaries (#5224)", () => {
		const legacyMeta: NonNullable<WorkingStatusComponentOptions["meta"]> = {
			elapsedMs: 134_000,
			outputTokens: 18_400,
			note: "esc to cancel",
		};
		expect(formatWorkingMeta(legacyMeta)).toBe("2m 14s · ↓ 18.4k tokens · esc to cancel");
		const workingRow = plain(
			new WorkingStatusComponent({ message: "Working...", meta: legacyMeta }).render(80)[1]!,
		).trimEnd();
		expect(workingRow).toBe(" ∀ Working... (2m 14s · ↓ 18.4k tokens · esc to cancel)");
		const atomicRow = plain(
			new AtomicWorkingStatusComponent({ message: "Working...", meta: legacyMeta }).render(80)[1]!,
		).trimEnd();
		expect(atomicRow).toBe(" ∀ Working... (2m 14s · ↓ 18.4k tokens · esc to cancel)");
		const workedRow = plain(
			new AtomicWorkedStatusComponent({ message: "Brewing...", snapshot: legacyMeta }).render(80)[1]!,
		).trimEnd();
		expect(workedRow).toBe(" ∀ Brewed for 2m 14s · ↓ 18.4k tokens");
	});
});
