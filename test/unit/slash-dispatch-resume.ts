// @ts-nocheck
import { describe, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
// InMemoryDurableBackend is already bound at line 46. Bun tolerated the repeated
// binding; every standards-conforming parser rejects it, and vitest's did.
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { testRunId } from "../helpers/run-id.js";
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
	installSlashDispatchTestHooks,
	makeInflightRun,
	registerTestStageHandle,
	stageControlRegistry,
	store,
	WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("/workflow resume <runId> — active run is refused", () => {
	test.sequential("resuming an already-running run refuses and points at /workflow connect", async () => {
		const runId = testRunId(`resume-slash-overlay-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));

		const openCalls: Array<{ overlay: boolean }> = [];
		const { pi, commands } = buildMockPi();
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

		const workflowCmd = commands.find((c) => c.name === "workflow")!;
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
		// user is steered toward `/workflow connect`.
		assert.equal(openCalls.length, 0);
		const joined = msgs.join("\n");
		assert.match(joined, /already running/);
		assert.match(joined, /\/workflow connect/);
		assert.equal(refreshCalls, 0, "exact active runs must bypass durable preparation and discovery");
	});

	test.sequential("active run resume output does NOT include 'still active — no resume needed'", async () => {
		const runId = testRunId(`resume-nomsg-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));

		const { pi, commands } = buildMockPi();
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

		const workflowCmd = commands.find((c) => c.name === "workflow")!;
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
		class CatalogTrapBackend extends InMemoryDurableBackend {
			completedCatalogCalls = 0;

			override listCompletedWorkflows() {
				this.completedCatalogCalls += 1;
				throw new Error("completed durable catalog must not be enumerated");
			}
		}

		const backend = new CatalogTrapBackend();
		setDurableBackend(backend);
		const { pi, commands, sent } = buildMockPi();
		addFactoryStubs(pi);
		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);
		const handler = commands.find((command) => command.name === "workflow")!.options.handler;
		const runId = testRunId(`headless-fast-resume-${Date.now()}`);
		const stageId = "stage-fast-resume";
		backend.registerWorkflow({
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
	test.sequential("exact paused nested child remains excluded from top-level resume targets", async () => {
		class CatalogCountingBackend extends InMemoryDurableBackend {
			completedCatalogCalls = 0;

			override listCompletedWorkflows() {
				this.completedCatalogCalls += 1;
				return super.listCompletedWorkflows();
			}
		}

		const backend = new CatalogCountingBackend();
		setDurableBackend(backend);
		const { pi, commands } = buildMockPi();
		addFactoryStubs(pi);
		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);
		const handler = commands.find((command) => command.name === "workflow")!.options.handler;
		const runId = testRunId(`nested-paused-resume-${Date.now()}`);
		const stageId = "stage-nested-paused";
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
			/No resumable workflow found for id:/,
		);

		assert.ok(backend.completedCatalogCalls > 0, "nested child must continue through the top-level resolver");
		assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.status, "paused");
	});
});

