import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowInputSchemaMap } from "../../packages/workflows/src/shared/types.js";
import {
	inputsSummary,
	openWorkflowsListing,
	runRowDescription,
	shortFailureReason,
	type WorkflowsListingDefinition,
	workflowsListingItems,
} from "../../packages/workflows/src/tui/workflows-listing.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

const NOW = 10_000_000;

function run(over: Partial<RunSnapshot> & Pick<RunSnapshot, "id" | "status">): RunSnapshot {
	return {
		name: "ralph",
		inputs: {},
		stages: [],
		toolNodes: [],
		startedAt: NOW - 12 * 60_000,
		...over,
	} as RunSnapshot;
}

const STAGE_NAMES = ["plan", "build", "implement", "review", "verify"];
function stages(statuses: readonly StageSnapshot["status"][]): StageSnapshot[] {
	return statuses.map(
		(status, index) => ({ id: `s${index}`, name: STAGE_NAMES[index] ?? `s${index}`, status }) as StageSnapshot,
	);
}

function definition(
	name: string,
	description: string,
	inputs: WorkflowInputSchemaMap = {},
): WorkflowsListingDefinition {
	return { normalizedName: name, description, inputs };
}

test("/workflows lists runs newest first, then definitions by name, in two groups (#5224)", () => {
	const items = workflowsListingItems(
		[
			run({ id: "old", status: "completed", startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000 }),
			run({ id: "new", status: "running", name: "review-pr" }),
			run({ id: "child", status: "running", parentRunId: "new" } as Partial<RunSnapshot> &
				Pick<RunSnapshot, "id" | "status">),
		],
		[definition("ralph", "iterate a fix until its checks pass"), definition("deep-research", "research a topic")],
		NOW,
	);
	assert.deepEqual(
		items.map((item) => [item.group, item.id]),
		[
			["Runs", "run:new"],
			["Runs", "run:old"],
			["Definitions", "definition:deep-research"],
			["Definitions", "definition:ralph"],
		],
		"a child run is not listed on its own",
	);
	assert.deepEqual(items[0]?.value, { kind: "run", runId: "new" });
	assert.deepEqual(items[3]?.value, { kind: "definition", name: "ralph" });
});

test("a run's second line reads status · stage n/m <stage> · elapsed · cost (#5224)", () => {
	const live = run({
		id: "r",
		status: "running",
		stages: stages(["completed", "completed", "running", "pending", "pending"]),
		budgetState: { accounting: { cost: 1.84 } } as RunSnapshot["budgetState"],
	});
	assert.equal(runRowDescription(live, NOW), "running · stage 3/5 implement · 12m · $1.84");
	const done = run({
		id: "d",
		status: "completed",
		stages: stages(["completed", "completed"]),
		startedAt: NOW - 2 * 3_600_000 - 12 * 60_000,
		endedAt: NOW - 2 * 3_600_000,
	});
	assert.equal(runRowDescription(done, NOW), "completed · stage 2/2 · 2h ago · 12m");
});

test("a failed run names its failed stage and a short reason, never a stack trace (#5224)", () => {
	const failed = run({
		id: "f",
		status: "failed",
		stages: stages(["completed", "failed", "pending"]),
		failedStageId: "s1",
		endedAt: NOW - 60_000,
		error: "Error: gate failed: 2 jobs\n    at verify (/x/y.ts:1:2)\n    at run (/x/z.ts:3:4)",
	});
	const text = runRowDescription(failed, NOW);
	assert.match(text, /^failed · stage 2\/3 build · 1m ago · 11m · ✗ gate failed: 2 jobs$/);
	assert.doesNotMatch(text, /\bat verify\b/);
	assert.equal(shortFailureReason({ error: "x".repeat(100) })?.length, 60);
	const item = workflowsListingItems([failed], [], NOW)[0];
	assert.equal(item?.tag, "✗");
	assert.equal(item?.tagTone, "error");
	const stopped = workflowsListingItems([run({ id: "s", status: "cancelled", endedAt: NOW })], [], NOW)[0];
	assert.equal(stopped?.tag, "◼", "stopped looks different from failed");
	assert.match(stopped?.description ?? "", /^stopped/);
});

test("a definition's row summarises its inputs and how many are required (#5224)", () => {
	assert.equal(inputsSummary({}), "no inputs");
	const inputs = {
		objective: { type: "string", required: true },
		max_loops: { type: "number", default: 10 },
	} as unknown as WorkflowInputSchemaMap;
	assert.equal(inputsSummary(inputs), "2 inputs (1 required)");
	const item = workflowsListingItems([], [definition("ralph", "iterate a fix\nmore detail", inputs)], NOW)[0];
	assert.equal(item?.description, "iterate a fix · 2 inputs (1 required)");
});

