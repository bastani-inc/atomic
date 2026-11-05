import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Atomic from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";

const scheduled = vi.hoisted(() => [] as Array<{ readonly store: unknown; readonly graceSeconds: number }>);

vi.mock("@bastani/atomic", async (importOriginal) => {
	const actual = await importOriginal<typeof Atomic>();
	return {
		...actual,
		scheduleSnapshotCollection: (...args: Parameters<typeof actual.scheduleSnapshotCollection>) => {
			scheduled.push({ store: args[0], graceSeconds: args[1].graceSeconds });
			return actual.scheduleSnapshotCollection(...args);
		},
	};
});

let directory: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-collection-trigger-"));
	scheduled.length = 0;
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

const child = workflow({
	name: "child",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("noop", {}, async () => "done");
		return {};
	},
});
const parent = workflow({
	name: "parent",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.workflow(child, {});
		return {};
	},
});

test("only the root run schedules a collection when it finishes, with the run's snapshot settings (#4355)", async () => {
	const fixture = await openSqlSnapshotJournalBackend(join(directory, "journal.sqlite"));
	cleanups.push(() => fixture.close());

	const result = await run(
		parent,
		{},
		{ cwd: directory, durableBackend: fixture.backend, store: createStore(), snapshots: { graceSeconds: 7 } },
	);

	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(scheduled, [{ store: fixture.journal.snapshotBlobs, graceSeconds: 7 }]);
});

test("a root run on a backend without a snapshot journal still finishes, and its collection has no store (#4355)", async () => {
	const fixture = await openSqlSnapshotJournalBackend(join(directory, "journal.sqlite"));
	cleanups.push(() => fixture.close());
	const withoutSnapshots: typeof fixture.backend = Object.create(fixture.backend, {
		snapshotJournal: { value: undefined },
	});

	const result = await run(child, {}, { cwd: directory, durableBackend: withoutSnapshots, store: createStore() });

	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(scheduled, [{ store: undefined, graceSeconds: 3600 }]);
});
