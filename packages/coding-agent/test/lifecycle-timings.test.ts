import { describe, expect, it, vi } from "vitest";
import {
	installLifecycleTimingSink,
	isLifecycleTimingEnabled,
	type LifecycleTimingRecord,
	markLifecycleTiming,
} from "../src/core/lifecycle-timings.ts";

describe("lifecycle timing seams", () => {
	it("does not read the monotonic clock when no diagnostic sink is installed", () => {
		const clock = vi.spyOn(process.hrtime, "bigint");
		try {
			expect(isLifecycleTimingEnabled()).toBe(false);
			markLifecycleTiming("engine-ready");
			expect(clock).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});

	it("records monotonic one-shot marks without writing or awaiting work", () => {
		const records: LifecycleTimingRecord[] = [];
		const marks = [101n, 202n];
		const restore = installLifecycleTimingSink(
			(record) => records.push(record),
			() => marks.shift() ?? 303n,
		);
		try {
			markLifecycleTiming("process-entry");
			markLifecycleTiming("process-entry");
			markLifecycleTiming("interactive-engine-spawn");
			expect(records).toEqual([
				{ label: "process-entry", atNs: 101n, pid: process.pid },
				{ label: "interactive-engine-spawn", atNs: 202n, pid: process.pid },
			]);
		} finally {
			restore();
		}
		expect(isLifecycleTimingEnabled()).toBe(false);
	});
});
