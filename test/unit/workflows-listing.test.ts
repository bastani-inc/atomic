import assert from "node:assert/strict";
import { getKeybindings, StdinBuffer, setKeybindings, TuiMainScreen, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/wiring.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	openWorkflowsListing,
	runRowDescription,
	shortFailureReason,
	workflowsListingItems,
} from "../../packages/workflows/src/tui/workflows-listing.js";

import { ScreenTerminal } from "../helpers/screen-terminal.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

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

test("workflow failure summaries keep English at-prefixes and omit actual stack frames (#5224)", () => {
	for (const [error, expected] of [
		["at capacity", "at capacity"],
		["TypeError: at most five jobs are allowed", "at most five jobs are allowed"],
		["    at run (task.ts:1:2)\nat capacity", "at capacity"],
		["\x1b[31mat capacity\x1b[0m\n    at run (task.ts:1:2)", "at capacity"],
		["    at run (task.ts:1:2)", "No reason was recorded."],
	]) {
		assert.equal(shortFailureReason({ error }), expected);
	}
});

const STAGE_NAMES = ["plan", "build", "implement", "review", "verify"];
function stages(statuses: readonly StageSnapshot["status"][]): StageSnapshot[] {
	return statuses.map((status, index) => ({
		id: `s${index}`,
		name: STAGE_NAMES[index] ?? `s${index}`,
		status,
		parentIds: index === 0 ? [] : [`s${index - 1}`],
		toolEvents: [],
	}));
}

test("/workflows lists top-level runs newest first and excludes child runs (#5224)", () => {
	const items = workflowsListingItems(
		[
			run({ id: "old", status: "completed", startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000 }),
			run({ id: "new", status: "running", name: "review-pr" }),
			run({ id: "child", status: "running", parentRunId: "new" } as Partial<RunSnapshot> &
				Pick<RunSnapshot, "id" | "status">),
		],
		NOW,
	);
	assert.deepEqual(
		items.map((item) => item.id),
		["run:new", "run:old"],
		"a child run is not listed on its own",
	);
	assert.deepEqual(items[0]?.value, { kind: "run", runId: "new" });
	assert.deepEqual(items[1]?.value, { kind: "run", runId: "old" });
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
	const item = workflowsListingItems([failed], NOW)[0];
	assert.equal(item?.tag, "✗");
	assert.equal(item?.tagTone, "error");
	const stopped = workflowsListingItems([run({ id: "s", status: "cancelled", endedAt: NOW })], NOW)[0];
	assert.equal(stopped?.tag, "◼", "stopped looks different from failed");
	assert.match(stopped?.description ?? "", /^stopped/);
});

test("/workflows uses effective run status for blocked runs, returned failures, and gracefully quit runs (#5224)", () => {
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
	store.recordRunStart({ ...run({ id: "quit-run", status: "running", name: "alpha" }) });
	store.recordRunPaused("quit-run", undefined, { exitReason: "quit" });
	const items = workflowsListingItems(store.runs(), NOW);
	const authItem = items.find((item) => item.id === "run:auth");
	const returnedItem = items.find((item) => item.id === "run:returned");
	const quitItem = items.find((item) => item.id === "run:quit-run");
	assert.match(authItem?.description ?? "", /^blocked · .* · ✗ Please sign in$/);
	assert.equal(authItem?.tagTone, "warning");
	assert.match(authItem?.searchText ?? "", /\bblocked\b/);
	assert.match(returnedItem?.description ?? "", /^failed · .* · ✗ Deployment did not finish$/);
	assert.equal(returnedItem?.tag, "✗");
	assert.equal(returnedItem?.tagTone, "error");
	assert.match(returnedItem?.searchText ?? "", /\bfailed\b/);
	assert.match(quitItem?.description ?? "", /^quit · /);
	assert.equal(quitItem?.tag, "○");
	assert.equal(quitItem?.tagTone, "muted");
	assert.match(quitItem?.searchText ?? "", /\bquit\b/);
});

