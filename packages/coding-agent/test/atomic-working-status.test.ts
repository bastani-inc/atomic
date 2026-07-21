import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ATOMIC_WORKING_FRAME_MS,
	ATOMIC_WORKING_FRAMES,
	ATOMIC_WORKING_SETTLED_FRAME_INDEX,
	AtomicWorkingLoader,
	AtomicWorkingStatusComponent,
	atomicWorkingFrame,
} from "../src/modes/interactive/components/atomic-working-status.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { WHIMSICAL_WORKING_MESSAGES } from "../src/modes/interactive/whimsical-messages.ts";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
const bits = (glyph: string): number => glyph.codePointAt(0)! - 0x2800;
const bitCount = (value: number): number => value.toString(2).replaceAll("0", "").length;
const renderedContent = (loader: AtomicWorkingLoader): string => plain(loader.render(64)[1]!).trimEnd();

function restoreEnv(name: "ATOMIC_REDUCED_MOTION", value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Atomic working status", () => {
	it("uses the exact cumulative top-to-bottom one-cell A sequence and a clean cycle", () => {
		expect(ATOMIC_WORKING_FRAMES).toEqual(["⠁", "⠑", "⠕", "⠵", "⡵", "⣵", "⡵", "⠵", "⠕", "⠑"]);
		expect(ATOMIC_WORKING_SETTLED_FRAME_INDEX).toBe(5);
		expect(ATOMIC_WORKING_FRAMES[ATOMIC_WORKING_SETTLED_FRAME_INDEX]).toBe("⣵");
		expect(ATOMIC_WORKING_FRAMES.map(visibleWidth)).toEqual(Array(10).fill(1));

		const build = ATOMIC_WORKING_FRAMES.slice(0, ATOMIC_WORKING_SETTLED_FRAME_INDEX + 1).map(bits);
		expect(build).toEqual([1, 17, 21, 53, 117, 245]);
		expect(build.slice(1).map((frame, index) => bitCount(frame ^ build[index]!))).toEqual([1, 1, 1, 1, 1]);

		for (let index = 0; index < ATOMIC_WORKING_FRAMES.length; index += 1) {
			const next = (index + 1) % ATOMIC_WORKING_FRAMES.length;
			expect(bitCount(bits(ATOMIC_WORKING_FRAMES[index]!) ^ bits(ATOMIC_WORKING_FRAMES[next]!))).toBe(1);
		}
	});

	it("matches pi-tui's canonical 80ms loader cadence exactly", () => {
		const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
		delete process.env.ATOMIC_REDUCED_MOTION;
		try {
			expect(ATOMIC_WORKING_FRAME_MS).toBe(80);
			expect(atomicWorkingFrame(0)).toBe(0);
			expect(atomicWorkingFrame(79)).toBe(0);
			expect(atomicWorkingFrame(80)).toBe(1);
			expect(atomicWorkingFrame(400)).toBe(ATOMIC_WORKING_SETTLED_FRAME_INDEX);
			expect(atomicWorkingFrame(799)).toBe(9);
			expect(atomicWorkingFrame(800)).toBe(0);
		} finally {
			restoreEnv("ATOMIC_REDUCED_MOTION", previousReducedMotion);
		}
	});

	it("renders one A cell before one message row with origin/main loader geometry", () => {
		initTheme("dark");
		for (const width of [100, 64]) {
			const lines = new AtomicWorkingStatusComponent({
				frame: ATOMIC_WORKING_SETTLED_FRAME_INDEX,
				message: "Schlepping...",
				spinnerColor: String,
				messageColor: String,
			}).render(width).map(plain);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("");
			expect(lines[1]!.trimEnd()).toBe(" ⣵ Schlepping...");
			expect(lines[1]!.match(/[⠀-⣿]/g)).toEqual(["⣵"]);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("fits all 453 restored whimsical messages, including the derived longest, at 64 columns", () => {
		expect(WHIMSICAL_WORKING_MESSAGES).toHaveLength(453);
		const longest = WHIMSICAL_WORKING_MESSAGES.reduce((current, message) =>
			visibleWidth(message) > visibleWidth(current) ? message : current);
		expect(longest).toBe("Archeologically analyzing the architecture...");
		for (const message of WHIMSICAL_WORKING_MESSAGES) {
			const lines = new AtomicWorkingStatusComponent({
				frame: ATOMIC_WORKING_SETTLED_FRAME_INDEX,
				message,
				spinnerColor: String,
				messageColor: String,
			}).render(64).map(plain);
			expect(lines).toHaveLength(2);
			expect(lines[1]!.trimEnd()).toBe(` ⣵ ${message}`);
			expect(lines.every((line) => visibleWidth(line) <= 64)).toBe(true);
		}
	});

	it("keeps the main status container compact beside existing history", () => {
		const root = new Container();
		root.addChild(new Text("history-1\nhistory-2", 0, 0));
		root.addChild(new AtomicWorkingStatusComponent({
			frame: ATOMIC_WORKING_SETTLED_FRAME_INDEX,
			message: "Schlepping...",
			spinnerColor: String,
			messageColor: String,
		}));
		const lines = root.render(64).map(plain);
		expect(lines.slice(0, 2).map((line) => line.trimEnd())).toEqual(["history-1", "history-2"]);
		expect(lines.slice(2).map((line) => line.trimEnd())).toEqual(["", " ⣵ Schlepping..."]);
	});

	it("routes the glyph and message through their supplied theme colorizers", () => {
		const spinnerColor = vi.fn((text: string) => `\u001b[31m${text}\u001b[39m`);
		const messageColor = vi.fn((text: string) => `\u001b[2m${text}\u001b[22m`);
		const lines = new AtomicWorkingStatusComponent({
			frame: ATOMIC_WORKING_SETTLED_FRAME_INDEX,
			message: "Working...",
			spinnerColor,
			messageColor,
		}).render(64);
		expect(spinnerColor).toHaveBeenCalledWith("⣵");
		expect(messageColor).toHaveBeenCalledWith("Working...");
		expect(plain(lines[1]!).trimEnd()).toBe(" ⣵ Working...");
	});

	it("ticks, stops, and resets the default loader at 80ms", () => {
		const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
		vi.useFakeTimers();
		delete process.env.ATOMIC_REDUCED_MOTION;
		try {
			const requestRender = vi.fn();
			const loader = new AtomicWorkingLoader({ requestRender } as never, String, String, "Working...");
			expect(renderedContent(loader)).toBe(" ⠁ Working...");
			vi.advanceTimersByTime(79);
			expect(renderedContent(loader)).toBe(" ⠁ Working...");
			vi.advanceTimersByTime(1);
			expect(renderedContent(loader)).toBe(" ⠑ Working...");
			expect(requestRender).toHaveBeenCalledTimes(1);
			loader.stop();
			vi.advanceTimersByTime(160);
			expect(requestRender).toHaveBeenCalledTimes(1);

			loader.setIndicator({ frames: ["X"] });
			expect(renderedContent(loader)).toBe(" X Working...");
			loader.setIndicator();
			expect(renderedContent(loader)).toBe(" ⠁ Working...");
			loader.stop();
		} finally {
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

	it("settles on the final A without a default timer under reduced motion", () => {
		const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
		vi.useFakeTimers();
		process.env.ATOMIC_REDUCED_MOTION = "1";
		try {
			const requestRender = vi.fn();
			const loader = new AtomicWorkingLoader({ requestRender } as never, String, String, "Working...");
			expect(atomicWorkingFrame(0)).toBe(ATOMIC_WORKING_SETTLED_FRAME_INDEX);
			expect(renderedContent(loader)).toBe(" ⣵ Working...");
			vi.advanceTimersByTime(800);
			expect(renderedContent(loader)).toBe(" ⣵ Working...");
			expect(requestRender).not.toHaveBeenCalled();
			loader.start();
			vi.advanceTimersByTime(800);
			expect(requestRender).not.toHaveBeenCalled();
			loader.stop();
		} finally {
			restoreEnv("ATOMIC_REDUCED_MOTION", previousReducedMotion);
		}
	});
});
