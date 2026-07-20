/**
 * `/workflow resume` picker over the host session-picker capability.
 *
 * The picker mounts exclusively through `ctx.ui.hostSessionPicker` — there is
 * no remote-rendered path. `openWorkflowResumeSelector` must drive the host
 * picker end-to-end: live rows seed the open, hydrate() runs once and merges
 * via a row update, watch/poll refreshes push updates, deletion is
 * extension-owned (live rows protected), the picker settles once with the
 * resolved catalog, and a host without the capability rejects with one
 * actionable error. Row building/sorting is covered by
 * workflow-resume-selector.test.ts.
 */
import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineSessionPickerService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-session-picker.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { SessionPickerHostController } from "../../packages/coding-agent/src/modes/interactive-engine/session-picker-host.ts";
import type { SessionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/session-selector.ts";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import type { DurableWorkflowDeleteOutcome } from "../../packages/workflows/src/durable/retention-policy.js";
import type { ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import type {
	PiHostSessionPickerFunction,
	PiHostSessionPickerRequest,
	PiHostSessionPickerRow,
} from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	openWorkflowResumeSelector,
	WORKFLOW_RESUME_PICKER_UNAVAILABLE,
	type WorkflowResumeCatalogRows,
} from "../../packages/workflows/src/tui/workflow-resume-selector.js";

async function flush(times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function entry(
	id: string,
	status: ResumableWorkflowEntry["status"],
	updatedAt = 200,
): ResumableWorkflowEntry {
	return {
		workflowId: id,
		name: `${status}-workflow`,
		status,
		completedCheckpoints: 2,
		pendingPrompts: 0,
		createdAt: 1,
		updatedAt,
	};
}

function pausedLiveRun(id = "live-paused", activityAt = 100): RunSnapshot {
	return {
		id,
		name: "live-workflow",
		inputs: {},
		status: "paused",
		stages: [],
		startedAt: 1,
		pausedAt: activityAt,
		resumable: true,
	};
}

interface FakeHostPicker {
	readonly hostSessionPicker: PiHostSessionPickerFunction;
	readonly opens: PiHostSessionPickerRequest[];
	readonly updates: PiHostSessionPickerRow[][];
	readonly errors: string[];
	select(path: string): void;
	cancel(): void;
	deleteRow(path: string): Promise<void>;
}

function makeFakeHostPicker(): FakeHostPicker {
	const opens: PiHostSessionPickerRequest[] = [];
	const updates: PiHostSessionPickerRow[][] = [];
	const errors: string[] = [];
	let resolveResult: ((path: string | undefined) => void) | undefined;
	let onDelete: ((path: string) => void | Promise<void>) | undefined;
	return {
		opens,
		updates,
		errors,
		hostSessionPicker: (request) => {
			opens.push(request);
			onDelete = request.onDelete;
			return {
				result: new Promise<string | undefined>((resolve) => { resolveResult = resolve; }),
				update: (sessions) => updates.push(sessions),
				error: (message) => errors.push(message),
				close: () => resolveResult?.(undefined),
			};
		},
		select: (path) => resolveResult?.(path),
		cancel: () => resolveResult?.(undefined),
		deleteRow: async (path) => { await onDelete?.(path); },
	};
}

describe("workflow resume selector host-picker path", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("opens with live rows, merges hydrate via update, and resolves the selection", async () => {
		const picker = makeFakeHostPicker();
		let hydrateCalls = 0;
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: picker.hostSessionPicker },
			[pausedLiveRun("live-a", 100)],
			async () => {
				hydrateCalls += 1;
				return { durable: [entry("durable-a", "paused")], completed: [] };
			},
		);

		assert.equal(picker.opens.length, 1, "picker opened exactly once");
		assert.deepEqual(picker.opens[0]!.sessions.map((row) => row.id), ["live-a"], "live rows seed the open");
		assert.equal(picker.opens[0]!.showRenameHint, false);

		await flush();
		assert.equal(hydrateCalls, 1, "hydrate invoked exactly once");
		assert.equal(picker.updates.length, 1, "hydrate merged via a single update");
		assert.deepEqual(picker.updates[0]!.map((row) => row.id).sort(), ["durable-a", "live-a"]);

		picker.select("workflow-durable:durable-a");
		const outcome = await promise;
		assert.deepEqual(outcome.result, { kind: "durable", workflowId: "durable-a" });
		assert.equal(outcome.catalog.durable.length, 1, "resolved catalog returned for follow-on resume");
	});

	test("cancel resolves close and still returns the hydrated catalog", async () => {
		const picker = makeFakeHostPicker();
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: picker.hostSessionPicker },
			[],
			async () => ({ durable: [entry("durable-a", "paused")], completed: [] }),
		);
		await flush();

		picker.cancel();
		const outcome = await promise;
		assert.deepEqual(outcome.result, { kind: "close" });
		assert.equal(outcome.catalog.durable.length, 1);
	});

	test("hydrate failure keeps the seeded rows and surfaces an in-picker error", async () => {
		const picker = makeFakeHostPicker();
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: picker.hostSessionPicker },
			[pausedLiveRun("live-a", 100)],
			async () => {
				throw new Error("catalog boom");
			},
		);
		await flush();

		assert.equal(picker.updates.length, 0, "failed hydrate pushes no row update");
		assert.deepEqual(picker.errors, ["Failed to load sessions: catalog boom"]);

		picker.cancel();
		const outcome = await promise;
		assert.deepEqual(outcome.result, { kind: "close" });
		assert.equal(outcome.catalog.durable.length, 0);
	});

	test("watch-triggered refresh pushes debounced updates while open, never after settle", async () => {
		const picker = makeFakeHostPicker();
		let onChange: (() => void) | undefined;
		let unsubscribed = 0;
		let refreshCalls = 0;
		let rows: WorkflowResumeCatalogRows = { durable: [], completed: [] };
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: picker.hostSessionPicker },
			[pausedLiveRun("live-a", 100)],
			async () => rows,
			{
				refreshIntervalMs: 0,
				watch: (change) => {
					onChange = change;
					return () => { unsubscribed += 1; };
				},
				refresh: async () => {
					refreshCalls += 1;
					return { liveRuns: [], catalog: rows };
				},
			},
		);
		await flush();
		assert.ok(onChange, "watch registered after open");
		const updatesAfterHydrate = picker.updates.length;

		rows = { durable: [entry("d-now-paused", "paused")], completed: [] };
		onChange!();
		await new Promise((resolve) => setTimeout(resolve, 300));
		await flush();

		assert.equal(refreshCalls, 1, "debounced watch refresh ran once");
		assert.ok(picker.updates.length > updatesAfterHydrate, "refresh pushed a row update");
		const latest = picker.updates.at(-1)!;
		assert.deepEqual(latest.map((row) => row.id), ["d-now-paused"], "stale live row dropped, transitioned row appears");

		picker.cancel();
		await promise;
		assert.equal(unsubscribed, 1, "watch unsubscribed on settle");

		onChange!();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(refreshCalls, 1, "no refresh after settle");
	});

	test("interval polling pushes cross-session updates and stops on settle", async () => {
		const picker = makeFakeHostPicker();
		let refreshCalls = 0;
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: picker.hostSessionPicker },
			[],
			async () => ({ durable: [], completed: [] }),
			{
				refreshIntervalMs: 40,
				refresh: async () => {
					refreshCalls += 1;
					return {
						liveRuns: [],
						catalog: { durable: [entry("d-from-poll", "paused")], completed: [] },
					};
				},
			},
		);
		await flush();
		await new Promise((resolve) => setTimeout(resolve, 130));
		await flush();

		assert.ok(refreshCalls >= 2, `interval refresh ran (${refreshCalls})`);
		assert.deepEqual(picker.updates.at(-1)!.map((row) => row.id), ["d-from-poll"]);

		picker.cancel();
		await promise;
		const settledCalls = refreshCalls;
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(refreshCalls, settledCalls, "interval stops after settle");
	});

	test("failed refresh keeps the previous rows", async () => {
		const picker = makeFakeHostPicker();
		let fail = false;
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: picker.hostSessionPicker },
			[],
			async () => ({ durable: [entry("durable-a", "paused")], completed: [] }),
			{
				refreshIntervalMs: 30,
				refresh: async () => {
					if (fail) throw new Error("refresh boom");
					return { liveRuns: [], catalog: { durable: [entry("durable-a", "paused")], completed: [] } };
				},
			},
		);
		await flush();
		fail = true;
		const updatesBefore = picker.updates.length;
		await new Promise((resolve) => setTimeout(resolve, 100));
		await flush();
		assert.equal(picker.updates.length, updatesBefore, "failed refreshes push no updates");

		picker.cancel();
		const outcome = await promise;
		assert.equal(outcome.catalog.durable.length, 1, "previous catalog retained");
	});

	test("delete flow: live rows protected, durable delete waits for the child update", async () => {
		const picker = makeFakeHostPicker();
		const deleted: string[] = [];
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: picker.hostSessionPicker },
			[pausedLiveRun("live-a", 500)],
			async () => ({ durable: [entry("durable-a", "paused")], completed: [] }),
			{
				deleteWorkflow: async (workflowId): Promise<DurableWorkflowDeleteOutcome> => {
					deleted.push(workflowId);
					return workflowId === "durable-a"
						? { ok: true, message: "deleted" }
						: { ok: false, message: "delete refused" };
				},
			},
		);
		await flush();

		// Live rows can never be deleted.
		await picker.deleteRow("workflow-live:live-a");
		assert.deepEqual(picker.errors, ["Cannot delete an in-flight workflow run"]);
		assert.deepEqual(deleted, []);

		// Durable rows delete through the callback and reply with an update.
		const updatesBefore = picker.updates.length;
		await picker.deleteRow("workflow-durable:durable-a");
		assert.deepEqual(deleted, ["durable-a"]);
		assert.equal(picker.updates.length, updatesBefore + 1, "successful delete replies with an update");
		assert.deepEqual(picker.updates.at(-1)!.map((row) => row.id), ["live-a"], "deleted row removed from the update");

		picker.cancel();
		await promise;
	});

	test("delete errors surface without removing the row; no deleteWorkflow means unavailable", async () => {
		const failing = makeFakeHostPicker();
		const failingPromise = openWorkflowResumeSelector(
			{ hostSessionPicker: failing.hostSessionPicker },
			[],
			async () => ({ durable: [entry("durable-a", "paused")], completed: [] }),
			{ deleteWorkflow: async () => ({ ok: false, message: "backend says no" }) },
		);
		await flush();
		const updatesBefore = failing.updates.length;
		await failing.deleteRow("workflow-durable:durable-a");
		assert.deepEqual(failing.errors, ["backend says no"]);
		assert.equal(failing.updates.length, updatesBefore, "failed delete pushes no row update");
		failing.cancel();
		await failingPromise;

		const unavailable = makeFakeHostPicker();
		const unavailablePromise = openWorkflowResumeSelector(
			{ hostSessionPicker: unavailable.hostSessionPicker },
			[],
			async () => ({ durable: [entry("durable-a", "paused")], completed: [] }),
		);
		await flush();
		await unavailable.deleteRow("workflow-durable:durable-a");
		assert.deepEqual(unavailable.errors, ["Workflow history deletion is unavailable"]);
		unavailable.cancel();
		await unavailablePromise;
	});

	test("rejects with one actionable error when the capability is absent (no fallback)", async () => {
		let hydrateCalls = 0;
		await assert.rejects(
			openWorkflowResumeSelector(
				{},
				[pausedLiveRun()],
				async () => {
					hydrateCalls += 1;
					return { durable: [], completed: [] };
				},
			),
			(error: Error) => {
				assert.equal(error.message, WORKFLOW_RESUME_PICKER_UNAVAILABLE);
				assert.match(error.message, /\/workflow resume <id>/, "error tells the user the direct-resume escape hatch");
				return true;
			},
		);
		assert.equal(hydrateCalls, 0, "no hydration without a picker");
	});

	test("settling before hydrate resolves suppresses the late update and returns an empty catalog", async () => {
		const picker = makeFakeHostPicker();
		let resolveHydrate!: (rows: WorkflowResumeCatalogRows) => void;
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: picker.hostSessionPicker },
			[pausedLiveRun("live-a", 100)],
			() => new Promise<WorkflowResumeCatalogRows>((resolve) => { resolveHydrate = resolve; }),
		);
		await flush();

		picker.cancel();
		const outcome = await promise;
		assert.deepEqual(outcome.result, { kind: "close" });
		assert.equal(outcome.catalog.durable.length, 0, "catalog empty because settled before hydrate");

		// Late-resolving hydration must not reach the settled picker.
		resolveHydrate({ durable: [entry("late", "paused")], completed: [] });
		await flush();
		assert.equal(picker.updates.length, 0, "late hydration pushes no update after settle");
	});
});

