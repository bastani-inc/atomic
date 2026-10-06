import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { runGoalWorkflow } from "../../packages/workflows/builtin/goal-runner.js";
import type { GoalLedger } from "../../packages/workflows/builtin/goal-types.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner-context.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";
import type { StageSessionCreateOptions } from "./stage-runner-helpers.js";
import { makeMockSession, makeOpts, skippedStructuredOutputTurn } from "./stage-runner-helpers.js";
import { executeWorkflowDecision } from "./structured-output-workflow-fixture.js";

for (const failure of [
	"missing tool",
	"invalid arguments",
	"invalid decision schema",
	"provider failure",
	"provider then missing tool",
] as const) {
	test(`Goal handles schema exhaustion from ${failure} without confusing infrastructure and review outcomes (#3466)`, async () => {
		const root = await mkdtemp(join(tmpdir(), "goal-schema-exhaustion-"));
		let attempts = 0;
		try {
			const ctx = makeMockCtx(
				{ objective: "finish", max_turns: 5, create_pr: false, base_branch: "origin/main", git_worktree_dir: "" },
				{
					tool: (name) => (name === "artifact-root" ? root : undefined),
					task: () => "receipt",
					parallel: async (steps) => {
						const step = steps[0]!;
						let createOptions: StageSessionCreateOptions | undefined;
						const mock = makeMockSession({
							async prompt() {
								attempts += 1;
								skippedStructuredOutputTurn(mock.session.messages);
								if (failure === "missing tool" || (failure === "provider then missing tool" && attempts > 1))
									return;
								if (failure === "invalid decision schema") {
									const tool = createOptions?.customTools?.find(
										(candidate) => candidate.name === "structured_output",
									);
									assert.ok(tool);
									try {
										await executeWorkflowDecision(tool, `invalid-${attempts}`, { wrong: true });
										assert.fail("healthy inference with wrong schema must fail validation");
									} catch (error) {
										assert.ok(error instanceof Error);
										assert.match(
											error.message,
											/Invalid structured output: response does not match the decision schema/,
										);
										mock.emit({
											type: "tool_execution_end",
											toolName: "structured_output",
											isError: true,
											result: { content: [{ type: "text", text: error.message }] },
										});
									}
									return;
								}
								mock.emit({
									type: "tool_execution_end",
									toolName: "structured_output",
									isError: true,
									result: {
										content: [
											{
												type: "text",
												text:
													failure === "invalid arguments"
														? 'Validation failed for tool "structured_output": instructions: Expected string'
														: "Structured output provider request failed. Check provider configuration and connectivity.",
											},
										],
									},
								});
							},
						});
						const stage = createStageContext(
							makeOpts({
								stageName: step.name,
								stageOptions: { schema: step.schema },
								adapters: {
									agentSession: {
										create: async (options) => {
											createOptions = options;
											return mock.session;
										},
									},
								},
							}),
						);
						try {
							await stage.prompt(typeof step.task === "string" ? step.task : "review");
							assert.fail("malformed schema stage must exhaust its correction budget");
						} finally {
							await stage.__dispose();
						}
					},
				},
			);
			const invoke = () => runGoalWorkflow(ctx, { createPr: false, workflowStartCwd: process.cwd() });
			if (failure.startsWith("provider")) await assert.rejects(invoke, /provider request failed/);
			else assert.equal((await invoke()).status, "needs_human");
			assert.equal(attempts, 4);
			const ledger = JSON.parse(await readFile(join(root, "goal-ledger-state.json"), "utf8")) as GoalLedger;
			assert.equal(ledger.status, failure.startsWith("provider") ? "active" : "needs_human");
			assert.equal(ledger.receipts.length, 1);
			assert.equal(ledger.decisions.length, failure.startsWith("provider") ? 0 : 1);
			assert.equal(ledger.turns, 1, "malformed schema output must not bypass the turn budget");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("Goal recognizes malformed reviewer exhaustion from a separately loaded module (#3466)", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-reloaded-schema-exhaustion-"));
	try {
		vi.resetModules();
		const { WorkflowStructuredOutputContractError } = await import(
			"../../packages/workflows/src/runs/foreground/stage-runner-structured-output.js"
		);
		const ctx = makeMockCtx(
			{ objective: "finish", max_turns: 5, create_pr: false, base_branch: "origin/main", git_worktree_dir: "" },
			{
				tool: (name) => (name === "artifact-root" ? root : undefined),
				task: () => "receipt",
				parallel: async () => {
					throw new WorkflowStructuredOutputContractError(
						"atomic-workflows: stage configured with schema must finish by calling structured_output.",
					);
				},
			},
		);
		const result = await runGoalWorkflow(ctx, { createPr: false, workflowStartCwd: process.cwd() });
		assert.equal(result.status, "needs_human");
		const ledger = JSON.parse(await readFile(join(root, "goal-ledger-state.json"), "utf8")) as GoalLedger;
		assert.equal(ledger.status, "needs_human");
		assert.equal(ledger.decisions.length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