test("/workflows uses the first non-blank line of text inputs, omits non-finite numbers, and never splits surrogate pairs (#5224)", () => {
	const leadingBlank = run({
		id: "abcdef0123",
		name: "deploy",
		status: "running",
		inputs: { objective: "\nship the release" },
	});
	const blankOnly = run({
		id: "1234567890",
		name: "deploy",
		status: "running",
		inputs: { a: "  \n\t\n   ", b: "" },
	});
	const nonFiniteCost = run({
		id: "aaaaaaaa",
		status: "running",
		budgetState: { accounting: { cost: Number.NaN } } as RunSnapshot["budgetState"],
	});
	const nonFiniteTimes = run({
		id: "bbbbbbbb",
		status: "completed",
		startedAt: Number.NaN,
		endedAt: Number.NaN,
	});
	const boundaryEmoji = "\u{1F600}";
	const astralInput = run({
		id: "cccccccc",
		name: "deploy",
		status: "running",
		inputs: { objective: `${"a".repeat(38)}${boundaryEmoji}tail` },
	});
	const astralError = shortFailureReason({ error: `${"x".repeat(58)}${boundaryEmoji}tail` });
	const items = workflowsListingItems([leadingBlank, blankOnly, nonFiniteCost, nonFiniteTimes, astralInput], NOW);
	const byId = new Map(items.map((item) => [item.id, item]));
	assert.equal(byId.get("run:abcdef0123")?.label, "deploy · ship the release");
	assert.equal(byId.get("run:1234567890")?.label, "deploy · 12345678");
	assert.equal(byId.get("run:aaaaaaaa")?.description, "running · 12m");
	assert.equal(byId.get("run:bbbbbbbb")?.description, "completed");
	for (const item of items) {
		assert.doesNotMatch(item.description ?? "", /NaN|Infinity/);
		assert.doesNotMatch(item.label, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	}
	assert.equal(astralError, `${"x".repeat(58)}…`);
	assert.doesNotMatch(astralError ?? "", /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test("/workflows offers Space preview on the selected run and matches the live hint line (#5224)", async () => {
	initTheme("dark");
	const runs = [
		run({
			id: "aaaa1111-2222",
			name: "ralph",
			status: "running",
			startedAt: NOW,
			inputs: { objective: "fix shipping" },
			stages: stages(["completed", "running"]),
		}),
		run({
			id: "bbbb3333-4444",
			name: "deploy",
			status: "completed",
			startedAt: NOW - 120_000,
			endedAt: NOW - 60_000,
		}),
	];
	let component: PiCustomComponent | undefined;
	let closed = 0;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows: 30 } }, undefined, undefined, () => {
						closed++;
						resolve(undefined);
					}) as PiCustomComponent;
				}),
		},
		{ runs: () => runs },
	);
	try {
		assert.ok(component);
		const initial = stripVTControlCharacters(component.render(120).join("\n"));
		assert.equal(stripVTControlCharacters(component.render(120)[0] ?? ""), "▔".repeat(120));
		assert.match(initial, /↑↓ select · space preview · enter open · type to search · esc close/);
		assert.doesNotMatch(initial, /id aaaa1111-2222/);
		component.handleInput?.(" ");
		const previewed = stripVTControlCharacters(component.render(120).join("\n"));
		assert.match(previewed, /id aaaa1111-2222/);
		assert.match(previewed, /plan \(completed\) · build \(running\)/);
		assert.match(previewed, /↑↓ select · space close preview · enter open · type to search · esc close/);
		component.handleInput?.("\x1b");
		assert.equal(closed, 0, "Esc closes the preview card before closing the sheet");
		const afterEsc = stripVTControlCharacters(component.render(120).join("\n"));
		assert.doesNotMatch(afterEsc, /id aaaa1111-2222/);
		assert.match(afterEsc, /↑↓ select · space preview · enter open · type to search · esc close/);
		component.handleInput?.("\x1b");
		assert.equal(closed, 1);
		assert.equal(await pending, undefined);
	} finally {
		component?.dispose?.();
	}
});

test("/workflows sanitizes terminal control sequences in row text while preserving target ids (#5224)", async () => {
	initTheme("dark");
	const payload = "\x1b]52;c;QVVESVQ=\x07";
	const runs = [
		run({ id: "label-run", status: "running", name: "safe", label: `${payload}label` }),
		run({ id: "input-run", status: "running", name: "safe", inputs: { objective: `${payload}input` } }),
		run({ id: "name-run", status: "running", name: `${payload}name` }),
		run({
			id: "stage-run",
			status: "running",
			stages: [{ id: "s0", name: `${payload}stage`, status: "running", parentIds: [], toolEvents: [] }],
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
					parentIds: [],
					toolEvents: [],
					pendingPrompt: { id: "approval", kind: "select", message: `${payload}Approve?`, createdAt: NOW },
				},
			],
		}),
	];
	const items = workflowsListingItems(runs, NOW);
	for (const item of items) {
		assert.equal(item.label.includes(payload), false);
		assert.equal((item.description ?? "").includes(payload), false);
		assert.equal((item.searchText ?? "").includes(payload), false);
	}

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
		{ runs: () => runs },
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

