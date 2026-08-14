/**
 * Herdr pane state across a multi-gate workflow run, end to end.
 *
 * This drives the full real path the live defect crossed: a real executor run
 * with two sequential `ctx.ui` gates (confirm, then select), the real
 * lifecycle-notifications bridge publishing neutral events onto the runner's
 * bus, the real Herdr builtin consuming them through `ExtensionRunner`, the
 * real user-block door, and the real workflow graph overlay adapter mounted
 * through the runner's block-minting `ctx.ui.custom` wrapper — reporting to a
 * real protocol-speaking socket fixture.
 *
 * The regression it pins: opening the workflow graph overlay mints a "Custom
 * dialog" user block, and hiding the overlay (the Ctrl+X return-to-chat path,
 * which keeps the overlay mounted and its `custom()` promise pending by
 * design) must release that block. Before the fix the block leaked, and user
 * blocks outrank workflow contributions in the pane reducer, so the pane
 * stayed `blocked` through both gate answers, run completion, and everything
 * after — exactly the wedged pane observed live.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.ts";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.ts";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.ts";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { getOpenUserBlocks } from "../../packages/coding-agent/src/core/extensions/user-blocks.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import {
	rememberWorkflowLifecycleBridgeEvent,
	resetWorkflowLifecycleBridgeSnapshot,
	WORKFLOW_LIFECYCLE_EVENT,
} from "../../packages/coding-agent/src/core/workflow-lifecycle-events.ts";
import herdrExtension from "../../packages/coding-agent/src/extensions/herdr/index.ts";
import {
	type HerdrSocketFixture,
	type RecordedRequest,
	startHerdrSocketFixture,
} from "../../packages/coding-agent/test/herdr-socket-fixture.ts";
import { createModelRegistry } from "../../packages/coding-agent/test/model-runtime-test-utils.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createInMemoryTestBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { installWorkflowLifecycleNotifications } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { buildGraphOverlayAdapter, type OverlayPiSurface } from "../../packages/workflows/src/tui/overlay-adapter.js";

type WorkflowStore = ReturnType<typeof createStore>;

/** One externally released gate for pacing the workflow's tool phases. */
function phaseGate(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function waitForStagePrompt(
	store: WorkflowStore,
	promptKind: string,
	timeoutMs = 10_000,
): Promise<{ runId: string; stage: StageSnapshot }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const runSnapshot of store.runs()) {
			const stage = runSnapshot.stages.find(
				(candidate) => candidate.pendingPrompt !== undefined && candidate.pendingPrompt.kind === promptKind,
			);
			if (stage !== undefined) return { runId: runSnapshot.id, stage };
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`no pending ${promptKind} prompt appeared`);
}

