import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	createMemoryTestBackend,
	type MemoryJournalBackend as InMemoryDurableBackend,
} from "../helpers/workflow-journal.js";
import {
	attachHostCustomUiState,
	buildGraphOverlayAdapter,
	buildInteractiveHostCustomUi,
	buildMockPi,
	buildMockUi,
	buildOverlayHandle,
	buildPrintCtx,
	buildPrintCtxWithRealCustom,
	buildTestGraphStageActions,
	createCancellationRegistry,
	createJobTracker,
	createStore,
	delay,
	factory,
	invokeRunControl,
	runDetached,
	setupBranchingRun,
	setupSequentialRun,
	setupWideFanoutRun,
	singletonStore,
	Type,
	visibleText,
	waitForRenderCount,
	waitForRunEnded,
	waitForStagePendingPrompt,
	workflow,
} from "./overlay-entrypoints-helpers.js";

afterEach(() => toolControlRegistry.clear());
useTemporaryAgentDir();

void [
	buildGraphOverlayAdapter,
	buildInteractiveHostCustomUi,
	buildMockPi,
	buildMockUi,
	buildOverlayHandle,
	buildPrintCtx,
	buildPrintCtxWithRealCustom,
	attachHostCustomUiState,
	createCancellationRegistry,
	createJobTracker,
	createStore,
	workflow,
	delay,
	factory,
	runDetached,
	setupBranchingRun,
	setupSequentialRun,
	setupWideFanoutRun,
	singletonStore,
	Type,
	visibleText,
	waitForRenderCount,
	waitForRunEnded,
	waitForStagePendingPrompt,
];

async function registerInspectableCompleted(
	backend: InMemoryDurableBackend,
	workflowId: string,
	name: string,
): Promise<() => void> {
	const dir = mkdtempSync(join(tmpdir(), "atomic-completed-overlay-"));
	const sessionFile = join(dir, "stage.jsonl");
	writeFileSync(
		sessionFile,
		`${[
			JSON.stringify({
				type: "session",
				version: 4,
				id: `${workflowId}-session`,
				createdAt: new Date().toISOString(),
				cwd: dir,
			}),
			JSON.stringify({
				type: "message",
				id: `${workflowId}-message`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "prior context", timestamp: Date.now() },
			}),
		].join("\n")}\n`,
	);
	await backend.commitWorkflowRegistration({ workflowId, name, inputs: {}, createdAt: 1, status: "completed" });
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId,
		checkpointId: "stage:1",
		name: "final",
		replayKey: "stage:final:1",
		output: "done",
		sessionFile,
		completedAt: 2,
	});
	return () => rmSync(dir, { recursive: true, force: true });
}

