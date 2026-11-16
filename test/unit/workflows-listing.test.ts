import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, StdinBuffer, setKeybindings, TuiMainScreen } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/wiring.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
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

import { ScreenTerminal } from "../helpers/screen-terminal.js";

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

test("a definition's row summarises its inputs and how many are required (#5245/#5224)", () => {
	assert.equal(inputsSummary({}), "no inputs");
	const authored = workflow({
		name: "ralph",
		description: "iterate a fix\nmore detail",
		inputs: {
			objective: Type.String(),
			confirm: Type.Boolean(),
			note: Type.Optional(Type.String()),
			max_loops: Type.Integer({ default: 10 }),
		},
		outputs: {},
		run: async () => ({}),
	});
	assert.equal(inputsSummary(authored.inputs), "4 inputs (2 required)");
	const item = workflowsListingItems([], [authored], NOW)[0];
	assert.equal(item?.description, "iterate a fix · 4 inputs (2 required)");
});

test("/workflows uses effective run status for blocked runs and returned failures (#5245/#5224)", () => {
	const store = createStore();
	store.recordRunStart({ ...run({ id: "auth", status: "running", name: "needs-authorization" }) });
	store.recordRunBlocked("auth", "Please sign in", {
		failureKind: "auth",
		failureRecoverability: "recoverable",
		failureDisposition: "active_blocked",
		failureMessage: "Please sign in",
		resumable: true,
	});
	store.recordRunStart({ ...run({ id: "returned", status: "running", name: "deployment" }) });
	store.recordRunEnd("returned", "completed", { status: "failed", summary: "Deployment did not finish" });
	const items = workflowsListingItems(store.runs(), [], NOW);
	const authItem = items.find((item) => item.id === "run:auth");
	const returnedItem = items.find((item) => item.id === "run:returned");
	assert.match(authItem?.description ?? "", /^blocked · .* · ✗ Please sign in$/);
	assert.equal(authItem?.tagTone, "warning");
	assert.match(authItem?.searchText ?? "", /\bblocked\b/);
	assert.match(returnedItem?.description ?? "", /^failed · .* · ✗ Deployment did not finish$/);
	assert.equal(returnedItem?.tag, "✗");
	assert.equal(returnedItem?.tagTone, "error");
	assert.match(returnedItem?.searchText ?? "", /\bfailed\b/);
});

test("/workflows sanitizes terminal control sequences in row text while preserving target ids (#5245)", async () => {
	initTheme("dark");
	const payload = "\x1b]52;c;QVVESVQ=\x07";
	const runs = [
		run({ id: "label-run", status: "running", name: "safe", label: `${payload}label` }),
		run({ id: "input-run", status: "running", name: "safe", inputs: { objective: `${payload}input` } }),
		run({ id: "name-run", status: "running", name: `${payload}name` }),
		run({
			id: "stage-run",
			status: "running",
			stages: [{ id: "s0", name: `${payload}stage`, status: "running" } as StageSnapshot],
		}),
		run({ id: "error-run", status: "failed", endedAt: NOW, error: `${payload}failure` }),
		run({
			id: "question-run",
			status: "running",
			stages: [
				{
					id: "s0",
					name: "plan",
					status: "running",
					pendingPrompt: { kind: "select", message: `${payload}Approve?` },
				} as unknown as StageSnapshot,
			],
		}),
	];
	const defs = [definition(`${payload}def`, `${payload}description`)];
	const items = workflowsListingItems(runs, defs, NOW);
	for (const item of items) {
		assert.equal(item.label.includes(payload), false);
		assert.equal((item.description ?? "").includes(payload), false);
		assert.equal((item.searchText ?? "").includes(payload), false);
	}
	assert.deepEqual(items.at(-1)?.value, { kind: "definition", name: `${payload}def` });

	const terminal = new ScreenTerminal(100, 30);
	const writes: string[] = [];
	const originalWrite = terminal.write.bind(terminal);
	terminal.write = (data: string) => {
		writes.push(data);
		originalWrite(data);
	};
	const tui = new TuiMainScreen(terminal);
	let component: PiCustomComponent | undefined;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory(
						{ terminal: { rows: terminal.rows }, requestRender: () => tui.requestRender() },
						undefined,
						undefined,
						() => resolve(undefined),
					) as PiCustomComponent;
					tui.addChild({
						render: (w: number) => component!.render(w),
						handleInput: (d: string) => {
							component!.handleInput?.(d);
						},
						invalidate: () => {
							component!.invalidate?.();
						},
					});
				}),
		},
		{ runs: () => runs, definitions: () => defs },
	);
	try {
		tui.start();
		await terminal.waitForRender();
		assert.equal(
			writes.some((chunk) => chunk.includes(payload)),
			false,
		);
	} finally {
		component?.dispose?.();
		tui.stop();
		await pending;
	}
});

