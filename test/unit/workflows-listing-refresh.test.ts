import assert from "node:assert/strict";
import { CURSOR_MARKER, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	openWorkflowsListing,
	type WorkflowsListingDefinition,
	type WorkflowsListingTarget,
} from "../../packages/workflows/src/tui/workflows-listing.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
});
afterEach(() => {
	setKeybindings(previousKeys);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const T0 = 10_000_000;
const DOWN = "\x1b[B";
const ENTER = "\r";

function run(overrides: Partial<RunSnapshot> & Pick<RunSnapshot, "id" | "name" | "status">): RunSnapshot {
	return { inputs: {}, stages: [], toolNodes: [], startedAt: 0, ...overrides } as RunSnapshot;
}

function mount(
	runs: () => readonly RunSnapshot[],
	definitions: readonly WorkflowsListingDefinition[],
	tui: { requestRender?: () => void } = {},
) {
	let component: PiCustomComponent | undefined;
	const outcome: { settled: boolean; result: WorkflowsListingTarget | undefined } = {
		settled: false,
		result: undefined,
	};
	void openWorkflowsListing(
		{
			custom: (factory) =>
				new Promise<undefined>((resolve) => {
					component = factory(
						{ requestRender: tui.requestRender ?? (() => {}), terminal: { rows: 40 } },
						undefined,
						undefined,
						() => resolve(undefined),
					) as PiCustomComponent;
				}),
		},
		{ runs, definitions: () => definitions },
	).then((result) => {
		outcome.settled = true;
		outcome.result = result;
	});
	assert.ok(component);
	return { component, outcome };
}

const CLOCK_CASES: ReadonlyArray<{
	readonly name: string;
	readonly query: string;
	readonly runs: readonly RunSnapshot[];
	readonly definitions: readonly WorkflowsListingDefinition[];
	readonly paintedSecond: string;
}> = [
	{
		name: "drops a matched row",
		query: "now",
		runs: [
			run({ id: "aaaaaaaa", name: "now", status: "running", startedAt: T0 - 300_000 }),
			run({ id: "bbbbbbbb", name: "wf2", status: "completed", startedAt: T0 - 62_000, endedAt: T0 - 59_500 }),
		],
		definitions: [{ normalizedName: "snowdrop", description: "d", inputs: {} }],
		paintedSecond: "run:bbbbbbbb",
	},
	{
		name: "reorders the rows",
		query: "ago",
		runs: [
			run({ id: "aaaaaaaa", name: "ago-top", status: "running", startedAt: T0 - 300_000 }),
			run({ id: "bbbbbbbb", name: "axgxo", status: "completed", startedAt: T0 - 62_000, endedAt: T0 - 59_500 }),
			run({ id: "cccccccc", name: "axxxgo", status: "running", startedAt: T0 - 400_000 }),
		],
		definitions: [],
		paintedSecond: "run:cccccccc",
	},
	{
		name: "swaps a matched row",
		query: "1m",
		runs: [
			run({ id: "aaaaaaaa", name: "1m-top", status: "running", startedAt: T0 - 300_000 }),
			run({ id: "bbbbbbbb", name: "wf", status: "completed", startedAt: T0 - 121_000, endedAt: T0 - 119_500 }),
			run({ id: "cccccccc", name: "wf", status: "completed", startedAt: T0 - 62_000, endedAt: T0 - 59_500 }),
		],
		definitions: [],
		paintedSecond: "run:bbbbbbbb",
	},
];

for (const clockCase of CLOCK_CASES) {
	test(`Enter waits for a new frame when a clock refresh ${clockCase.name} under a search (#5245)`, async () => {
		let clock = T0;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const { component, outcome } = mount(() => clockCase.runs, clockCase.definitions);
		for (const char of clockCase.query) component.handleInput?.(char);
		component.render(110);
		clock += 1_000;
		component.handleInput?.(DOWN);
		component.handleInput?.(ENTER);
		await Promise.resolve();
		const target =
			outcome.result?.kind === "run"
				? `run:${outcome.result.runId}`
				: outcome.result?.kind === "definition"
					? `definition:${outcome.result.name}`
					: undefined;
		assert.ok(
			!outcome.settled || target === clockCase.paintedSecond,
			`Enter acted on ${target}; the row painted below the cursor was ${clockCase.paintedSecond}`,
		);
		component.dispose?.();
	});
}

test("keys within one clock tick reuse the built rows (#5245)", () => {
	let clock = T0;
	vi.spyOn(Date, "now").mockImplementation(() => clock);
	let stageReads = 0;
	const runs = Array.from({ length: 50 }, (_, index) => {
		const snapshot = run({ id: `run-${index}`, name: "ralph", status: "running", startedAt: T0 - index * 1_000 });
		Object.defineProperty(snapshot, "stages", {
			get() {
				stageReads += 1;
				return [];
			},
		});
		return snapshot;
	});
	const { component } = mount(() => runs, []);
	component.render(100);
	const afterFrame = stageReads;
	for (let key = 0; key < 5; key++) {
		clock += 100;
		component.handleInput?.(DOWN);
	}
	assert.equal(stageReads, afterFrame);
	component.dispose?.();
});

test("the clock tick asks for a frame only when a row's text changes (#5245)", () => {
	vi.useFakeTimers({ now: T0 });
	let renders = 0;
	const ended = [
		run({
			id: "old-a",
			name: "ralph",
			status: "completed",
			startedAt: T0 - 6 * 86_400_000,
			endedAt: T0 - 5.5 * 86_400_000,
		}),
		run({
			id: "old-b",
			name: "ralph",
			status: "failed",
			startedAt: T0 - 7 * 86_400_000,
			endedAt: T0 - 6.5 * 86_400_000,
		}),
	];
	const { component } = mount(() => ended, [], { requestRender: () => renders++ });
	component.render(100);
	vi.advanceTimersByTime(30_000);
	assert.equal(renders, 0);
	component.dispose?.();
});

test("the sheet places the terminal cursor in its search field while focused (#5245)", () => {
	const { component } = mount(() => [run({ id: "a", name: "ralph", status: "running", startedAt: Date.now() })], []);
	const focusable = component as PiCustomComponent & { focused?: boolean };
	assert.ok("focused" in focusable);
	focusable.focused = true;
	assert.ok(component.render(100)[0]!.includes(CURSOR_MARKER));
	focusable.focused = false;
	assert.ok(!component.render(100)[0]!.includes(CURSOR_MARKER));
	component.dispose?.();
});