test("/workflows advances elapsed and relative-end labels on render without a store write (#5224)", async () => {
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
		{ runs: () => runs },
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

test("/workflows guards confirmation when a clock advance drops the searched row before painting (#5224)", async () => {
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
		{ runs: () => [runs[0]!, { ...runs[1]!, status: "failed", endedAt: 20_000 }] },
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

test("/workflows guards typed search plus Enter when a clock advance changes descriptions before painting (#5224)", async () => {
	initTheme("dark");
	const T0 = 10_000_000;
	let clockNow = T0;
	const spy = vi.spyOn(Date, "now").mockImplementation(() => clockNow);
	const runs = [
		run({ id: "bbbbbbbb", name: "wf2", status: "completed", startedAt: T0 - 62_000, endedAt: T0 - 59_500 }),
		run({ id: "cccccccc", name: "nxoxw", status: "running", startedAt: T0 - 120_000 }),
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
		{ runs: () => runs },
	);
	try {
		assert.ok(component);
		assert.match(stripVTControlCharacters(component.render(100).join("\n")), /just now/);
		clockNow += 1_000;
		for (const key of "now\r") component.handleInput?.(key);
		assert.equal(closed, 0, "typed search after a clock change must paint before confirming");
		assert.match(stripVTControlCharacters(component.render(100).join("\n")), /❯ nxoxw · cccccccc/);
		component.handleInput?.("\r");
		assert.equal(closed, 1);
		assert.deepEqual(await pending, { kind: "run", runId: "cccccccc" });
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
				parentIds: [],
				toolEvents: [],
				pendingPrompt: { id: "approval", kind: "select", message: "Approve this plan?", createdAt: NOW },
			},
		],
	});
	const other = run({
		id: "22222222-bbbb",
		status: "running",
		name: "approve-demo",
		inputs: {},
		startedAt: NOW - 60_000,
	});
	const [first, second] = workflowsListingItems([waiting, other], NOW);
	assert.equal(first?.label, "approve-demo · 22222222", "no input: the run's short id");
	assert.equal(second?.label, "approve-demo · rename a file");
	assert.match(second?.description ?? "", /^needs input · Approve this plan\? · /);
	assert.equal(second?.tag, "◆");
});

test("an open workflows sheet refreshes runs without losing its search or selection (#5224)", async () => {
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

test("/workflows excludes active pauses and clamps recorded elapsed time (#5224)", () => {
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

async function liveListing(initialRuns: RunSnapshot[], terminal?: { rows: number }) {
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
						factory({ terminal, requestRender: () => rendersRequested++ }, undefined, undefined, () => {
							closeCalls++;
							resolve(undefined);
						}),
					);
				}),
		},
		{
			runs: () => runs,
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

test("workflow previews are disabled rather than advertised when their card cannot fit (#5224)", async () => {
	const terminal = { rows: 13 };
	const fixture = await liveListing(
		[run({ id: "preview", status: "running", stages: stages(["running"]) })],
		terminal,
	);
	try {
		assert.doesNotMatch(stripVTControlCharacters(fixture.component.render(80).join("\n")), /space.*preview/);
		fixture.component.handleInput?.(" ");
		assert.doesNotMatch(stripVTControlCharacters(fixture.component.render(80).join("\n")), /╭|id preview/);
		terminal.rows = 24;
		assert.match(stripVTControlCharacters(fixture.component.render(80).join("\n")), /space preview/);
		fixture.component.handleInput?.(" ");
		assert.match(stripVTControlCharacters(fixture.component.render(80).join("\n")), /id preview/);
		terminal.rows = 13;
		assert.doesNotMatch(
			stripVTControlCharacters(fixture.component.render(80).join("\n")),
			/space.*preview|╭|id preview/,
		);
		terminal.rows = 24;
		assert.match(stripVTControlCharacters(fixture.component.render(80).join("\n")), /space preview/);
	} finally {
		fixture.component.dispose?.();
		await fixture.result;
	}
});

for (const confirm of ["\r", "\x1b[C"]) {
	test(`/workflows honors Down followed by ${JSON.stringify(confirm)} before another frame (#5224)`, async () => {
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
	test(`/workflows paints a replacement before confirming it with ${JSON.stringify(key)} (#5224)`, async () => {
		const fallback = run({ id: "cccccccc", name: "deploy", status: "running", startedAt: NOW - 2 });
		const fixture = await liveListing([
			run({ id: "bbbbbbbb", status: "running", startedAt: NOW }),
			run({ id: "aaaaaaaa", status: "running", startedAt: NOW - 1 }),
			fallback,
		]);
		try {
			assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ ralph · bbbbbbbb/);
			fixture.update([fallback]);
			fixture.component.handleInput?.(key);
			fixture.component.handleInput?.(key);
			assert.equal(fixture.closeCalls, 0, "neither key may confirm an unseen replacement");
			assert.ok(fixture.rendersRequested > 0);
			assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ deploy · cccccccc/);
			fixture.component.handleInput?.(key);
			assert.deepEqual(await fixture.result, { kind: "run", runId: "cccccccc" });
			assert.equal(fixture.releases, 1);
		} finally {
			fixture.component.dispose?.();
		}
	});
}

test("/workflows honors a typed search and Enter before another frame (#5224)", async () => {
	const fixture = await liveListing([
		run({ id: "alpha", status: "running", startedAt: NOW }),
		run({ id: "deploy-1", name: "deploy", status: "running", startedAt: NOW - 1 }),
	]);
	const stdin = new StdinBuffer();
	stdin.on("data", (key) => fixture.component.handleInput?.(key));
	try {
		fixture.component.render(120);
		stdin.process("deploy\r");
		assert.equal(fixture.closeCalls, 1);
		assert.deepEqual(await fixture.result, { kind: "run", runId: "deploy-1" });
	} finally {
		stdin.destroy();
		fixture.component.dispose?.();
	}
});

for (const chunk of ["\r", "\x1b[B\r"]) {
	test(`/workflows waits for its first frame before confirming ${JSON.stringify(chunk)} (#5224)`, async () => {
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
	test(`/workflows waits for a refreshed frame after moving off a run with ${JSON.stringify(confirm)} (#5224)`, async () => {
		const fallback = run({ id: "deploy-1", name: "deploy", status: "running", startedAt: NOW - 1 });
		const fixture = await liveListing([run({ id: "alpha", status: "running", startedAt: NOW }), fallback]);
		const stdin = new StdinBuffer();
		stdin.on("data", (key) => fixture.component.handleInput?.(key));
		try {
			fixture.component.handleInput?.("\x1b[B");
			assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ deploy · deploy-1/);
			fixture.update([fallback]);
			stdin.process(`\x1b[A${confirm}`);
			assert.equal(fixture.closeCalls, 0, "Up must not confirm the row it tried to leave");
			fixture.component.render(120);
			stdin.process(confirm);
			assert.equal(fixture.closeCalls, 1);
			assert.deepEqual(await fixture.result, { kind: "run", runId: "deploy-1" });
		} finally {
			stdin.destroy();
			fixture.component.dispose?.();
		}
	});
}

test("/workflows waits for a refreshed frame after navigation before a store change (#5224)", async () => {
	const alpha = run({ id: "alpha", status: "running", startedAt: NOW - 1 });
	const beta = run({ id: "beta", status: "running", startedAt: NOW });
	const gamma = run({ id: "gamma", name: "deploy", status: "running", startedAt: NOW - 2 });
	const fixture = await liveListing([alpha, beta, gamma]);
	try {
		assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ ralph · beta/);
		fixture.component.handleInput?.("\x1b[B");
		fixture.update([beta, gamma]);
		fixture.component.handleInput?.("\r");
		assert.equal(fixture.closeCalls, 0, "the refresh must not replace the row chosen by Down");
		assert.match(stripVTControlCharacters(fixture.component.render(120).join("\n")), /❯ deploy · gamma/);
		fixture.component.handleInput?.("\r");
		assert.equal(fixture.closeCalls, 1);
		assert.deepEqual(await fixture.result, { kind: "run", runId: "gamma" });
	} finally {
		fixture.component.dispose?.();
	}
});

test("/workflows does not confirm a search replacement before painting, even after cursor input (#5224)", async () => {
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

test("/workflows still confirms the painted row when other runs change (#5224)", async () => {
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

test("/workflows settles when a custom UI host resolves without mounting (#5224)", async () => {
	let settled = false;
	let factoryCalled = false;
	const pending = openWorkflowsListing(
		{ custom: async () => undefined },
		{
			runs: () => {
				factoryCalled = true;
				return [];
			},
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

test("/workflows mounts as navigation rather than an approval prompt (#5224)", async () => {
	let purpose: string | undefined;
	const pending = openWorkflowsListing(
		{
			custom: async (_factory, options) => {
				purpose = options.purpose;
			},
		},
		{ runs: () => [] },
	);
	assert.equal(purpose, "navigation");
	assert.equal(await pending, undefined);
});

for (const mode of ["reject", "throw"] as const) {
	test(`/workflows settles when its custom UI host fails before mounting with ${mode} (#5224)`, async () => {
		const failure = new Error("host unavailable");
		const pending = openWorkflowsListing(
			{
				custom: () => {
					if (mode === "throw") throw failure;
					return Promise.reject(failure);
				},
			},
			{ runs: () => [] },
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
	test(`/workflows releases its subscription when the mounted host later ${mode}s (#5224)`, async () => {
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
			{ runs: () => [], subscribe: () => () => releases++ },
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

test("/workflows keeps its chosen row when done synchronously disposes the mount (#5224)", async () => {
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

function mountListing(runs: readonly RunSnapshot[]) {
	let component: PiCustomComponent | undefined;
	let closed = 0;
	const pending = openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows: 30 } }, undefined, undefined, () => {
						closed++;
						resolve(undefined);
					}) as PiCustomComponent;
				}),
		},
		{ runs: () => runs },
	);
	assert.ok(component);
	return { component, pending, closed: () => closed };
}

test("an empty /workflows sheet names the configured close key and closes with it (#5224)", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager({ "tui.select.cancel": "ctrl+q" }));
	const { component, pending, closed } = mountListing([]);
	try {
		const painted = stripVTControlCharacters(component.render(80).join("\n"));
		assert.match(painted, /ctrl\+q to close/);
		assert.doesNotMatch(painted, /esc/i);
		component.handleInput?.("\x1b");
		assert.equal(closed(), 0, "Esc no longer closes once cancel is remapped");
		component.handleInput?.("\x11");
		assert.equal(closed(), 1);
		assert.equal(await pending, undefined);
	} finally {
		component.dispose?.();
	}
});

test("Ctrl+C closes /workflows from a preview or a search in legacy, Kitty and modifyOtherKeys encodings (#5224)", async () => {
	initTheme("dark");
	const runs = [run({ id: "aaaa1111-2222", status: "running", startedAt: NOW, stages: stages(["running"]) })];
	for (const ctrlC of ["\x03", "\x1b[99;5u", "\x1b[27;5;99~"]) {
		for (const setup of ["preview", "search"] as const) {
			const { component, pending, closed } = mountListing(runs);
			try {
				component.render(120);
				if (setup === "preview") component.handleInput?.(" ");
				else component.handleInput?.("r");
				component.render(120);
				component.handleInput?.(ctrlC);
				assert.equal(closed(), 1, `${JSON.stringify(ctrlC)} closes the sheet from its ${setup}`);
				assert.equal(await pending, undefined);
			} finally {
				component.dispose?.();
			}
		}
	}
});

test("/workflows paints no foreground colour when NO_COLOR is set (#5224)", async () => {
	vi.stubEnv("NO_COLOR", "1");
	try {
		initTheme("dark");
		const runs = [
			run({ id: "aaaa1111-2222", status: "running", startedAt: NOW, stages: stages(["completed", "running"]) }),
			run({ id: "bbbb3333-4444", status: "failed", startedAt: NOW - 120_000, endedAt: NOW - 60_000 }),
		];
		const { component, pending } = mountListing(runs);
		try {
			component.handleInput?.(" ");
			const raw = component.render(120).join("\n");
			assert.match(stripVTControlCharacters(raw), /id aaaa1111-2222/);
			assert.doesNotMatch(raw, /\x1b\[(?:3[0-7]|9[0-7]|38;)[0-9;]*m/, JSON.stringify(raw.slice(0, 400)));
		} finally {
			component.dispose?.();
			await Promise.race([pending, Promise.resolve()]);
		}
	} finally {
		vi.unstubAllEnvs();
		initTheme("dark");
	}
});

test("a narrow /workflows preview wraps the full run id instead of cutting it (#5224)", async () => {
	initTheme("dark");
	const id = "0f6c2b8e-1d4a-4c9b-9e2f-7a3b5c6d8e90";
	const { component, pending } = mountListing([
		run({ id, status: "running", startedAt: NOW, stages: stages(["running"]) }),
	]);
	try {
		component.handleInput?.(" ");
		const raw = component.render(40);
		for (const line of raw) assert.ok(visibleWidth(line) <= 40, line);
		const lines = raw.map((line) => stripVTControlCharacters(line));
		const card = lines
			.filter((line) => line.startsWith("  │ "))
			.map((line) => line.slice(4).replace(/\s*│$/, "").trim());
		assert.ok(card.join("").replace(/\s/g, "").includes(`id${id}`), card.join("\n"));
	} finally {
		component.dispose?.();
		await Promise.race([pending, Promise.resolve()]);
	}
});
