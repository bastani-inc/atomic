// @ts-nocheck
import { describe, test } from "vitest";
import { testRunId } from "../helpers/run-id.js";
// InMemoryDurableBackend is already bound at line 46. Bun tolerated the repeated
// binding; every standards-conforming parser rejects it, and vitest's did.
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import type {
	PiCommandContext,
	PiCustomOverlayFactoryTui,
	PiCustomOverlayFunction,
	PiCustomOverlayOptions,
	PiOverlayHandle,
} from "./slash-dispatch-utils.js";
import {
	addFactoryStubs,
	assert,
	buildMockPi,
	createLegacyWorkflowControlHarness,
	installSlashDispatchTestHooks,
	makeInflightRun,
	registerTestStageHandle,
	store,
	WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("/workflow resume <runId> — active run is refused", () => {
	test.sequential("resuming an already-running run refuses and points at /workflows (#5224)", async () => {
		const runId = testRunId(`resume-slash-overlay-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));

		const openCalls: Array<{ overlay: boolean }> = [];
		const { pi } = buildMockPi();
		addFactoryStubs(pi);
		let refreshCalls = 0;
		pi.refreshWorkflowResources = async () => {
			refreshCalls += 1;
			return [];
		};
		const customFn: PiCustomOverlayFunction = (_factoryArg, options: PiCustomOverlayOptions) => {
			openCalls.push({ overlay: options.overlay });
			return undefined;
		};
		pi.ui = {
			setWidget: () => {},
			custom: customFn,
		};

		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);

		const workflowCmd = createLegacyWorkflowControlHarness(pi);
		const msgs: string[] = [];
		const ctx: PiCommandContext = {
			ui: {
				notify: (m: string) => {
					msgs.push(m);
				},
			},
		};

		await workflowCmd.options.handler(`resume ${runId}`, ctx);

		// Active workflows must not be re-resumed: no overlay opens and the
		// user is steered toward `/workflows`.
		assert.equal(openCalls.length, 0);
		const joined = msgs.join("\n");
		assert.match(joined, /already running/);
		assert.match(joined, /\/workflows /);
		assert.equal(refreshCalls, 0, "exact active runs must bypass durable preparation and discovery");
	});

	test.sequential("active run resume output does NOT include 'still active — no resume needed'", async () => {
		const runId = testRunId(`resume-nomsg-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));

		const { pi } = buildMockPi();
		addFactoryStubs(pi);
		const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
			const handle: PiOverlayHandle = {
				hide: () => undefined,
				setHidden: () => undefined,
				isHidden: () => false,
				focus: () => undefined,
				unfocus: () => undefined,
				isFocused: () => true,
			};
			options.onHandle?.(handle);
			const tui: PiCustomOverlayFactoryTui = {
				requestRender: () => undefined,
			};
			factoryArg(tui, {}, {}, () => undefined);
			return undefined;
		};
		pi.ui = {
			setWidget: () => {},
			custom: customFn,
		};

		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);

		const workflowCmd = createLegacyWorkflowControlHarness(pi);
		const msgs: string[] = [];
		const ctx: PiCommandContext = {
			ui: {
				notify: (m: string) => {
					msgs.push(m);
				},
			},
		};

		await workflowCmd.options.handler(`resume ${runId}`, ctx);

		assert.equal(
			msgs.every((m) => !m.includes("still active")),
			true,
		);
		assert.equal(
			msgs.every((m) => !m.includes("no resume needed")),
			true,
		);
	});
});

describe("/workflow resume <runId> — exact live fast path", () => {
	test.sequential("exact paused live target bypasses completed durable catalog in headless mode", async () => {
		async function createCatalogTrapBackend() {
			const backend = Object.assign(await createMemoryTestBackend(), { completedCatalogCalls: 0 });
			return Object.assign(backend, {
				listCompletedWorkflows() {
					backend.completedCatalogCalls += 1;
					throw new Error("completed durable catalog must not be enumerated");
				},
			});
		}

		const backend = await createCatalogTrapBackend();
		setDurableBackend(backend);
		const { pi, sent } = buildMockPi();
		addFactoryStubs(pi);
		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);
		const handler = createLegacyWorkflowControlHarness(pi).options.handler;
		const runId = testRunId(`headless-fast-resume-${Date.now()}`);
		const stageId = "stage-fast-resume";
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "durable-duplicate",
			inputs: {},
			createdAt: 1,
			// Keep the duplicate nonterminal: terminal durable generations are
			// authoritative and must not be revived by a local live snapshot.
			status: "paused",
			completedCheckpoints: 1,
		});
		store.recordRunStart({
			...makeInflightRun(runId),
			stages: [
				{
					id: stageId,
					name: "worker",
					status: "paused",
					parentIds: [],
					startedAt: Date.now(),
					toolEvents: [],
				},
			],
		});
		registerTestStageHandle(runId, stageId, "paused");

		const startedAt = performance.now();
		await handler(`resume ${runId}`, { hasUI: false, ui: { notify: () => undefined } });
		const elapsedMs = performance.now() - startedAt;

		assert.equal(backend.completedCatalogCalls, 0);
		assert.ok(elapsedMs < 1_000, `exact live resume took ${elapsedMs.toFixed(1)}ms`);
		const content = sent
			.filter((message) => message.customType === WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE)
			.map((message) => message.content ?? "")
			.join("\n");
		assert.match(content, /Resumed 1 stage\(s\)/);
	});
	test.sequential("exact paused nested child names its root instead of reporting a missing run (#5569)", async () => {
		async function createCatalogCountingBackend() {
			const backend = Object.assign(await createMemoryTestBackend(), { completedCatalogCalls: 0 });
			const baselistCompletedWorkflows = backend.listCompletedWorkflows.bind(backend);
			return Object.assign(backend, {
				listCompletedWorkflows() {
					backend.completedCatalogCalls += 1;
					return baselistCompletedWorkflows();
				},
			});
		}

		const backend = await createCatalogCountingBackend();
		setDurableBackend(backend);
		const { pi } = buildMockPi();
		addFactoryStubs(pi);
		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);
		const handler = createLegacyWorkflowControlHarness(pi).options.handler;
		const runId = testRunId(`nested-paused-resume-${Date.now()}`);
		const stageId = "stage-nested-paused";
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "nested-worker",
			inputs: {},
			status: "paused",
			createdAt: 1,
			rootWorkflowId: "parent-run",
		});
		store.recordRunStart({
			...makeInflightRun(runId),
			parentRunId: "parent-run",
			rootRunId: "parent-run",
			stages: [
				{
					id: stageId,
					name: "nested-worker",
					status: "paused",
					parentIds: [],
					startedAt: Date.now(),
					toolEvents: [],
				},
			],
		});
		registerTestStageHandle(runId, stageId, "paused");

		await assert.rejects(
			handler(`resume ${runId}`, { hasUI: false, ui: { notify: () => undefined } }),
			new RegExp(`Workflow ${runId} is nested; resume its root parent-run`),
		);

		assert.ok(backend.completedCatalogCalls > 0, "nested child must continue through the top-level resolver");
		assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.status, "paused");
	});
});

// ---------------------------------------------------------------------------
// resume regression: tool action "resume" against active run returns status:"ok"
// ---------------------------------------------------------------------------