describe("workflow resume selector host-picker end-to-end (real engine bridge)", () => {
	const previousKeybindings = getKeybindings();
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterAll(() => {
		// Restore the previous global so later test files see their defaults.
		setKeybindings(previousKeybindings);
	});

	interface Bridge {
		readonly child: EngineSessionPickerService;
		readonly controller: SessionPickerHostController;
		readonly childCommands: InteractiveEngineCommand[];
		component(): SessionSelectorComponent;
	}

	function makeBridge(): Bridge {
		const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
		const childCommands: InteractiveEngineCommand[] = [];
		let component: SessionSelectorComponent | undefined;

		const child = new EngineSessionPickerService((line) => {
			const message = parseInteractiveEngineMessage(line);
			if (!message) return;
			for (const listener of [...engineListeners]) listener(message);
		});

		const runtime = {
			onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
				engineListeners.push(listener);
				return () => {};
			},
			sendEngineCommand: (command: InteractiveEngineCommand) => {
				childCommands.push(command);
				child.handleLine(serializeInteractiveEngineFrame(command));
			},
		} as unknown as IsolatedInteractiveRuntime;

		const ui = {
			requestRender: () => {},
			setWidget: () => {},
			custom: (
				factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => SessionSelectorComponent,
			) =>
				new Promise((resolve) => {
					component = factory({ terminal: { rows: 40, columns: 120 }, requestRender: () => {} }, {}, {}, resolve);
				}),
		} as unknown as ExtensionUIContext;

		const controller = new SessionPickerHostController(runtime, ui);
		return {
			child,
			controller,
			childCommands,
			component: () => {
				if (!component) throw new Error("picker not mounted on the host");
				return component;
			},
		};
	}

	test("selection round-trips through the real host mount with zero-IPC navigation", async () => {
		const bridge = makeBridge();
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: (request) => bridge.child.open(request) },
			[pausedLiveRun("live-a", 100)],
			async () => ({ durable: [entry("durable-a", "paused", 200)], completed: [] }),
		);
		await flush();

		// Hydrated durable row reached the real host-mounted selector.
		const rendered = bridge.component().render(120).join("\n");
		assert.ok(rendered.includes("paused-workflow"), "durable row visible after hydrate update");
		assert.ok(rendered.includes("live-workflow"), "live row retained after merge");

		// Arrow-key navigation is host-local: zero child-bound commands.
		const commandsBefore = bridge.childCommands.length;
		bridge.component().handleInput("\x1b[B");
		bridge.component().handleInput("\x1b[A");
		bridge.component().render(120);
		await flush();
		assert.equal(bridge.childCommands.length, commandsBefore, "navigation crossed the process boundary");

		// Enter selects the durable row (most recent, cursor at the top).
		bridge.component().handleInput("\r");
		const outcome = await promise;
		assert.deepEqual(outcome.result, { kind: "durable", workflowId: "durable-a" });
		assert.equal(outcome.catalog.durable.length, 1);
		bridge.controller.dispose();
	});

	test("escape on the real host mount resolves close", async () => {
		const bridge = makeBridge();
		const promise = openWorkflowResumeSelector(
			{ hostSessionPicker: (request) => bridge.child.open(request) },
			[pausedLiveRun("live-a", 100)],
			async () => ({ durable: [], completed: [] }),
		);
		await flush();

		bridge.component().handleInput("\x1b");
		const outcome = await promise;
		assert.deepEqual(outcome.result, { kind: "close" });
		bridge.controller.dispose();
	});
});
