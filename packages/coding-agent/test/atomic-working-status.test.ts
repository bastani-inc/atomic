import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ATOMIC_WORKING_BOLD_PHASES,
	ATOMIC_WORKING_FRAME_MS,
	ATOMIC_WORKING_FRAMES,
	AtomicWorkingLoader,
	AtomicWorkingStatusComponent,
	atomicWorkingFrame,
} from "../src/modes/interactive/components/atomic-working-status.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { WHIMSICAL_WORKING_MESSAGES } from "../src/modes/interactive/whimsical-messages.ts";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
const renderedContent = (loader: AtomicWorkingLoader): string => plain(loader.render(64)[1]!).trimEnd();

function restoreEnv(name: "ATOMIC_REDUCED_MOTION", value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Atomic working status", () => {
	it("keeps the exact one-cell identity fixed through regular, bold, regular phases", () => {
		initTheme("dark");
		expect(ATOMIC_WORKING_FRAMES).toEqual(["∀", "∀", "∀"]);
		expect(ATOMIC_WORKING_BOLD_PHASES).toEqual([false, true, false]);
		expect(ATOMIC_WORKING_FRAMES.map(visibleWidth)).toEqual([1, 1, 1]);

		const rendered = [0, 1, 2].map((frame) =>
			new AtomicWorkingStatusComponent({
				frame,
				spinnerColor: String,
				spinnerBoldColor: (text) => `\u001b[1m${text}\u001b[22m`,
				messageColor: String,
			}).render(64)[1]!,
		);
		expect(rendered).toHaveLength(3);
		expect(rendered.map((line) => plain(line).trimEnd())).toEqual([
			" ∀ Working...",
			" ∀ Working...",
			" ∀ Working...",
		]);
		expect(rendered[0]).not.toContain("\u001b[1m");
		expect(rendered[1]).toContain("\u001b[1m");
		expect(rendered[2]).not.toContain("\u001b[1m");
	});

	it("uses an exact 80ms cadence with a three-phase cycle", () => {
		const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
		delete process.env.ATOMIC_REDUCED_MOTION;
		try {
			expect(ATOMIC_WORKING_FRAME_MS).toBe(80);
			expect(atomicWorkingFrame(0)).toBe(0);
			expect(atomicWorkingFrame(79)).toBe(0);
			expect(atomicWorkingFrame(80)).toBe(1);
			expect(atomicWorkingFrame(159)).toBe(1);
			expect(atomicWorkingFrame(160)).toBe(2);
			expect(atomicWorkingFrame(239)).toBe(2);
			expect(atomicWorkingFrame(240)).toBe(0);
		} finally {
			restoreEnv("ATOMIC_REDUCED_MOTION", previousReducedMotion);
		}
	});

	it("renders one literal identity cell before one message row with origin/main loader geometry", () => {
		initTheme("dark");
		for (const width of [100, 64]) {
			const lines = new AtomicWorkingStatusComponent({
				frame: 0,
				message: "Schlepping...",
				spinnerColor: String,
				messageColor: String,
			}).render(width).map(plain);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("");
			expect(lines[1]!.trimEnd()).toBe(" ∀ Schlepping...");
			expect(lines[1]!.match(/∀/g)).toEqual(["∀"]);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("fits all 453 restored whimsical messages at 64 columns", () => {
		expect(WHIMSICAL_WORKING_MESSAGES).toHaveLength(453);
		const longest = WHIMSICAL_WORKING_MESSAGES.reduce((current, message) =>
			visibleWidth(message) > visibleWidth(current) ? message : current);
		expect(longest).toBe("Archeologically analyzing the architecture...");
		for (const message of WHIMSICAL_WORKING_MESSAGES) {
			const lines = new AtomicWorkingStatusComponent({ frame: 0, message, spinnerColor: String, messageColor: String })
				.render(64).map(plain);
			expect(lines).toHaveLength(2);
			expect(lines[1]!.trimEnd()).toBe(` ∀ ${message}`);
			expect(lines.every((line) => visibleWidth(line) <= 64)).toBe(true);
		}
	});

	it("keeps the main status container compact beside existing history", () => {
		const root = new Container();
		root.addChild(new Text("history-1\nhistory-2", 0, 0));
		root.addChild(new AtomicWorkingStatusComponent({ frame: 0, message: "Schlepping...", spinnerColor: String, messageColor: String }));
		const lines = root.render(64).map(plain);
		expect(lines.slice(0, 2).map((line) => line.trimEnd())).toEqual(["history-1", "history-2"]);
		expect(lines.slice(2).map((line) => line.trimEnd())).toEqual(["", " ∀ Schlepping..."]);
	});

	it("routes the glyph and message through their supplied theme colorizers", () => {
		const spinnerColor = vi.fn((text: string) => `\u001b[31m${text}\u001b[39m`);
		const messageColor = vi.fn((text: string) => `\u001b[2m${text}\u001b[22m`);
		const lines = new AtomicWorkingStatusComponent({ frame: 0, message: "Working...", spinnerColor, messageColor }).render(64);
		expect(spinnerColor).toHaveBeenCalledWith("∀");
		expect(messageColor).toHaveBeenCalledWith("Working...");
		expect(plain(lines[1]!).trimEnd()).toBe(" ∀ Working...");
	});

	it("restores the default at regular phase zero with a fresh 80ms cadence after an override", () => {
		const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
		vi.useFakeTimers();
		delete process.env.ATOMIC_REDUCED_MOTION;
		const activeTheme = (globalThis as Record<symbol, typeof theme>)[Symbol.for("@bastani/atomic:theme")]!;
		const bold = vi.spyOn(activeTheme, "bold").mockImplementation((text) => `<bold>${text}</bold>`);
		try {
			const requestRender = vi.fn();
			const loader = new AtomicWorkingLoader({ requestRender } as never, String, String, "Working...");
			expect(renderedContent(loader)).toBe(" ∀ Working...");
			vi.advanceTimersByTime(80);
			expect(renderedContent(loader)).toBe(" <bold>∀</bold> Working...");

			loader.setIndicator({ frames: ["X"] });
			expect(renderedContent(loader)).toBe(" X Working...");
			const callsAfterReplacement = requestRender.mock.calls.length;
			vi.advanceTimersByTime(160);
			expect(requestRender).toHaveBeenCalledTimes(callsAfterReplacement);

			loader.setIndicator();
			expect(renderedContent(loader)).toBe(" ∀ Working...");
			vi.advanceTimersByTime(79);
			expect(renderedContent(loader)).toBe(" ∀ Working...");
			expect(requestRender).toHaveBeenCalledTimes(callsAfterReplacement);
			vi.advanceTimersByTime(1);
			expect(renderedContent(loader)).toBe(" <bold>∀</bold> Working...");
			expect(requestRender).toHaveBeenCalledTimes(callsAfterReplacement + 1);
			loader.stop();
			vi.advanceTimersByTime(160);
			expect(requestRender).toHaveBeenCalledTimes(callsAfterReplacement + 1);
		} finally {
			bold.mockRestore();
			restoreEnv("ATOMIC_REDUCED_MOTION", previousReducedMotion);
		}
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

	it("shows a static un-emphasized identity without a timer under reduced motion", () => {
		const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
		vi.useFakeTimers();
		process.env.ATOMIC_REDUCED_MOTION = "1";
		try {
			const requestRender = vi.fn();
			const loader = new AtomicWorkingLoader({ requestRender } as never, String, String, "Working...");
			expect(atomicWorkingFrame(80)).toBe(0);
			expect(renderedContent(loader)).toBe(" ∀ Working...");
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