test("runs of one workflow are told apart by their first input, and a run waiting on a question says so (#5224)", () => {
	const waiting = run({
		id: "11111111-aaaa",
		status: "running",
		name: "approve-demo",
		inputs: { topic: "rename a file" },
		stages: [
			{
				id: "s0",
				name: "plan",
				status: "running",
				pendingPrompt: { kind: "select", message: "Approve this plan?" },
			},
		] as never,
	});
	const other = run({
		id: "22222222-bbbb",
		status: "running",
		name: "approve-demo",
		inputs: {},
		startedAt: NOW - 60_000,
	});
	const [first, second] = workflowsListingItems([waiting, other], [], NOW);
	assert.equal(first?.label, "approve-demo · 22222222", "no input: the run's short id");
	assert.equal(second?.label, "approve-demo · rename a file");
	assert.match(second?.description ?? "", /^needs input · Approve this plan\? · /);
	assert.equal(second?.tag, "◆");
});

test("an open workflows sheet refreshes runs without losing its search or selection (#5245)", async () => {
	initTheme("dark");
	let runs = [
		run({ id: "first", status: "running", startedAt: NOW }),
		run({ id: "selected", status: "running", startedAt: NOW - 1 }),
	];
	let notify = () => {};
	let released = 0;
	let reads = 0;
	let mounted: Promise<PiCustomComponent> | undefined;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					mounted = Promise.resolve(
						factory({ requestRender() {} }, undefined, undefined, () => resolve(undefined)),
					);
				}),
		},
		{
			runs: () => {
				reads++;
				return runs;
			},
			definitions: () => [],
			subscribe: (listener) => {
				notify = listener;
				return () => released++;
			},
		},
	);
	assert.ok(mounted);
	const component = await mounted;
	try {
		for (const key of "ralph") component.handleInput?.(key);
		component.handleInput?.("\x1b[B");
		runs = [
			run({ id: "new", status: "running", startedAt: NOW + 1 }),
			runs[0]!,
			{ ...runs[1]!, status: "failed", error: "gate refused", endedAt: NOW },
		];
		notify();
		notify();
		notify();
		assert.equal(reads, 1, "store events defer the snapshot read until rendering");
		const text = stripVTControlCharacters(component.render(160).join("\n"));
		component.render(160);
		assert.equal(reads, 2, "one snapshot read per changed frame, not per event or unchanged render");
		assert.match(text, /gate refused/);
		assert.match(text, /ralph · new/);
		assert.match(text, /❯ ralph · selected/);
		assert.doesNotMatch(text, / {2}Runs\n/);
		component.handleInput?.("\r");
		assert.deepEqual(await pending, { kind: "run", runId: "selected" });
		assert.equal(released, 1);
	} finally {
		component.dispose?.();
	}
});

test("/workflows excludes active pauses and clamps recorded elapsed time (#5245/#5224)", () => {
	const paused = run({
		id: "paused",
		status: "paused",
		startedAt: NOW - 70 * 60_000,
		pausedAt: NOW - 60 * 60_000,
		stages: stages(["completed"]),
	});
	assert.equal(runRowDescription(paused, NOW), "paused · stage 1/1 · 10m");
	assert.equal(runRowDescription(paused, NOW + 60 * 60_000), "paused · stage 1/1 · 10m");
	assert.equal(runRowDescription({ ...paused, durationMs: -1 }, NOW), "paused · stage 1/1 · 0s");
});

async function liveListing(initialRuns: RunSnapshot[], definitions: WorkflowsListingDefinition[] = []) {
	initTheme("dark");
	let runs = initialRuns;
	let notify = () => {};
	let closeCalls = 0;
	let rendersRequested = 0;
	let releases = 0;
	let mounted: Promise<PiCustomComponent> | undefined;
	const result = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					mounted = Promise.resolve(
						factory({ requestRender: () => rendersRequested++ }, undefined, undefined, () => {
							closeCalls++;
							resolve(undefined);
						}),
					);
				}),
		},
		{
			runs: () => runs,
			definitions: () => definitions,
			subscribe: (listener) => {
				notify = listener;
				return () => releases++;
			},
		},
	);
	assert.ok(mounted);
	return {
		component: await mounted,
		result,
		update(next: RunSnapshot[]) {
			runs = next;
			notify();
		},
		get closeCalls() {
			return closeCalls;
		},
		get rendersRequested() {
			return rendersRequested;
		},
		get releases() {
			return releases;
		},
	};
}

for (const key of ["\r", "\x1b[C"]) {
	test(`/workflows paints a replacement before confirming it with ${JSON.stringify(key)} (#5245/#5224)`, async () => {
		const fixture = await liveListing(
			[
				run({ id: "bbbbbbbb", status: "running", startedAt: NOW }),
				run({ id: "aaaaaaaa", status: "running", startedAt: NOW - 1 }),
			],
			[definition("deploy", "Deploy without inputs")],
		);
		try {
			assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ ralph · bbbbbbbb/);
			fixture.update([]);
			fixture.component.handleInput?.(key);
			fixture.component.handleInput?.(key);
			assert.equal(fixture.closeCalls, 0, "neither key may start an unseen definition");
			assert.ok(fixture.rendersRequested > 0);
			assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ deploy/);
			fixture.component.handleInput?.(key);
			assert.deepEqual(await fixture.result, { kind: "definition", name: "deploy" });
			assert.equal(fixture.releases, 1);
		} finally {
			fixture.component.dispose?.();
		}
	});
}

