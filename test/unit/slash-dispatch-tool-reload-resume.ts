// @ts-nocheck
import { describe, test } from "vitest";
import { testRunId } from "../helpers/run-id.js";
import type { ExtensionRuntime, PiToolOpts, WorkflowToolArgs } from "./slash-dispatch-utils.js";
import {
	addFactoryStubs,
	assert,
	buildMockPi,
	createExtensionRuntime,
	createRegistry,
	installSlashDispatchTestHooks,
	join,
	makeExecuteWorkflowTool,
	makeInflightRun,
	mkdtemp,
	rm,
	store,
	tmpdir,
	WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
	writeWorkflowFixture,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("tool run-control actions", () => {
	function makeToolHandler() {
		const registry = createRegistry([]);
		const runtime = createExtensionRuntime({ registry });
		return makeExecuteWorkflowTool(runtime, () => undefined);
	}

	function _makeDispatchTrackingWorkflowHandler(): {
		handler: ReturnType<typeof makeExecuteWorkflowTool>;
		wasDispatched: () => boolean;
	} {
		let dispatched = false;
		const runtime = {
			dispatch: async () => {
				dispatched = true;
				return {
					action: "run",
					runId: "unexpected",
					status: "running",
					stages: [],
				};
			},
		} as unknown as ExtensionRuntime;

		return {
			handler: makeExecuteWorkflowTool(runtime, () => undefined),
			wasDispatched: () => dispatched,
		};
	}

	function _restoreWorkflowStageGuard(previousGuard: string | undefined): void {
		if (previousGuard === undefined) {
			delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
			return;
		}
		process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousGuard;
	}

	function _assertWorkflowToolBlocked(result: WorkflowToolResult, wasDispatched: () => boolean): void {
		assert.equal(wasDispatched(), false);
		assert.match((result as { error?: string }).error ?? "", /workflows cannot invoke workflows/);
	}
	test.sequential("makeExecuteWorkflowTool reloads directly without sending a literal slash command", async () => {
		const registry = createRegistry([]);
		const runtime = createExtensionRuntime({ registry });
		let reloads = 0;
		const handler = makeExecuteWorkflowTool(runtime, async () => {
			reloads += 1;
		});
		const sent: string[] = [];

		const result = await handler({ action: "reload", reason: "test" }, {
			// Sentinel-only property: production ExtensionAPI does not expose this.
			sendUserMessage: (content: string) => {
				sent.push(content);
			},
		} as never);

		assert.equal(result.action, "reload");
		const reload = result as {
			action: string;
			status: string;
			message: string;
		};
		assert.equal(reload.status, "ok");
		assert.match(reload.message, /Reloaded workflow resources/);
		assert.equal(reloads, 1);
		assert.deepEqual(sent, []);
	});

	test.sequential("registered workflow tool reload refreshes package workflow resources before discovery", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-tool-refresh-"));
		try {
			const addedWorkflow = join(dir, "tool-refresh-added.ts");
			await writeWorkflowFixture(addedWorkflow, "tool-refresh-added");

			const { pi, commands } = buildMockPi();
			addFactoryStubs(pi);
			let refreshCalls = 0;
			pi.getWorkflowResources = () => [];
			pi.refreshWorkflowResources = async () => {
				refreshCalls += 1;
				return [{ path: addedWorkflow, enabled: true }];
			};
			let registered: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> | undefined;
			pi.registerTool = (opts) => {
				registered = opts as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
			};

			const factoryModule = await import("../../packages/workflows/src/extension/index.js");
			factoryModule.default(pi);
			assert.ok(registered, "expected workflow tool registration");

			const result = await registered.execute(
				"tool-reload-refresh-call",
				{ action: "reload", reason: "manifest changed" },
				undefined,
				undefined,
				{} as never,
			);

			assert.equal(refreshCalls, 1);
			assert.equal(result.details.action, "reload");
			const reload = result.details as Extract<WorkflowToolResult, { action: "reload" }>;
			assert.equal(reload.status, "ok");
			assert.match(reload.message, /Reloaded workflow resources/);
			const workflowCmd = commands.find((command) => command.name === "workflow");
			assert.ok(workflowCmd, "expected workflow command registration");
			const completions = (await workflowCmd.options.getArgumentCompletions?.("tool-refresh-add")) ?? [];
			assert.equal(
				completions.some((completion) => completion.label === "tool-refresh-added"),
				true,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test.sequential("makeExecuteWorkflowTool treats explicit empty reload reason as omitted", async () => {
		const registry = createRegistry([]);
		const runtime = createExtensionRuntime({ registry });
		const handler = makeExecuteWorkflowTool(runtime, () => undefined);

		const result = await handler({ action: "reload", reason: "" }, {} as never);

		assert.equal(result.action, "reload");
		const reload = result as {
			action: string;
			status: string;
			message: string;
		};
		assert.equal(reload.status, "ok");
		assert.equal(reload.message, "Reloaded workflow resources.");
	});

	test.sequential("makeExecuteWorkflowTool reload stays available while workflows are in flight", async () => {
		const registry = createRegistry([]);
		const runtime = createExtensionRuntime({ registry });
		let reloads = 0;
		const handler = makeExecuteWorkflowTool(runtime, () => {
			reloads += 1;
		});
		const runId = testRunId(`reload-inflight-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));

		const result = await handler({ action: "reload", reason: "test" }, {} as never);

		assert.equal(result.action, "reload");
		const reload = result as {
			action: string;
			status: string;
			message: string;
		};
		assert.equal(reload.status, "ok");
		assert.match(reload.message, /Reloaded workflow resources/);
		assert.equal(reloads, 1);
		assert.equal(store.runs().find((run) => run.id === runId)?.endedAt, undefined);
	});

	test.sequential("makeExecuteWorkflowTool reload surfaces callback failures as noop", async () => {
		const registry = createRegistry([]);
		const runtime = createExtensionRuntime({ registry });
		const handler = makeExecuteWorkflowTool(runtime, async () => {
			throw new Error("bad workflow config");
		});

		const result = await handler({ action: "reload", reason: "test" }, {} as never);

		assert.equal(result.action, "reload");
		const reload = result as {
			action: string;
			status: string;
			message: string;
		};
		assert.equal(reload.status, "noop");
		assert.match(reload.message, /Reload failed: bad workflow config/);
	});

	test.sequential("makeExecuteWorkflowTool rejects run prefixes while full ids remain independently addressable", async () => {
		const anchor = testRunId("ambiguous-run");
		const firstId = `${anchor.slice(0, 24)}111111111111`;
		const secondId = `${anchor.slice(0, 24)}222222222222`;
		store.recordRunStart(makeInflightRun(firstId));
		store.recordRunStart(makeInflightRun(secondId));
		const handler = makeToolHandler();

		const malformed = await handler({ action: "quit", runId: anchor.slice(0, 12) }, {} as never);
		assert.equal(malformed.action, "quit");
		const malformedResult = malformed as { action: string; status: string; message: string };
		assert.equal(malformedResult.status, "noop");
		assert.match(malformedResult.message, /Run id must be a full 36-character UUID/);

		for (const fullId of [firstId, secondId]) {
			const result = await handler({ action: "quit", runId: fullId }, {} as never);
			assert.equal(result.action, "quit");
			const r = result as { action: string; status: string; runId: string; message: string };
			assert.equal(r.status, "noop");
			assert.equal(r.runId, fullId);
			assert.match(r.message, /no controllable stages.*remains active/i);
			assert.equal(
				store.runs().some((run) => run.id === fullId),
				true,
			);
		}
	});

	test.sequential("makeExecuteWorkflowTool resume accepts full run ids, exact stage names, and messages", async () => {
		const runId = testRunId(`resume-tool-stage-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-abc123",
			name: "review-stage",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		const handler = makeToolHandler();

		const result = await handler(
			{
				action: "resume",
				runId,
				stageId: "review-stage",
				message: "continue please",
			},
			{} as never,
		);

		assert.equal(result.action, "resume");
		const r = result as {
			action: string;
			status: string;
			runId: string;
			message: string;
		};
		assert.equal(r.status, "ok");
		assert.equal(r.runId, runId);
		assert.match(r.message, /Snapshot available/);
	});

	test.sequential("makeExecuteWorkflowTool resume against in-flight run returns status:'ok'", async () => {
		const runId = testRunId(`resume-tool-ok-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));

		const handler = makeToolHandler();

		const result = await handler({ action: "resume", runId }, {} as never);

		assert.equal(result.action, "resume");
		const r = result as { action: string; status: string; runId: string };
		assert.equal(r.status, "ok");
		assert.equal(r.runId, runId);
	});

	test.sequential("makeExecuteWorkflowTool rejects partial stage names but preserves exact-name ambiguity", async () => {
		const runId = testRunId(`resume-tool-ambiguous-stage-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		for (const stageId of ["ambiguous-stage-aaa", "ambiguous-stage-bbb"]) {
			store.recordStageStart(runId, {
				id: stageId,
				name: "ambiguous-stage",
				status: "failed",
				parentIds: [],
				toolEvents: [],
			});
			store.recordStageEnd(runId, {
				id: stageId,
				name: "ambiguous-stage",
				status: "failed",
				parentIds: [],
				toolEvents: [],
				error: "boom",
			});
		}
		store.recordRunEnd(runId, "failed", undefined, "boom", {
			resumable: true,
			failedStageId: "ambiguous-stage-aaa",
		});
		const handler = makeToolHandler();

		const partial = await handler({ action: "resume", runId, stageId: "ambiguous-stag" }, {} as never);
		assert.equal(partial.action, "resume");
		const partialResult = partial as { action: string; status: string; runId: string; message: string };
		assert.equal(partialResult.status, "noop");
		assert.equal(partialResult.runId, runId);
		assert.match(partialResult.message, /Stage not found/);

		const exactName = await handler({ action: "resume", runId, stageId: "ambiguous-stage" }, {} as never);
		assert.equal(exactName.action, "resume");
		const r = exactName as { action: string; status: string; runId: string; message: string };
		assert.equal(r.status, "noop");
		assert.equal(r.runId, runId);
		assert.match(r.message, /Ambiguous stage identifier/);
		assert.match(r.message, /ambiguous-stage-aaa/);
		assert.match(r.message, /ambiguous-stage-bbb/);
	});
});