describe("herdr pane across a multi-gate workflow run with the graph overlay", () => {
	let fixture: HerdrSocketFixture;
	let tempDir: string;
	let runner: ExtensionRunner | undefined;
	let saved: { env?: string; pane?: string; socket?: string };

	beforeEach(async () => {
		setDurableBackend(createInMemoryTestBackend());
		resetWorkflowLifecycleBridgeSnapshot();
		fixture = await startHerdrSocketFixture();
		tempDir = mkdtempSync(join(tmpdir(), "atomic-herdr-multigate-"));
		saved = {
			env: process.env.HERDR_ENV,
			pane: process.env.HERDR_PANE_ID,
			socket: process.env.HERDR_SOCKET_PATH,
		};
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-multigate";
		process.env.HERDR_SOCKET_PATH = fixture.socketPath;
	});

	afterEach(async () => {
		runner?.detachUserBlocks();
		runner = undefined;
		resetWorkflowLifecycleBridgeSnapshot();
		if (saved.env === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = saved.env;
		if (saved.pane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = saved.pane;
		if (saved.socket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = saved.socket;
		rmSync(tempDir, { recursive: true, force: true });
		await fixture.close();
	});

	function paneStates(requests: RecordedRequest[]): Array<{ state: string; message: string | undefined }> {
		return requests
			.filter((request) => request.method === "pane.report_agent")
			.map((request) => ({
				state: String(request.params.state),
				message: request.params.message === undefined ? undefined : String(request.params.message),
			}));
	}

	/** Wait until the newest pane report carries `state` (and `message`, when given). */
	async function waitForPaneState(state: string, message?: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const latest = paneStates(fixture.requests).at(-1);
			if (latest?.state === state && (message === undefined || latest.message === message)) return;
			if (Date.now() > deadline) {
				throw new Error(
					`timed out waiting for ${state}${message === undefined ? "" : ` (${message})`}; saw ${JSON.stringify(paneStates(fixture.requests))}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	it("drops the blocked contribution on each gate answer and at completion, overlay hidden", async () => {
		// --- The real Herdr builtin over a real runner, bus, and block door. ---
		const runtime = createExtensionRuntime();
		const bus = createEventBus();
		const extension = await loadExtensionFromFactory(herdrExtension, tempDir, bus, runtime, "<inline:herdr>");
		const modelRegistry = await createModelRegistry(AuthStorage.create(join(tempDir, "auth.json")));
		const built = new ExtensionRunner([extension], runtime, tempDir, SessionManager.inMemory(), modelRegistry);
		runner = built;

		// A host `custom()` in the real TUI's shape: pending until `done`, with an
		// OverlayHandle delivered through `options.onHandle`.
		let overlayHidden = false;
		const hostUi: ExtensionUIContext = {
			...noOpUIContext,
			custom: <T>(
				factory: Parameters<ExtensionUIContext["custom"]>[0],
				options?: Parameters<ExtensionUIContext["custom"]>[1],
			) =>
				new Promise<T>((resolve) => {
					const tui = {
						mode: "regular",
						requestRender: () => undefined,
						terminal: { rows: 24, columns: 80 },
					};
					void factory(tui as never, {} as never, {} as never, (result) => resolve(result as T));
					options?.onHandle?.({
						hide: () => {
							overlayHidden = true;
						},
						setHidden: (hidden: boolean) => {
							overlayHidden = hidden;
						},
						isHidden: () => overlayHidden,
						focus: () => undefined,
						unfocus: () => undefined,
						isFocused: () => true,
					});
				}),
		};
		built.setUIContext(hostUi, "tui");
		await built.emit({ type: "session_start", reason: "startup" });
		await fixture.waitForRequests(2);
		assert.deepEqual(paneStates(fixture.requests).at(-1), { state: "idle", message: undefined });

		// --- The real workflows bridge publishing onto the runner's bus. ---
		const store = createStore();
		const uninstall = installWorkflowLifecycleNotifications({
			store,
			config: { enabled: false, notifyOn: [] },
			publishLifecycleEvent: (event) => {
				rememberWorkflowLifecycleBridgeEvent(event, bus);
				bus.emit(WORKFLOW_LIFECYCLE_EVENT, { runKey: event.runKey, kind: event.kind, label: event.label });
			},
		});

		// --- The real graph overlay over the runner's block-minting ctx.ui. ---
		const runnerCtx = built.createContext();
		const overlaySurface: OverlayPiSurface = {
			ui: {
				custom: (factory, options) => {
					void runnerCtx.ui.custom(factory as never, options as never);
					return undefined;
				},
			},
		};
		const port = buildGraphOverlayAdapter(overlaySurface, store, {
			terminalOutput: { platform: "linux", isTTY: false, write: () => undefined },
		});

		// --- A two-gate run, paced by externally released tool phases. ---
		const phase1 = phaseGate();
		const phase2 = phaseGate();
		const phase3 = phaseGate();
		const definition = workflow({
			name: "demo-approvals",
			description: "two-gate live-defect shape",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("phase-1-prepare", {}, async () => {
					await phase1.promise;
					return { ok: true };
				});
				const approved = await ctx.ui.confirm("Approve phase 2 (build)?");
				await ctx.tool("phase-2-build", { approved }, async () => {
					await phase2.promise;
					return { ok: true };
				});
				const target = await ctx.ui.select("Choose deploy target", ["staging", "production", "abort"]);
				await ctx.tool("phase-3-deploy", { target }, async () => {
					await phase3.promise;
					return { ok: true };
				});
				return {};
			},
		});
		const runPromise = run(definition, {}, { store, usePromptNodesForUi: true });
		await waitForPaneState("working");

		// Opening the overlay is a real user wait: the pane reports the dialog.
		port.open(store.runs()[0]?.id ?? null, overlaySurface);
		await waitForPaneState("blocked", "Custom dialog");

		// Hiding it (Ctrl+X back to chat) keeps the overlay mounted and the
		// custom() promise pending — but nobody is waiting on a dialog now, so
		// the block must release and the pane must say working again. This is
		// the step that wedged the live pane before the fix.
		port.toggle(store.runs()[0]?.id ?? null, overlaySurface);
		assert.equal(overlayHidden, true, "the adapter hid the overlay through its handle");
		await waitForPaneState("working");

		// Gate 1: the pane blocks on the workflow prompt, and the answer alone
		// must return it to working.
		phase1.release();
		const confirmPrompt = await waitForStagePrompt(store, "confirm");
		await waitForPaneState("blocked", "demo-approvals: confirm");
		assert.equal(
			store.resolveStagePendingPrompt(
				confirmPrompt.runId,
				confirmPrompt.stage.id,
				confirmPrompt.stage.pendingPrompt?.id ?? "",
				true,
				{ answerSource: "workflow_tool" },
			),
			true,
		);
		await waitForPaneState("working");

		// Gate 2, same contract.
		phase2.release();
		const selectPrompt = await waitForStagePrompt(store, "select");
		await waitForPaneState("blocked", "demo-approvals: select");
		assert.equal(
			store.resolveStagePendingPrompt(
				selectPrompt.runId,
				selectPrompt.stage.id,
				selectPrompt.stage.pendingPrompt?.id ?? "",
				"staging",
				{ answerSource: "workflow_tool" },
			),
			true,
		);
		await waitForPaneState("working");

		// Completion drops the contribution entirely.
		phase3.release();
		const result = await runPromise;
		assert.equal(result.status, "completed");
		await waitForPaneState("idle");

		// The mounted-but-hidden overlay must not have left a block behind.
		assert.deepEqual(getOpenUserBlocks(), [], "no user block may outlive the hidden overlay");

		// Re-showing the overlay is a real wait again: a fresh block is minted.
		port.toggle(store.runs()[0]?.id ?? null, overlaySurface);
		await waitForPaneState("blocked", "Custom dialog");
		port.toggle(store.runs()[0]?.id ?? null, overlaySurface);
		await waitForPaneState("idle");
		assert.deepEqual(getOpenUserBlocks(), []);

		uninstall();
		port.close();
		// close() hides through the handle, so the permanent-dismiss path cannot
		// strand a block either.
		assert.deepEqual(getOpenUserBlocks(), []);
	});
});