describe("/workflow attach <rootRunId> <nestedStageId>", () => {
	test.sequential("routes an explicit nested stage through the root graph overlay", async () => {
		let overlayOpens = 0;
		let attachedOwner: string | undefined;
		const notifications: string[] = [];
		const { pi, commands } = buildMockPi();
		addFactoryStubs(pi);
		pi.ui = {
			notify: (message: string) => {
				notifications.push(message);
			},
			setWidget: () => {},
			custom: (factory) => {
				overlayOpens += 1;
				const component = factory(
					{ requestRender: () => {}, terminal: { rows: 32, columns: 96 } },
					{},
					{},
					() => {},
				);
				attachedOwner = store
					.runs()
					.find((run) => run.stages.some((stage) => stage.id === "review" && stage.attached === true))?.id;
				component.dispose?.();
				return undefined;
			},
		};
		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);
		const handler = commands.find((command) => command.name === "workflow")!.options.handler;

		const rootRunId = testRunId(`attach-root-${Date.now()}`);
		const childOneRunId = testRunId(`attach-child-one-${Date.now()}`);
		const childTwoRunId = testRunId(`attach-child-two-${Date.now()}`);
		const nestedStageId = "review";
		const boundary = (id: string, childRunId: string) => ({
			id,
			name: id,
			status: "completed" as const,
			parentIds: [],
			startedAt: Date.now(),
			endedAt: Date.now(),
			toolEvents: [],
			workflowChild: {
				alias: id,
				workflow: "child-workflow",
				runId: childRunId,
				status: "completed" as const,
				outputs: {},
			},
		});
		store.recordRunStart({
			...makeInflightRun(rootRunId),
			stages: [boundary("child-one", childOneRunId), boundary("child-two", childTwoRunId)],
		});
		for (const [childRunId, parentStageId] of [
			[childOneRunId, "child-one"],
			[childTwoRunId, "child-two"],
		] as const) {
			store.recordRunStart({
				...makeInflightRun(childRunId),
				parentRunId: rootRunId,
				parentStageId,
				rootRunId,
				stages: [
					{
						id: nestedStageId,
						name: "review",
						status: "completed",
						parentIds: [],
						startedAt: Date.now(),
						endedAt: Date.now(),
						toolEvents: [],
						sessionFile: `/tmp/${childRunId}.jsonl`,
					},
				],
			});
		}

		await handler(`attach ${rootRunId} ${childTwoRunId}:${nestedStageId}`, { hasUI: true, ui: pi.ui });

		assert.equal(overlayOpens, 1);
		assert.equal(attachedOwner, childTwoRunId);
		const content = notifications.join("\n");
		assert.match(content, /Attached to .* stage review/);
		assert.doesNotMatch(content, /Stage not found/);
	});

	test.sequential("routes /workflow attach through an actually hydrated durable child owner", async () => {
		const rootRunId = testRunId(`attach-hydrated-root-${Date.now()}`);
		const childRunId = testRunId(`attach-hydrated-child-${Date.now()}`);
		const boundaryId = "hydrated-boundary";
		const stageId = "hydrated-review";
		const replayKey = "workflow:hydrated-child:1";
		const backend = new InMemoryDurableBackend();
		const child = {
			runId: childRunId,
			runName: "hydrated-child",
			parentRunId: rootRunId,
			parentStageId: boundaryId,
			rootRunId: rootRunId,
		};
		const identity = {
			version: 1 as const,
			replayScope: replayKey,
			alias: "hydrated-child",
			workflow: "hydrated-child",
			invocationFingerprint: "hydrated-fixture-fingerprint",
			child,
		};
		backend.registerWorkflow({
			workflowId: rootRunId,
			name: "hydrated-root",
			inputs: {},
			createdAt: 1,
			updatedAt: 5,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: rootRunId,
			checkpointId: "hydrated-start",
			name: "workflow:hydrated-child",
			replayKey,
			completedAt: 1,
			topology: {
				version: 1,
				stageId: boundaryId,
				parentIds: [],
				sourceOrder: 0,
				status: "running",
				run: { runId: rootRunId, runName: "hydrated-root" },
				boundary: { ...identity, event: "start", status: "running" },
			},
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: rootRunId,
			checkpointId: `${replayKey}:review`,
			name: "hydrated-review",
			replayKey: `${replayKey}:stage:review:1`,
			output: "reviewed",
			completedAt: 3,
			endedAt: 3,
			topology: {
				version: 1,
				stageId,
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: child,
			},
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: rootRunId,
			checkpointId: "hydrated-terminal",
			name: "workflow:hydrated-child",
			replayKey,
			completedAt: 4,
			endedAt: 4,
			output: {
				workflow: "hydrated-child",
				runId: childRunId,
				status: "completed",
				exited: false,
				outputs: {},
			},
			topology: {
				version: 1,
				stageId: boundaryId,
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: { runId: rootRunId, runName: "hydrated-root" },
				boundary: { ...identity, event: "terminal", status: "completed" },
			},
		});
		assert.equal(
			openCompletedDurableWorkflow(rootRunId, {
				durableBackend: backend,
				store,
				stageControlRegistry,
			}).ok,
			true,
		);

		let overlayOpens = 0;
		let attachedOwner: string | undefined;
		const notifications: string[] = [];
		const { pi, commands } = buildMockPi();
		addFactoryStubs(pi);
		pi.ui = {
			notify: (message: string) => {
				notifications.push(message);
			},
			setWidget: () => {},
			custom: (factory) => {
				overlayOpens += 1;
				const component = factory(
					{ requestRender: () => {}, terminal: { rows: 32, columns: 96 } },
					{},
					{},
					() => {},
				);
				attachedOwner = store
					.runs()
					.find((run) => run.stages.some((stage) => stage.id === stageId && stage.attached === true))?.id;
				component.dispose?.();
				return undefined;
			},
		};
		const factoryModule = await import("../../packages/workflows/src/extension/index.js");
		factoryModule.default(pi);
		const handler = commands.find((command) => command.name === "workflow")!.options.handler;
		await handler(`attach ${rootRunId} ${childRunId}:${stageId}`, { hasUI: true, ui: pi.ui });

		assert.equal(overlayOpens, 1);
		assert.equal(attachedOwner, childRunId);
		assert.match(notifications.join("\n"), /Attached to .* stage hydrated-review\./);
	});
});

// ---------------------------------------------------------------------------
// resume regression: tool action "resume" against active run returns status:"ok"
// ---------------------------------------------------------------------------
