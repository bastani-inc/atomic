import { describe, expect, it } from "vitest";
import { ensureDeferredStartupComplete, type DeferredStartupMode } from "../src/modes/interactive/interactive-deferred-startup.ts";

function createMode(): DeferredStartupMode & { starts: number } {
	return {
		deferredStartupPending: true,
		deferredStartupPromise: undefined,
		starts: 0,
		completeDeferredStartup() {
			this.starts += 1;
			this.deferredStartupPending = false;
			return Promise.resolve();
		},
	};
}

describe("deferred startup input readiness", () => {
	it("starts and awaits deferred startup exactly once before prompt processing", async () => {
		const mode = createMode();

		await ensureDeferredStartupComplete(mode);
		await ensureDeferredStartupComplete(mode);

		expect(mode.starts).toBe(1);
	});

	it("does nothing when deferred startup already completed", async () => {
		const mode = createMode();
		mode.deferredStartupPending = false;

		await ensureDeferredStartupComplete(mode);

		expect(mode.starts).toBe(0);
	});
});