test("/workflows advances elapsed and relative-end labels on render without a store write (#5245)", async () => {
	initTheme("dark");
	let clockNow = 100_000;
	const spy = vi.spyOn(Date, "now").mockImplementation(() => clockNow);
	const runs = [
		run({ id: "live", status: "running", startedAt: 90_000 }),
		run({ id: "done", status: "completed", startedAt: 80_000, endedAt: 90_000 }),
	];
	let component: PiCustomComponent | undefined;
	let renders = 0;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory(
						{
							requestRender() {
								renders++;
							},
							terminal: { rows: 40 },
						},
						undefined,
						undefined,
						() => resolve(undefined),
					) as PiCustomComponent;
				}),
		},
		{ runs: () => runs, definitions: () => [] },
	);
	try {
		assert.ok(component);
		const before = stripVTControlCharacters(component.render(100).join("\n"));
		assert.match(before, /10s/);
		assert.match(before, /just now/);
		clockNow += 120_000;
		component.handleInput?.("\x1b[B");
		const after = stripVTControlCharacters(component.render(100).join("\n"));
		assert.match(after, /2m\b/);
		assert.match(after, /2m ago/);
		clockNow += 60_000;
		component.handleInput?.("\r");
		assert.deepEqual(await pending, { kind: "run", runId: "done" });
		assert.ok(renders > 0);
	} finally {
		component?.dispose?.();
		spy.mockRestore();
	}
});

test("/workflows guards confirmation when a clock advance drops the searched row before painting (#5245)", async () => {
	initTheme("dark");
	let clockNow = 100_000;
	const spy = vi.spyOn(Date, "now").mockImplementation(() => clockNow);
	const runs = [
		run({ id: "expiring", status: "running", startedAt: 90_000 }),
		run({ id: "fallback", status: "running", startedAt: 10_000, error: "timed out after 10s" }),
	];
	let component: PiCustomComponent | undefined;
	let closed = 0;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows: 40 } }, undefined, undefined, () => {
						closed++;
						resolve(undefined);
					}) as PiCustomComponent;
				}),
		},
		{ runs: () => [runs[0]!, { ...runs[1]!, status: "failed", endedAt: 20_000 }], definitions: () => [] },
	);
	try {
		assert.ok(component);
		for (const key of "10s") component.handleInput?.(key);
		assert.match(stripVTControlCharacters(component.render(120).join("\n")), /❯ ralph · expiring/);
		clockNow += 120_000;
		component.handleInput?.("\r");
		assert.equal(closed, 0);
		assert.match(stripVTControlCharacters(component.render(120).join("\n")), /❯ ralph · fallback/);
		component.handleInput?.("\r");
		assert.equal(closed, 1);
		assert.deepEqual(await pending, { kind: "run", runId: "fallback" });
	} finally {
		component?.dispose?.();
		spy.mockRestore();
	}
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
						factory({ requestRender() {}, terminal: { rows: 30 } }, undefined, undefined, () =>
							resolve(undefined),
						),
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