describe("workflow resume — overlay integration", () => {
	beforeEach(async () => {
		setDurableBackend(await createMemoryTestBackend());
	});
	afterEach(() => setDurableBackend(undefined));
	test("resume with unknown runId prints not-found, does NOT call custom", async () => {
		const { pi, customCalls } = buildMockPi();
		factory(pi);

		const { ctx, messages } = buildPrintCtx();
		const unknownRunId = testRunId("no-such-run");

		await invokeRunControl(pi, "resume", [unknownRunId], ctx);

		assert.equal(customCalls.length, 0);
		assert.ok(
			messages.some((message) =>
				message.startsWith(
					`Workflow run not found: ${unknownRunId} in this session's workflow store (run-not-found).`,
				),
			),
			messages.join("\n"),
		);
	});

	test("resume with no runId prints usage", async () => {
		singletonStore.clear();
		const { pi } = buildMockPi();
		factory(pi);

		const { ctx, messages } = buildPrintCtx();

		await invokeRunControl(pi, "resume", [], ctx);

		assert.equal(
			messages.some((m) => m.includes("Usage")),
			true,
		);
	});

	test("resume with no runId opens durable picker when only durable entries exist", async () => {
		singletonStore.clear();
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: "durable-picker-run",
			name: "durable-wf",
			inputs: {},
			createdAt: Date.now(),
			status: "paused",
			completedCheckpoints: 1,
		});
		setDurableBackend(backend);
		try {
			const { pi } = buildMockPi();
			factory(pi);
			const { ctx, customCalls } = buildPrintCtxWithRealCustom();
			void invokeRunControl(pi, "resume", [], ctx);
			await delay(5);
			assert.equal(customCalls.length, 1);
			assert.equal(customCalls[0]!.options.overlay, false);
			const rendered = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
			assert.match(rendered, /Resume workflow run/);
			assert.match(rendered, /durable-wf\s+paused · /);
		} finally {
			setDurableBackend(undefined);
		}
	});

	test("resume with no runId ignores completed local runs when durable entries exist", async () => {
		singletonStore.clear();
		const completedRunId = `completed-local-${Date.now()}`;
		singletonStore.recordRunStart({
			id: completedRunId,
			name: "done",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		singletonStore.recordRunEnd(completedRunId, "completed", {});
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: "durable-after-completed",
			name: "durable-history",
			inputs: {},
			createdAt: Date.now(),
			status: "paused",
			completedCheckpoints: 1,
		});
		setDurableBackend(backend);
		try {
			const { pi } = buildMockPi();
			factory(pi);
			const { ctx, customCalls } = buildPrintCtxWithRealCustom();
			void invokeRunControl(pi, "resume", [], ctx);
			await delay(5);
			assert.equal(customCalls.length, 1);
			const rendered = visibleText(customCalls[0]!.component.render(80));
			assert.match(rendered, /durable-history\s+paused · /);
			assert.doesNotMatch(rendered, /done · /);
		} finally {
			setDurableBackend(undefined);
		}
	});

	test("resume with no runId opens live picker when paused runs exist", async () => {
		singletonStore.clear();
		const runId = `test-paused-picker-${Date.now()}`;
		singletonStore.recordRunStart({
			id: runId,
			name: "paused-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		singletonStore.recordRunPaused(runId);
		const { pi, customCalls } = buildMockPi();
		factory(pi);
		const { ctx, customCalls: realCustomCalls } = buildPrintCtxWithRealCustom();

		void invokeRunControl(pi, "resume", [], ctx);
		await delay(5);

		assert.equal(customCalls.length, 0);
		assert.ok(realCustomCalls.length >= 1);
		assert.equal(realCustomCalls[0]!.options.overlay, false);
	});

	test("/workflows argument completions list session run IDs instead of removed subcommands (#5224)", async () => {
		singletonStore.clear();
		const runId = testRunId("workflows-completion-run");
		singletonStore.recordRunStart({
			id: runId,
			name: "completion-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		const { pi, commands } = buildMockPi();
		factory(pi);

		assert.equal(commands.workflow, undefined);
		const workflowsCmd = commands.workflows!;
		const completions = (await workflowsCmd.options.getArgumentCompletions?.("")) ?? [];

		assert.equal(
			completions.some((c) => c.label === runId),
			true,
		);
		assert.equal(
			completions.some((c) => c.label === "resume"),
			false,
		);
		assert.equal(await workflowsCmd.options.getArgumentCompletions?.("res"), null);
	});

	test("resume with no runId mixes live and durable entries", async () => {
		singletonStore.clear();
		const liveRunId = `live-run-${Date.now()}`;
		singletonStore.recordRunStart({
			id: liveRunId,
			name: "live-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		singletonStore.recordRunPaused(liveRunId);
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: liveRunId,
			name: "live-wf",
			inputs: {},
			createdAt: Date.now(),
			status: "paused",
			completedCheckpoints: 1,
		});
		toolControlRegistry.registerRun(liveRunId, {
			paused: true,
			async pause() {},
			async resume() {},
			async quit() {},
		});
		await backend.commitWorkflowRegistration({
			workflowId: "durable-alongside-live",
			name: "durable-cross-session",
			inputs: {},
			createdAt: Date.now(),
			status: "paused",
			completedCheckpoints: 1,
		});
		setDurableBackend(backend);
		try {
			const { pi } = buildMockPi();
			factory(pi);
			const { ctx, customCalls } = buildPrintCtxWithRealCustom();
			const handlerPromise = invokeRunControl(pi, "resume", [], ctx);
			await delay(5);
			assert.ok(customCalls.length >= 1);
			const text = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
			assert.match(text, /live-wf\s+paused · /);
			assert.match(text, /durable-cross-session\s+paused · /);
			customCalls[0]!.component.handleInput?.("\u001b");
			await handlerPromise;
		} finally {
			setDurableBackend(undefined);
		}
	});

	test("resume with known authoritative completed runId calls overlay.open", async () => {
		singletonStore.clear();
		const runId = testRunId(`test-resume-run-${Date.now()}`);
		const backend = await createMemoryTestBackend();
		const cleanup = await registerInspectableCompleted(backend, runId, "test-wf");
		setDurableBackend(backend);
		singletonStore.recordRunStart({
			id: runId,
			name: "stale-local",
			inputs: {},
			status: "completed",
			toolNodes: [],
			stages: [],
			startedAt: 1,
			endedAt: 2,
			resumable: false,
		});
		try {
			const { pi, customCalls } = buildMockPi();
			factory(pi);
			const { ctx } = buildPrintCtx();

			await invokeRunControl(pi, "resume", [runId], ctx);

			assert.ok(customCalls.length >= 1);
			assert.equal(customCalls[0]!.options.overlay, true);
			assert.equal(singletonStore.runs()[0]?.name, "test-wf");
			assert.equal(singletonStore.runs()[0]?.stages[0]?.name, "final");
		} finally {
			cleanup();
		}
	});

	test("resume of an actively-running run is refused (use /workflows, #5224)", async () => {
		const runId = testRunId(`test-active-run-${Date.now()}`);

		singletonStore.recordRunStart({
			id: runId,
			name: "active-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});

		const { pi, customCalls } = buildMockPi();
		factory(pi);

		const { ctx, messages } = buildPrintCtx();

		await invokeRunControl(pi, "resume", [runId], ctx);

		assert.equal(customCalls.length, 0);
		const joined = messages.join("\n");
		assert.match(joined, /already running/);
		assert.match(joined, /\/workflows /);
	});

	test("resume uses the real command ctx.ui when top-level pi.ui is absent", async () => {
		singletonStore.clear();

		const { pi } = buildMockPi();
		delete pi.ui;
		factory(pi);

		const { ctx, customCalls } = buildPrintCtxWithRealCustom();

		const handlerPromise = invokeRunControl(pi, "resume", [], ctx) as Promise<unknown>;
		await delay(5);
		assert.ok(customCalls.length >= 1);
		customCalls[0]!.component.handleInput?.("\u001b");
		await handlerPromise;
	});

	test("workflow tool run does NOT auto-open the overlay when autoAttach is omitted (opt-in via F2, #5224)", async () => {
		const { pi, tools } = buildMockPi();
		delete pi.ui;
		factory(pi);

		const { ctx, customCalls } = buildPrintCtxWithRealCustom();
		const res = await tools.workflow!.execute(
			"test-run-call",
			{ action: "run", workflow: "fan-out-and-synthesize", inputs: { prompt: "test", max_branches: 1 } },
			undefined,
			undefined,
			ctx as never,
		);
		const runId = (res.details as { runId?: string }).runId;
		if (runId) await waitForRunEnded(singletonStore, runId, 5000);

		assert.equal(customCalls.length, 0);
	});
});

describe("workflow pause — run control and graph stage actions", () => {
	test("pause with no args and no active runs prints a hint", async () => {
		singletonStore.clear();
		const { pi } = buildMockPi();
		factory(pi);
		const { ctx, messages } = buildPrintCtx();
		await invokeRunControl(pi, "pause", [], ctx);
		const joined = messages.join("\n");
		assert.equal(joined, "No in-flight runs to pause.");
	});

	test("pause <unknown> prints not-found", async () => {
		singletonStore.clear();
		const { pi } = buildMockPi();
		factory(pi);
		const { ctx, messages } = buildPrintCtx();
		const unknownRunId = testRunId("no-such-run");
		await invokeRunControl(pi, "pause", [unknownRunId], ctx);
		const joined = messages.join("\n");
		assert.match(joined, /Run not found/);
		const graphPause = await buildTestGraphStageActions(pi, ctx).pauseRun!(unknownRunId);
		assert.deepEqual(graphPause, { ok: false, message: "That run is gone." });
	});
});

describe("workflow resume — paused vs non-paused branching", () => {
	beforeEach(async () => setDurableBackend(await createMemoryTestBackend()));
	afterEach(() => setDurableBackend(undefined));
	test("resume <runId> refuses a completed local snapshot without authoritative data", async () => {
		singletonStore.clear();
		const runId = testRunId(`test-non-paused-${Date.now()}`);
		singletonStore.recordRunStart({
			id: runId,
			name: "snap-only-wf",
			inputs: {},
			status: "completed",
			toolNodes: [],
			stages: [],
			startedAt: 1,
			endedAt: 2,
			resumable: false,
		});
		const { pi, customCalls } = buildMockPi();
		factory(pi);
		const { ctx, messages } = buildPrintCtx();
		await invokeRunControl(pi, "resume", [runId], ctx);
		assert.equal(customCalls.length, 0);
		assert.match(
			messages.join("\n"),
			/No resumable workflow|No durable workflow|No completed durable workflow|stale|\(run-not-found\)/,
		);
	});
});

describe("/workflows and the removed /workflow connect and /workflow attach — top-level commands", () => {
	beforeEach(async () => {
		setDurableBackend(await createMemoryTestBackend());
	});
	afterEach(() => setDurableBackend(undefined));
	test("/workflows <runId> opens the overlay (#5224)", async () => {
		singletonStore.clear();
		const runId = testRunId(`test-attach-${Date.now()}`);
		singletonStore.recordRunStart({
			id: runId,
			name: "attach-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		const { pi, commands, customCalls } = buildMockPi();
		factory(pi);
		const { ctx } = buildPrintCtx();
		await commands.workflows!.options.handler(runId, ctx);
		assert.ok(customCalls.length >= 1);
		assert.equal(customCalls[0]!.options.overlay, true);
	});

	test("/workflows <unknown> prints not-found and does not open the overlay (#5224)", async () => {
		singletonStore.clear();
		const { pi, commands, customCalls } = buildMockPi();
		factory(pi);
		const { ctx, messages } = buildPrintCtx();
		const unknownRunId = testRunId("not-a-run");
		await commands.workflows!.options.handler(unknownRunId, ctx);
		assert.match(messages.join("\n"), /Run not found/);
		assert.equal(customCalls.length, 0);
	});

	test("the removed /workflow attach and /workflow connect point to /workflows and open nothing (#5224)", async () => {
		singletonStore.clear();
		const runId = testRunId(`test-removed-${Date.now()}`);
		singletonStore.recordRunStart({
			id: runId,
			name: "removed-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		const { pi, commands, events, customCalls } = buildMockPi();
		factory(pi);
		assert.equal(commands.workflow, undefined);
		const inputHandler = (events.get("input") ?? [])[0]!;
		for (const subcommand of ["attach", "connect"]) {
			const { ctx, messages } = buildPrintCtx();
			const result = await inputHandler({ text: `/workflow ${subcommand} ${runId}`, source: "interactive" }, ctx);
			assert.deepEqual(result, { action: "handled" });
			assert.match(messages.join("\n"), /\/workflow was removed.*\/workflows/);
		}
		assert.equal(customCalls.length, 0);
	});

	test("durable resume <id> does NOT open the overlay when resume fails", async () => {
		singletonStore.clear();
		const { pi, customCalls } = buildMockPi();
		factory(pi);
		const { ctx } = buildPrintCtx();
		await invokeRunControl(pi, "resume", [testRunId("not-a-durable-wf")], ctx);
		assert.equal(customCalls.length, 0);
	});

	test("no-arg resume globally orders mixed live and durable choices by recency", async () => {
		singletonStore.clear();
		const now = Date.now();
		const liveRunId = `live-combined-${now}`;
		singletonStore.recordRunStart({
			id: liveRunId,
			name: "live-older-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: now,
		});
		singletonStore.recordRunPaused(liveRunId);
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: liveRunId,
			name: "live-older-wf",
			inputs: {},
			createdAt: now,
			status: "paused",
			completedCheckpoints: 1,
		});
		toolControlRegistry.registerRun(liveRunId, {
			paused: true,
			async pause() {},
			async resume() {},
			async quit() {},
		});
		await backend.commitWorkflowRegistration({
			workflowId: "durable-combined-wf",
			name: "durable-newer-wf",
			inputs: {},
			createdAt: now + 10_000,
			status: "paused",
			completedCheckpoints: 1,
		});
		setDurableBackend(backend);
		try {
			const { pi } = buildMockPi();
			factory(pi);
			const { ctx, customCalls } = buildPrintCtxWithRealCustom();
			const handlerPromise = invokeRunControl(pi, "resume", [], ctx);
			await delay(5);
			assert.ok(customCalls.length >= 1);
			assert.equal(customCalls[0]!.options.overlay, false);
			const text = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
			assert.match(text, /live-older-wf\s+paused · /);
			assert.match(text, /durable-newer-wf\s+paused · /);
			assert.ok(text.indexOf("durable-newer-wf") < text.indexOf("live-older-wf"));
			customCalls[0]!.component.handleInput?.("\u001b");
			await handlerPromise;
		} finally {
			setDurableBackend(undefined);
		}
	});

	test("no-arg resume with only live runs opens the /resume-style selector", async () => {
		singletonStore.clear();
		const liveRunId = `live-only-${Date.now()}`;
		singletonStore.recordRunStart({
			id: liveRunId,
			name: "only-live-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		singletonStore.recordRunPaused(liveRunId);
		const { pi, customCalls } = buildMockPi();
		factory(pi);
		const { ctx, customCalls: realCustomCalls } = buildPrintCtxWithRealCustom();
		void invokeRunControl(pi, "resume", [], ctx);
		await delay(5);
		assert.equal(customCalls.length, 0);
		assert.ok(realCustomCalls.length >= 1);
		assert.equal(realCustomCalls[0]!.options.overlay, false);
		const text = visibleText(realCustomCalls[0]!.component.render(80));
		assert.match(text, /Resume workflow run/);
		assert.doesNotMatch(text, /Open workflow run|Connect to workflow run/);
	});

	test("no-arg resume: dismissing shared selector does not open second live picker", async () => {
		singletonStore.clear();
		const liveRunId = `live-dismiss-${Date.now()}`;
		singletonStore.recordRunStart({
			id: liveRunId,
			name: "live-wf-dismiss",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		singletonStore.recordRunPaused(liveRunId);
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: "durable-dismiss-wf",
			name: "durable-dismiss",
			inputs: {},
			createdAt: Date.now(),
			status: "paused",
			completedCheckpoints: 1,
		});
		setDurableBackend(backend);
		try {
			const { pi } = buildMockPi();
			factory(pi);
			const { ctx, customCalls } = buildPrintCtxWithRealCustom();
			const handlerPromise = invokeRunControl(pi, "resume", [], ctx);
			await delay(5);
			assert.ok(customCalls.length >= 1);
			const pickerFactory = customCalls[0]!;
			pickerFactory.component.handleInput?.("\u001b");
			await handlerPromise;
			assert.equal(customCalls.length, 1);
		} finally {
			setDurableBackend(undefined);
		}
	});

	test("no-arg resume with live runs includes asynchronously hydrated durable entries", async () => {
		singletonStore.clear();
		const liveRunId = `live-hydrate-${Date.now()}`;
		singletonStore.recordRunStart({
			id: liveRunId,
			name: "live-hydrate-wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		singletonStore.recordRunPaused(liveRunId);
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: liveRunId,
			name: "live-hydrate-wf",
			inputs: {},
			createdAt: Date.now(),
			status: "paused",
			completedCheckpoints: 1,
		});
		toolControlRegistry.registerRun(liveRunId, {
			paused: true,
			async pause() {},
			async resume() {},
			async quit() {},
		});
		await backend.commitWorkflowRegistration({
			workflowId: "durable-hydrate-wf",
			name: "durable-hydrate",
			inputs: {},
			createdAt: Date.now(),
			status: "paused",
			completedCheckpoints: 1,
		});
		setDurableBackend(backend);
		try {
			const { pi } = buildMockPi();
			factory(pi);
			const { ctx, customCalls } = buildPrintCtxWithRealCustom();
			const handlerPromise = invokeRunControl(pi, "resume", [], ctx);
			await delay(10);
			assert.ok(customCalls.length >= 1);
			const text = visibleText(customCalls[0]!.component.render(80)).replace(/\n/g, " ");
			assert.match(text, /live-hydrate-wf\s+paused · /);
			assert.match(text, /durable-hydrate\s+paused · /);
			customCalls[0]!.component.handleInput?.("\u001b");
			await handlerPromise;
		} finally {
			setDurableBackend(undefined);
		}
	});
});

// ---------------------------------------------------------------------------
// Graph-mode Ctrl+X / `h` — non-destructive hide, never kills the run
// ---------------------------------------------------------------------------
