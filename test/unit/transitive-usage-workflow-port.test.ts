import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { makeUsageRollupPort } from "../../packages/workflows/src/extension/workflow-ports.ts";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.ts";
import { bindUsageRollupRoot, runtimeDispatchOptions } from "../../packages/workflows/src/extension/runtime-usage.ts";
import { registerWorkflowSlashCommand } from "../../packages/workflows/src/extension/workflow-command-registration.ts";

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

describe("workflow usage rollup port", () => {
	test("uses root accessor, stage session id key, and propagated settled flag", () => {
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const port = makeUsageRollupPort({
			getSessionId: () => "root-session",
			events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
		} as never);
		port?.emitStageRollup("stage-id", usage(7, 0.7), { sessionId: "stage-session", sessionFile: "/tmp/stage.jsonl", settled: false });
		assert.equal(emitted[0]?.event, "usage:descendant-rollup");
		assert.equal(emitted[0]?.payload["rootSessionId"], "root-session");
		assert.equal(emitted[0]?.payload["childRunId"], "stage-session");
		assert.equal(emitted[0]?.payload["settled"], false);
	});

	test("prefers the root session captured when the workflow launched", () => {
		const emitted: Array<Record<string, unknown>> = [];
		const port = makeUsageRollupPort({
			getSessionId: () => "later-session",
			events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) },
		} as never);
		port?.emitStageRollup("stage-id", usage(7, 0.7), {
			rootSessionId: "launch-session",
			sessionId: "stage-session",
		});
		assert.equal(emitted[0]?.["rootSessionId"], "launch-session");
	});

	test("does not emit live workflow rollups without a stage session id", () => {
		const emitted: unknown[] = [];
		const port = makeUsageRollupPort({ getSessionId: () => "root", events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) } } as never);
		port?.emitStageRollup("stage-id", usage(7, 0.7), { sessionId: "" });
		assert.equal(emitted.length, 0);
	});

	test("binds stage emissions to the workflow launch root", () => {
		let emittedRoot: string | undefined;
		const bound = bindUsageRollupRoot({
			emitStageRollup(_stageId, _usage, meta) {
				emittedRoot = meta.rootSessionId;
			},
		}, "launch-session");
		bound?.emitStageRollup("stage-id", usage(1, 0.1), { sessionId: "stage-session" });
		assert.equal(emittedRoot, "launch-session");
	});

	test("captures slash-command workflow launch ownership before dispatch", async () => {
		let capturedRoot: string | undefined;
		const runtime = {
			registry: { all: () => [], names: () => [] },
			dispatch: async (_args: never, options?: { rootSessionId?: string }) => {
				capturedRoot = options?.rootSessionId;
				return { action: "run", runId: "run-1", status: "completed", stages: [] };
			},
		};
		const commands = new Map<string, (args: string, ctx: never) => Promise<void>>();
		registerWorkflowSlashCommand({} as never, commands as never, {
			runtimeProxy: runtime as never,
			runtimeForContext: () => runtime as never,
			overlay: { open: () => undefined, close: () => undefined, toggle: () => undefined },
			reloadWorkflowResources: () => undefined,
			ensureWorkflowResourcesLoaded: () => undefined,
			runWithLifecycleSuppressedForPolicy: async (_policy, fn) => await fn(),
			runControl: {} as never,
		});
		await commands.get("workflow")?.("example", {
			hasUI: true,
			ui: { notify: () => undefined },
			sessionManager: { getSessionId: () => "slash-launch-session" },
		} as never);
		assert.equal(capturedRoot, "slash-launch-session");
	});

	test("builds launch-root options consistently for command and tool contexts", () => {
		const options = runtimeDispatchOptions({ mode: "interactive" } as never, {
			sessionId: "explicit-session",
			sessionManager: { getSessionId: () => "manager-session" },
		});
		assert.equal(options.rootSessionId, "explicit-session");
	});

	test.serial("captures the launch root from the execute context session manager", async () => {
		const previousGuard = process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
		delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
		try {
			let capturedRoot: string | undefined;
			const handler = makeExecuteWorkflowTool({
				dispatch: async (_args: never, options?: { rootSessionId?: string }) => {
					capturedRoot = options?.rootSessionId;
					return { action: "list", items: [] };
				},
			} as never, () => undefined, () => undefined);
			await handler({ action: "list" }, {
				sessionManager: { getSessionId: () => "launch-session" },
			} as never);
			assert.equal(capturedRoot, "launch-session");
		} finally {
			if (previousGuard === undefined) delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
			else process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousGuard;
		}
	});
});
