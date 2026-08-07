import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	captureLoadedFileExtensionPathCycle,
	getLoadedFileExtensionPaths,
	loadedFileExtensionPathsOf,
	setLoadedFileExtensionPaths,
	withLoadedFileExtensionPathCycle,
} from "../src/core/extensions/loaded-extension-paths.ts";

/** Yield so a second cycle can interleave, as the loader does between factories. */
const yieldToOther = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("loaded file extension paths are scoped per load cycle", () => {
	it("keeps two overlapping cycles from overwriting each other", async () => {
		// One process can run more than one loader — in-process subagent sessions
		// do — and loading yields between inline factories. A single module-scope
		// array let the second cycle answer the first cycle's question.
		const readings: Record<string, readonly string[]> = {};

		const cycleA = withLoadedFileExtensionPathCycle(async () => {
			setLoadedFileExtensionPaths(["/a/herdr-agent-state.ts"]);
			await yieldToOther();
			readings.a = getLoadedFileExtensionPaths();
		});
		const cycleB = withLoadedFileExtensionPathCycle(async () => {
			setLoadedFileExtensionPaths([]);
			await yieldToOther();
			readings.b = getLoadedFileExtensionPaths();
		});
		await Promise.all([cycleA, cycleB]);

		assert.deepEqual(readings.a, ["/a/herdr-agent-state.ts"], "cycle A must still see its own file set");
		assert.deepEqual(readings.b, [], "cycle B must not inherit cycle A's file set");
	});

	it("keeps them isolated in the opposite interleaving too", async () => {
		const readings: Record<string, readonly string[]> = {};

		const clean = withLoadedFileExtensionPathCycle(async () => {
			setLoadedFileExtensionPaths([]);
			await yieldToOther();
			readings.clean = getLoadedFileExtensionPaths();
		});
		await yieldToOther();
		const withFile = withLoadedFileExtensionPathCycle(async () => {
			setLoadedFileExtensionPaths(["/b/herdr-agent-state.js"]);
			await yieldToOther();
			readings.withFile = getLoadedFileExtensionPaths();
		});
		await Promise.all([clean, withFile]);

		assert.deepEqual(readings.clean, []);
		assert.deepEqual(readings.withFile, ["/b/herdr-agent-state.js"]);
	});

	it("reuses an enclosing cycle so a nested load shares one answer", async () => {
		// The pre-trust and final loads of one reload are nested. A file extension
		// discovered by the later load must be visible to a factory the earlier
		// load already ran, which is what a shared handle gives.
		await withLoadedFileExtensionPathCycle(async () => {
			setLoadedFileExtensionPaths([]);
			const captured = captureLoadedFileExtensionPathCycle();
			assert.deepEqual(loadedFileExtensionPathsOf(captured), []);

			await withLoadedFileExtensionPathCycle(async () => {
				setLoadedFileExtensionPaths(["/c/herdr-agent-state.ts"]);
			});

			assert.deepEqual(
				loadedFileExtensionPathsOf(captured),
				["/c/herdr-agent-state.ts"],
				"the nested load updated the enclosing cycle rather than starting a new one",
			);
		});
	});

	it("lets a captured handle answer after its cycle has finished", async () => {
		// A deferred extension re-checks stand-down at activation, long after the
		// load that produced its answer returned.
		let captured = captureLoadedFileExtensionPathCycle();
		await withLoadedFileExtensionPathCycle(async () => {
			setLoadedFileExtensionPaths(["/d/herdr-agent-state.ts"]);
			captured = captureLoadedFileExtensionPathCycle();
		});
		await withLoadedFileExtensionPathCycle(async () => {
			setLoadedFileExtensionPaths([]);
		});

		assert.deepEqual(
			loadedFileExtensionPathsOf(captured),
			["/d/herdr-agent-state.ts"],
			"a later cycle must not rewrite an earlier cycle's captured answer",
		);
	});

	it("still answers direct callers outside any cycle", () => {
		setLoadedFileExtensionPaths(["/e/plain.ts"]);
		assert.deepEqual(getLoadedFileExtensionPaths(), ["/e/plain.ts"]);
		setLoadedFileExtensionPaths([]);
		assert.deepEqual(getLoadedFileExtensionPaths(), []);
	});
});