for (const confirm of ["\r", "\x1b[C"]) {
	test(`/workflows honors Down followed by ${JSON.stringify(confirm)} before another frame (#5245)`, async () => {
		const fixture = await liveListing([
			run({ id: "alpha", status: "running", startedAt: NOW }),
			run({ id: "beta", status: "running", startedAt: NOW - 1 }),
		]);
		const stdin = new StdinBuffer();
		stdin.on("data", (key) => fixture.component.handleInput?.(key));
		try {
			assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ ralph · alpha/);
			stdin.process(`\x1b[B${confirm}`);
			assert.equal(fixture.closeCalls, 1);
			assert.deepEqual(await fixture.result, { kind: "run", runId: "beta" });
		} finally {
			stdin.destroy();
			fixture.component.dispose?.();
		}
	});
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

test("/workflows honors a typed search and Enter before another frame (#5245)", async () => {
	const fixture = await liveListing(
		[run({ id: "alpha", status: "running" })],
		[definition("deploy", "Deploy without inputs")],
	);
	const stdin = new StdinBuffer();
	stdin.on("data", (key) => fixture.component.handleInput?.(key));
	try {
		fixture.component.render(120);
		stdin.process("deploy\r");
		assert.equal(fixture.closeCalls, 1);
		assert.deepEqual(await fixture.result, { kind: "definition", name: "deploy" });
	} finally {
		stdin.destroy();
		fixture.component.dispose?.();
	}
});

for (const chunk of ["\r", "\x1b[B\r"]) {
	test(`/workflows waits for its first frame before confirming ${JSON.stringify(chunk)} (#5245)`, async () => {
		const fixture = await liveListing([
			run({ id: "alpha", status: "running", startedAt: NOW }),
			run({ id: "beta", status: "running", startedAt: NOW - 1 }),
		]);
		const stdin = new StdinBuffer();
		stdin.on("data", (key) => fixture.component.handleInput?.(key));
		try {
			stdin.process(chunk);
			assert.equal(fixture.closeCalls, 0);
			fixture.component.render(120);
			stdin.process("\r");
			assert.equal(fixture.closeCalls, 1);
			assert.deepEqual(await fixture.result, {
				kind: "run",
				runId: chunk.startsWith("\x1b") ? "beta" : "alpha",
			});
		} finally {
			stdin.destroy();
			fixture.component.dispose?.();
		}
	});
}

for (const confirm of ["\r", "\x1b[C"]) {
	test(`/workflows waits for a refreshed frame after moving off a definition with ${JSON.stringify(confirm)} (#5245)`, async () => {
		const fixture = await liveListing(
			[run({ id: "alpha", status: "running" })],
			[definition("deploy", "Deploy without inputs")],
		);
		const stdin = new StdinBuffer();
		stdin.on("data", (key) => fixture.component.handleInput?.(key));
		try {
			fixture.component.handleInput?.("\x1b[B");
			assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ deploy/);
			fixture.update([]);
			stdin.process(`\x1b[A${confirm}`);
			assert.equal(fixture.closeCalls, 0, "Up must not start the definition it tried to leave");
			fixture.component.render(120);
			stdin.process(confirm);
			assert.equal(fixture.closeCalls, 1);
			assert.deepEqual(await fixture.result, { kind: "definition", name: "deploy" });
		} finally {
			stdin.destroy();
			fixture.component.dispose?.();
		}
	});
}

test("/workflows waits for a refreshed frame after navigation before a store change (#5245)", async () => {
	const alpha = run({ id: "alpha", status: "running", startedAt: NOW - 1 });
	const beta = run({ id: "beta", status: "running", startedAt: NOW });
	const fixture = await liveListing([alpha, beta], [definition("deploy", "Deploy without inputs")]);
	try {
		assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ ralph · beta/);
		fixture.component.handleInput?.("\x1b[B");
		fixture.update([beta]);
		fixture.component.handleInput?.("\r");
		assert.equal(fixture.closeCalls, 0, "the refresh must not replace the row chosen by Down");
		fixture.component.render(120);
		fixture.component.handleInput?.("\r");
		assert.equal(fixture.closeCalls, 1);
		assert.deepEqual(await fixture.result, { kind: "run", runId: "beta" });
	} finally {
		fixture.component.dispose?.();
	}
});

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
