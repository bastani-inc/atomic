import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import {
	createAgentSession,
	type HostInputOptions,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { workflowPolicyFromContext } from "../../packages/workflows/src/extension/workflow-policy.js";

// #3105: human input is independent of terminal presentation.
test("workflow execution policy admits a callback host without a terminal", () => {
	const host = { hasUI: false, hasHumanInput: true };
	assert.equal(workflowPolicyFromContext(host).mode, "interactive");
	assert.equal(workflowPolicyFromContext({ hasUI: false }).mode, "interactive");
	assert.equal(workflowPolicyFromContext({ hasUI: false }).allowHumanInput, true);
	assert.equal(workflowPolicyFromContext(host).allowInputPicker, false);
	assert.equal(workflowPolicyFromContext({ hasUI: false }).awaitTerminalRun, false);
});

const REAL_UNBOUND_GATE_STARTUP_TIMEOUT_MS = 45_000;

// #3105: initial absence is not an execution-policy restriction.
test(
	"public factory preserves an initially unbound required gate and continues exactly once",
	async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-initially-unbound-"));
		const directory = join(cwd, ".atomic", "workflows");
		mkdirSync(directory, { recursive: true });
		const effect = join(cwd, "effect.jsonl");
		writeFileSync(
			join(directory, "required.ts"),
			`
import { workflow } from "@bastani/atomic/workflows";
import { appendFileSync } from "node:fs";
export default workflow({ name: "required", description: "required approval", inputs: {}, outputs: {},
  run: async ctx => {
    if (await ctx.ui.confirm("required approval"))
      await ctx.tool("effect", {}, async () => { appendFileSync(${JSON.stringify(effect)}, "effect\\n"); return true; });
    return {};
  }
});`,
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		try {
			const tool = session.agent.state.tools.find((entry) => entry.name === "workflow")!;
			await tool.execute("run", { action: "run", workflow: "required", inputs: {} }, new AbortController().signal);
			const status = async () =>
				(await tool.execute("status", { action: "status" }, new AbortController().signal)).details as {
					runs: { runId: string; status: string; awaitingInputCount: number }[];
				};
			await vi.waitFor(async () => assert.equal((await status()).runs[0]?.awaitingInputCount, 1), { timeout: 5000 });
			const pending = await status();
			assert.equal(pending.runs[0]!.status, "running");
			assert.match(JSON.stringify(pending), /"promptKind":"confirm"/);
			assert.equal(existsSync(effect), false);
			const answers = Promise.withResolvers<boolean>();
			const identities: HostInputOptions[] = [];
			await session.bindExtensions({
				humanInput: {
					confirm: async (_title, _message, options) => {
						identities.push(options);
						return answers.promise;
					},
					input: async () => undefined,
					select: async () => undefined,
					editor: async () => undefined,
					questionnaire: async () => ({ answers: [], cancelled: true }),
				},
			});
			await vi.waitFor(() => assert.equal(identities.length, 1));
			assert.equal(identities[0]!.workflowRunId, pending.runs[0]!.runId);
			answers.resolve(true);
			answers.resolve(true);
			await vi.waitFor(async () => assert.equal((await status()).runs[0]?.status, "completed"), { timeout: 5000 });
			await session.bindExtensions({});
			assert.equal(identities.length, 1);
			assert.equal(readFileSync(effect, "utf8"), "effect\n");
		} finally {
			await session.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
	REAL_UNBOUND_GATE_STARTUP_TIMEOUT_MS,
);

// #3105: exercise discovery, the builtin extension and runner-owned HostInput,
// not a manually assembled executor adapter. Prompt-node policy is unchanged.
test.each(["true", "false", "invalid", "withdrawn", "rebound", "duplicate"] as const)(
	"Node workflow prompt nodes route %s through the factory's human host",
	async (reply) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-workflow-host-"));
		const directory = join(cwd, ".atomic", "workflows");
		mkdirSync(directory, { recursive: true });
		const effect = join(cwd, "effect.json");
		writeFileSync(
			join(directory, "host-parity.ts"),
			`
import { workflow } from "@bastani/atomic/workflows";
import { appendFileSync } from "node:fs";
export default workflow({ name: "host-parity", description: "host routing fixture", inputs: {}, outputs: {},
  run: async (ctx) => {
    const text = await ctx.ui.input("  exact input\\n");
    if (await ctx.ui.confirm("  exact approval\\n")) {
      await ctx.tool("counted-effect", {}, async () => {
        appendFileSync(${JSON.stringify(effect)}, JSON.stringify({ text }) + "\\n");
        return true;
      });
    }
    return {};
  }
});
`,
		);
		const requests: string[] = [];
		const identities: HostInputOptions[] = [];
		const late = Promise.withResolvers<boolean>();
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
			extensionBindings: {
				humanInput: {
					input: async (title) => {
						requests.push(title);
						return "  raw text\n ";
					},
					confirm: async (title, message, options) => {
						identities.push(options);
						requests.push(message || title);
						if (reply === "withdrawn" || reply === "rebound" || reply === "duplicate") return late.promise;
						return (reply === "invalid" ? "true" : reply === "true") as boolean;
					},
					select: async () => undefined,
					editor: async () => undefined,
					questionnaire: async () => ({ answers: [], cancelled: true }),
				},
			},
		});
		try {
			const tool = session.agent.state.tools.find((entry) => entry.name === "workflow")!;
			await tool.execute(
				"run",
				{ action: "run", workflow: "host-parity", inputs: {} },
				new AbortController().signal,
			);
			const listed = await tool.execute("list", { action: "list" }, new AbortController().signal);
			assert.match(JSON.stringify(listed.details), /host-parity/);
			await vi.waitFor(() => assert.deepEqual(requests, ["  exact input\n", "  exact approval\n"]), {
				timeout: 5000,
			});
			if (reply === "duplicate") {
				// #3105: a host attempts two answers for the same pending request.
				late.resolve(true);
				late.resolve(true);
			}
			if (reply === "withdrawn" || reply === "rebound") {
				await session.bindExtensions({ humanInput: null });
				late.resolve(true);
			}
			const status = () => tool.execute("status", { action: "status" }, new AbortController().signal);
			if (reply === "rebound") {
				assert.equal(identities[0]!.signal.aborted, true);
				assert.equal(existsSync(effect), false);
				await session.bindExtensions({
					humanInput: {
						input: async () => {
							throw new Error("completed input must not replay");
						},
						confirm: async (_title, _message, options) => {
							identities.push(options);
							return true;
						},
						select: async () => undefined,
						editor: async () => undefined,
						questionnaire: async () => ({ answers: [], cancelled: true }),
					},
				});
				await vi.waitFor(() => assert.equal(identities.length, 2), { timeout: 5000 });
				assert.notEqual(identities[0]!.requestId, identities[1]!.requestId);
				assert.ok(identities[1]!.workflowRunId);
				assert.ok(identities[1]!.workflowStageId);
				assert.equal(identities[0]!.workflowRunId, identities[1]!.workflowRunId);
				assert.equal(identities[0]!.workflowStageId, identities[1]!.workflowStageId);
			}
			if (reply === "true" || reply === "false" || reply === "rebound" || reply === "duplicate") {
				await vi.waitFor(
					async () =>
						assert.equal(
							((await status()).details as { runs: { status: string }[] }).runs[0]?.status,
							"completed",
						),
					{ timeout: 5000 },
				);
				if (reply === "duplicate") {
					await session.bindExtensions({});
					late.resolve(true);
					await new Promise((resolve) => setImmediate(resolve));
					assert.equal(identities.length, 1, "completed approval must not be presented again");
				}
			} else {
				await new Promise((resolve) => setImmediate(resolve));
				assert.match(JSON.stringify((await status()).details), /"promptKind":"confirm"/);
			}
			if (reply === "true" || reply === "rebound" || reply === "duplicate") {
				assert.equal(readFileSync(effect, "utf8"), `${JSON.stringify({ text: "  raw text\n " })}\n`);
			} else {
				assert.equal(existsSync(effect), false, "refusal cannot execute the guarded effect");
			}
		} finally {
			await session.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