test("/workflows does not confirm a search replacement before painting, even after cursor input (#5245/#5224)", async () => {
	const selected = run({ id: "bbbbbbbb", status: "running", startedAt: NOW });
	const other = run({ id: "aaaaaaaa", status: "running", startedAt: NOW - 1 });
	const fixture = await liveListing([selected, other]);
	try {
		for (const key of "running") fixture.component.handleInput?.(key);
		assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ ralph · bbbbbbbb/);
		fixture.update([{ ...selected, status: "completed", endedAt: NOW }, other]);
		fixture.component.handleInput?.("\x1b[C");
		assert.equal(fixture.closeCalls, 0, "right arrow edits the search instead of confirming");
		fixture.component.handleInput?.("\r");
		assert.equal(fixture.closeCalls, 0, "the preceding cursor key must not hide an unpainted refresh");
		assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ ralph · aaaaaaaa/);
		fixture.component.handleInput?.("\r");
		assert.deepEqual(await fixture.result, { kind: "run", runId: "aaaaaaaa" });
	} finally {
		fixture.component.dispose?.();
	}
});

test("/workflows still confirms the painted row when other runs change (#5245/#5224)", async () => {
	const selected = run({ id: "selected", status: "running" });
	const fixture = await liveListing([selected]);
	try {
		fixture.component.render(120);
		fixture.update([run({ id: "new", status: "running", startedAt: NOW + 1 }), selected]);
		fixture.component.handleInput?.("\r");
		assert.deepEqual(await fixture.result, { kind: "run", runId: "selected" });
	} finally {
		fixture.component.dispose?.();
	}
});

test("/workflows settles when a custom UI host resolves without mounting (#5245/#5224)", async () => {
	let settled = false;
	let factoryCalled = false;
	const pending = openWorkflowsListing(
		{ custom: async () => undefined },
		{
			runs: () => {
				factoryCalled = true;
				return [];
			},
			definitions: () => [],
		},
	);
	void pending.then(() => {
		settled = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(factoryCalled, false);
	assert.equal(settled, true);
	assert.equal(await pending, undefined);
});

test("/workflows mounts as navigation rather than an approval prompt (#5245/#5224)", async () => {
	let purpose: string | undefined;
	const pending = openWorkflowsListing(
		{
			custom: async (_factory, options) => {
				purpose = options.purpose;
			},
		},
		{ runs: () => [], definitions: () => [] },
	);
	assert.equal(purpose, "navigation");
	assert.equal(await pending, undefined);
});

for (const mode of ["reject", "throw"] as const) {
	test(`/workflows settles when its custom UI host fails before mounting with ${mode} (#5245/#5224)`, async () => {
		const failure = new Error("host unavailable");
		const pending = openWorkflowsListing(
			{
				custom: () => {
					if (mode === "throw") throw failure;
					return Promise.reject(failure);
				},
			},
			{ runs: () => [], definitions: () => [] },
		);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, true);
		assert.equal(await pending, undefined);
	});
}

for (const mode of ["resolve", "reject"] as const) {
	test(`/workflows releases its subscription when the mounted host later ${mode}s (#5245/#5224)`, async () => {
		initTheme("dark");
		let mounted: PiCustomComponent | undefined;
		let releases = 0;
		const pending = openWorkflowsListing(
			{
				custom: async (factory) => {
					mounted = await factory({ requestRender() {} }, undefined, undefined, () => {});
					if (mode === "reject") throw new Error("mount aborted");
				},
			},
			{ runs: () => [], definitions: () => [], subscribe: () => () => releases++ },
		);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, true);
		assert.equal(await pending, undefined);
		assert.equal(releases, 1);
		assert.ok(mounted);
		mounted.dispose?.();
		assert.equal(releases, 1);
	});
}

test("/workflows keeps its chosen row when done synchronously disposes the mount (#5245/#5224)", async () => {
	initTheme("dark");
	let mounted: PiCustomComponent | undefined;
	let closed = 0;
	let releases = 0;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					mounted = factory({ requestRender() {} }, undefined, undefined, () => {
						closed++;
						mounted?.dispose?.();
						resolve(undefined);
					}) as PiCustomComponent;
				}),
		},
		{
			runs: () => [run({ id: "chosen", status: "running" })],
			definitions: () => [],
			subscribe: () => () => releases++,
		},
	);
	assert.ok(mounted);
	mounted.render(120);
	mounted.handleInput?.("\r");
	assert.deepEqual(await pending, { kind: "run", runId: "chosen" });
	assert.equal(closed, 1);
	assert.equal(releases, 1);
});
