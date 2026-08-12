/**
 * Unit tests for shared/persistence-compaction-policy.ts
 * cross-ref: spec §5.6, §8.1 Phase D
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { CompactionAPI } from "../../packages/workflows/src/shared/persistence-compaction-policy.js";
import { installCompactionHook } from "../../packages/workflows/src/shared/persistence-compaction-policy.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompactionApi(): CompactionAPI & {
	_handlers: Map<string, Array<() => void | Promise<void>>>;
	trigger(event: string): void;
} {
	const _handlers = new Map<string, Array<() => void | Promise<void>>>();
	return {
		_handlers,
		on(event: string, handler: () => void | Promise<void>): void {
			if (!_handlers.has(event)) _handlers.set(event, []);
			_handlers.get(event)!.push(handler);
		},
		trigger(event: string): void {
			for (const h of _handlers.get(event) ?? []) h();
		},
	};
}

function makeRunSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "r1",
		name: "my-wf",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("installCompactionHook", () => {
	test("no-op when api.on absent", () => {
		const st = createStore();
		const api = {}; // no .on
		// Should not throw
		installCompactionHook(api as CompactionAPI, st);
	});

	test("registers handler for session_before_compact", () => {
		const api = makeCompactionApi();
		const st = createStore();
		installCompactionHook(api, st);
		assert.equal(api._handlers.has("session_before_compact"), true);
	});

	test("on compact with no active runs: no entries appended", () => {
		const api = makeCompactionApi();
		const st = createStore();

		// Add a finished run
		const run = makeRunSnapshot({ endedAt: 2000, status: "completed" });
		st.recordRunStart(run);
		st.recordRunEnd("r1", "completed");

		const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
		(api as unknown as { appendEntry: (t: string, p: Record<string, unknown>) => string }).appendEntry = (
			type,
			payload,
		) => {
			appended.push({ type, payload });
			return "e0";
		};

		installCompactionHook(api, st);
		api.trigger("session_before_compact");

		assert.equal(appended.length, 0);
	});

	test("on compact with active run: re-appends workflow.run.start", () => {
		const api = makeCompactionApi();
		const st = createStore();

		const run = makeRunSnapshot(); // no endedAt → in-flight
		st.recordRunStart(run);

		const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
		(api as unknown as { appendEntry: (t: string, p: Record<string, unknown>) => string }).appendEntry = (
			type,
			payload,
		) => {
			appended.push({ type, payload });
			return `e${appended.length}`;
		};

		installCompactionHook(api, st);
		api.trigger("session_before_compact");

		const runStart = appended.find((e) => e.type === "workflow.run.start");
		assert.notEqual(runStart, undefined);
		assert.equal(runStart!.payload.runId, "r1");
		assert.equal(runStart!.payload.name, "my-wf");
	});

	test("on compact: re-appends workflow.stage.start for non-ended stages", () => {
		const api = makeCompactionApi();
		const st = createStore();

		const run = makeRunSnapshot({
			stages: [
				{
					id: "s1",
					name: "fetch",
					status: "running",
					parentIds: [],
					toolEvents: [],
					startedAt: 1050,
					sessionAdapter: { name: "remote-pi", config: { profile: "example-profile" } },
					// no endedAt → in-flight
				},
				{
					id: "s2",
					name: "analyze",
					status: "completed",
					parentIds: ["s1"],
					toolEvents: [],
					startedAt: 1100,
					endedAt: 1200, // already ended → should NOT be re-appended
					durationMs: 100,
				},
			],
		});
		st.recordRunStart(run);

		const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
		(api as unknown as { appendEntry: (t: string, p: Record<string, unknown>) => string }).appendEntry = (
			type,
			payload,
		) => {
			appended.push({ type, payload });
			return `e${appended.length}`;
		};

		installCompactionHook(api, st);
		api.trigger("session_before_compact");

		const stageStarts = appended.filter((e) => e.type === "workflow.stage.start");
		assert.equal(stageStarts.length, 1);
		assert.equal(stageStarts[0]!.payload.stageId, "s1");
		assert.deepEqual(stageStarts[0]!.payload.sessionAdapter, {
			name: "remote-pi",
			config: { profile: "example-profile" },
		});
	});

	test("on compact: multiple active runs all re-appended", () => {
		const api = makeCompactionApi();
		const st = createStore();

		st.recordRunStart(makeRunSnapshot({ id: "r1", name: "wf1" }));
		st.recordRunStart(makeRunSnapshot({ id: "r2", name: "wf2" }));

		const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
		(api as unknown as { appendEntry: (t: string, p: Record<string, unknown>) => string }).appendEntry = (
			type,
			payload,
		) => {
			appended.push({ type, payload });
			return `e${appended.length}`;
		};

		installCompactionHook(api, st);
		api.trigger("session_before_compact");

		const runStarts = appended.filter((e) => e.type === "workflow.run.start");
		assert.equal(runStarts.length, 2);
		const ids = runStarts.map((e) => e.payload.runId);
		assert.ok(ids.includes("r1"));
		assert.ok(ids.includes("r2"));
	});
});
