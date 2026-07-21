import { describe, expect, it } from "vitest";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	ATOMIC_WORKING_FRAME_MS,
	ATOMIC_WORKING_MARK_FRAMES,
	AtomicWorkingLoader,
	AtomicWorkingStatusComponent,
	atomicWorkingFrame,
} from "../src/modes/interactive/components/atomic-working-status.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

describe("Atomic working status", () => {
	it("packs recognizable G1 topology into a stable two-row cumulative surface", () => {
		expect(ATOMIC_WORKING_FRAME_MS).toBe(240);
		expect(ATOMIC_WORKING_MARK_FRAMES).toHaveLength(12);
		for (const frame of ATOMIC_WORKING_MARK_FRAMES) {
			expect(frame).toHaveLength(2);
			expect(frame[0]!.length).toBe(frame[1]!.length);
		}
		for (let index = 1; index <= 6; index++) {
			const before = [...ATOMIC_WORKING_MARK_FRAMES[index - 1]!.join("")].filter((c) => c !== " ").length;
			const after = [...ATOMIC_WORKING_MARK_FRAMES[index]!.join("")].filter((c) => c !== " ").length;
			expect(after).toBeGreaterThanOrEqual(before);
		}
		expect(ATOMIC_WORKING_MARK_FRAMES[6]!.join("")).not.toContain("-");
		expect(ATOMIC_WORKING_MARK_FRAMES[7]!.join("")).toContain("-");
		expect(ATOMIC_WORKING_MARK_FRAMES[8]!.join("")).toContain("--");
		expect(ATOMIC_WORKING_MARK_FRAMES[9]!.join("")).toContain("--*");
		expect(ATOMIC_WORKING_MARK_FRAMES[10]).toEqual(ATOMIC_WORKING_MARK_FRAMES[9]);
		expect(ATOMIC_WORKING_MARK_FRAMES[11]).toEqual(ATOMIC_WORKING_MARK_FRAMES[9]);
	});

	it("samples the 240ms cadence and two rest frames", () => {
		expect(atomicWorkingFrame(0)).toBe(0);
		expect(atomicWorkingFrame(239)).toBe(0);
		expect(atomicWorkingFrame(240)).toBe(1);
		expect(atomicWorkingFrame(480)).toBe(2);
		expect(atomicWorkingFrame(2400)).toBe(10);
		expect(atomicWorkingFrame(2640)).toBe(11);
	});


	it("renders exactly two rows and one label at 100 and 64 columns", () => {
		initTheme("dark");
		for (const width of [100, 64]) {
			const lines = new AtomicWorkingStatusComponent({ frame: 9, message: "Schlepping...", spinnerColor: String, messageColor: String }).render(width).map(plain);
			expect(lines).toHaveLength(2);
			expect(lines.join("\n").match(/Schlepping\.\.\./g)).toHaveLength(1);
			expect(lines.every((line) => line.length <= width)).toBe(true);
		}
	});

	it("hides atomically when the full mark and label cannot fit", () => {
		expect(new AtomicWorkingStatusComponent({ frame: 9, message: "Schlepping...", spinnerColor: String, messageColor: String }).render(20)).toEqual([]);
	});

	it("main status-container harness stays compact beside growing history at 100 and 64 columns", () => {
		initTheme("dark");
		for (const width of [100, 64]) {
			const root = new Container();
			root.addChild(new Text("history-1\nhistory-2", 0, 0));
			root.addChild(new AtomicWorkingStatusComponent({ frame: 9, message: "Schlepping...", spinnerColor: String, messageColor: String }));
			const lines = root.render(width).map(plain);
			expect(lines.slice(0, 2).map((line) => line.trimEnd())).toEqual(["history-1", "history-2"]);
			expect(lines.slice(2)).toHaveLength(2);
			expect(lines.join("\n").match(/Schlepping\.\.\./g)).toHaveLength(1);
			expect(lines.every((line) => line.length <= width)).toBe(true);
		}
	});
	it("preserves explicit extension indicator overrides", () => {
		initTheme("dark");
		const loader = new AtomicWorkingLoader({ requestRender: () => {} } as never, String, String, "Extension status", { frames: ["X"] });
		expect(loader.render(64).map(plain).join("\n")).toContain("X Extension status");
		loader.setIndicator();
		expect(loader.render(64)).toHaveLength(2);
		loader.stop();
	});
});
