import { describe, expect, it } from "vitest";
import type { SessionBeforeCompactResult, SessionCompactEvent } from "../src/core/extensions/index.ts";

describe("custom compaction extension contract", () => {
	it("uses compactedText and the durable compaction entry", () => {
		const result: SessionBeforeCompactResult = { compactedText: "[User]: retained" };
		expect(result.compactedText).toBe("[User]: retained");
		const observe = (event: SessionCompactEvent): string => event.compactionEntry.summary;
		expect(typeof observe).toBe("function");
	});
});
