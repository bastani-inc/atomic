import { describe, expect, it } from "vitest";
import { DeferredCursorModelScopeError, ensureDeferredStartupComplete, type DeferredStartupMode } from "../src/modes/interactive/interactive-deferred-startup.ts";

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

	it("fails open and clears pending state when deferred startup rejects", async () => {
		const mode = createMode();
		mode.completeDeferredStartup = () => Promise.reject(new Error("boom"));

		await expect(ensureDeferredStartupComplete(mode)).resolves.toBeUndefined();

		expect(mode.deferredStartupPending).toBe(false);
		expect(mode.deferredStartupPromise).toBeUndefined();
	});

	it("fails open when deferred startup throws synchronously", async () => {
		const mode = createMode();
		mode.completeDeferredStartup = () => {
			throw new Error("boom");
		};

		await expect(ensureDeferredStartupComplete(mode)).resolves.toBeUndefined();

		expect(mode.deferredStartupPending).toBe(false);
		expect(mode.deferredStartupPromise).toBeUndefined();
	});

	it("keeps a strict Cursor scope failure fatal across later prompt gates", async () => {
		const mode = createMode();
		const fatal = new DeferredCursorModelScopeError("Reselect an exact Cursor model");
		mode.deferredStartupPending = false;
		mode.deferredStartupFatalError = fatal;

		await expect(ensureDeferredStartupComplete(mode)).rejects.toBe(fatal);
		expect(mode.starts).toBe(0);
	});
});
