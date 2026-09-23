import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentTools } from "@bastani/pi-ai";
import { test, vi } from "vitest";
import {
	createAgentSession,
	type HostInputOptions,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { workflowPolicyFromContext } from "../../packages/workflows/src/extension/workflow-policy.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
import { spawnSyncCollect } from "../helpers/runtime.js";
import { attachedCliPresentation, forwardCliDialogs } from "./fixtures/sdk-host-cli.js";

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
			await session.prompt("/workflow required --no-picker");
			const tool = session.agent.state.tools.find((entry) => entry.name === "workflow")!;
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
			await session.prompt("/workflow host-parity --no-picker");
			const tool = session.agent.state.tools.find((entry) => entry.name === "workflow")!;
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

// #3105: exact authored questionnaire through actual factory/stage/broker, no renderer.
test.each(["approval", "nested", "cancelled", "invalid", "missing", "stay"] as const)(
	"Node stage questionnaire preserves original params and readiness: %s",
	async (scenario) => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("NODE_TEST_CONTEXT", undefined);
		const cwd = mkdtempSync(join(tmpdir(), "atomic-stage-host-"));
		const directory = join(cwd, ".atomic", "workflows");
		mkdirSync(directory, { recursive: true });
		mkdirSync(join(cwd, ".atomic", "extensions"), { recursive: true });
		writeFileSync(
			join(cwd, ".atomic", "extensions", "provider.ts"),
			readFileSync(new URL("./fixtures/sdk-host-questionnaire-provider.ts", import.meta.url), "utf8"),
		);
		const params = {
			questions: [
				{
					question: "  exact question\n",
					header: " Raw ",
					options: [
						{ label: " Second ", description: " raw description\n", preview: "  preview B\n" },
						{ label: " First ", description: "\nA ", preview: "\npreview A  " },
					],
				},
				{
					question: "  ordered multi\n",
					header: " Multi ",
					multiSelect: true,
					options: [
						{ label: " Z ", description: " last first " },
						{ label: " A ", description: " first last " },
					],
				},
			],
		};
		const effect = join(cwd, "effect.json");
		writeFileSync(
			join(directory, "stage-host.ts"),
			`
import { workflow } from "@bastani/atomic/workflows";
import { appendFileSync } from "node:fs";
const child = workflow({ name: ${JSON.stringify(scenario === "nested" ? "stage-child" : "stage-host")}, description: "stage host fixture", inputs: {}, outputs: {}, run: async (ctx) => {
  await ctx.stage("reviewer", { sessionDir: ${JSON.stringify(join(cwd, "stage-sessions"))}, builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false }, model: "host-questionnaire-fixture/fixture", cwd: ${JSON.stringify(cwd)}, agentDir: ${JSON.stringify(join(cwd, "agent"))}, tools: ["ask_user_question"] }).prompt(${JSON.stringify(`questionnaire ${JSON.stringify(params)}`)});
  await ctx.tool("counted-effect", {}, async () => { appendFileSync(${JSON.stringify(effect)}, "accepted\\n"); return true; });
  return {};
} });
export default ${scenario === "nested" ? 'workflow({ name: "stage-host", description: "nested host fixture", inputs: {}, outputs: {}, run: async (ctx) => { await ctx.workflow(child); return {}; } })' : "child"};`,
		);
		const received: unknown[] = [];
		const identities: HostInputOptions[] = [];
		const lateReadiness =
			Promise.withResolvers<import("../../packages/coding-agent/src/index.js").QuestionnaireResult>();
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
			extensionBindings: {
				humanInput: {
					input: async () => undefined,
					confirm: async () => false,
					select: async () => undefined,
					editor: async () => undefined,
					questionnaire: async (questions, options) => {
						received.push(questions);
						identities.push(options);
						if (received.length === 2) {
							if (scenario === "missing") return lateReadiness.promise;
							if (scenario === "cancelled") return { cancelled: true, answers: [] };
							if (scenario === "invalid")
								return {
									cancelled: false,
									answers: [
										{
											questionIndex: 0,
											question: questions.questions[0]!.question,
											kind: "option",
											answer: "true",
										},
									],
								};
							if (scenario === "stay")
								return {
									cancelled: false,
									answers: [
										{
											questionIndex: 0,
											question: questions.questions[0]!.question,
											kind: "option",
											answer: questions.questions[0]!.options[1]!.label,
										},
									],
								};
						}
						return {
							cancelled: false,
							answers: questions.questions.map((q, questionIndex) =>
								q.multiSelect
									? {
											questionIndex,
											question: q.question,
											kind: "multi" as const,
											answer: null,
											selected: q.options.map((o) => o.label),
											notes: "  raw note\n",
										}
									: {
											questionIndex,
											question: q.question,
											kind: "option" as const,
											answer: q.options[0]!.label,
											preview: q.options[0]!.preview,
											notes: "  raw note\n",
										},
							),
						};
					},
				},
			},
		});
		try {
			await session.prompt("/workflow stage-host --no-picker");
			const tool = session.agent.state.tools.find((entry) => entry.name === "workflow")!;
			await vi.waitFor(
				async () =>
					assert.ok(
						received.length >= 1,
						JSON.stringify(
							(await tool.execute("status", { action: "status" }, new AbortController().signal)).details,
						),
					),
				{ timeout: 10000 },
			);
			assert.deepEqual(received[0], params);
			await vi.waitFor(() => assert.equal(received.length, 2), { timeout: 10000 });
			assert.deepEqual(received[1], {
				questions: [
					{
						question: "Are you ready to move on to the next stage?",
						header: "Continue?",
						options: [
							{
								label: "I'm ready to move on to the next workflow stage.",
								description: "Complete this stage and advance the workflow.",
							},
							{
								label: "I have more to explore or ask about.",
								description: "Stay in this stage and keep working in the chat composer.",
							},
						],
					},
				],
			});
			const toolReply = JSON.parse(
				readFileSync(join(cwd, "questionnaire-results.jsonl"), "utf8").trim().split("\n")[0]!,
			);
			assert.deepEqual(toolReply, {
				cancelled: false,
				answers: [
					{
						questionIndex: 0,
						question: params.questions[0]!.question,
						kind: "option",
						answer: " Second ",
						preview: "  preview B\n",
						notes: "  raw note\n",
					},
					{
						questionIndex: 1,
						question: params.questions[1]!.question,
						kind: "multi",
						answer: null,
						selected: [" Z ", " A "],
						notes: "  raw note\n",
					},
				],
			});
			assert.ok(identities[0]!.workflowRunId);
			assert.ok(identities[0]!.workflowStageId);
			// #3105: broker presentation retains the originating child, not the root host's identity.
			assert.notEqual(identities[0]!.sessionId, session.sessionId);
			assert.equal(identities[0]!.workflowStageId, identities[1]!.workflowStageId);
			const details = (await tool.execute("status", { action: "status" }, new AbortController().signal)).details as {
				runs: { runId: string }[];
			};
			if (scenario === "nested") assert.notEqual(identities[0]!.workflowRunId, details.runs[0]!.runId);
			else assert.equal(identities[0]!.workflowRunId, details.runs[0]!.runId);
			if (scenario === "missing") {
				await session.bindExtensions({ humanInput: null });
				assert.equal(identities[1]!.signal.aborted, true);
				lateReadiness.resolve({
					cancelled: false,
					answers: [
						{
							questionIndex: 0,
							question: "Are you ready to move on to the next stage?",
							kind: "option",
							answer: "I'm ready to move on to the next workflow stage.",
						},
					],
				});
			}
			if (scenario !== "approval" && scenario !== "nested") {
				await new Promise((resolve) => setImmediate(resolve));
				const pending = (await tool.execute("status", { action: "status" }, new AbortController().signal))
					.details as { runs: { status: string }[] };
				assert.equal(pending.runs[0]!.status, "running");
				if (scenario !== "stay") assert.match(JSON.stringify(pending), /"promptKind":"readiness_gate"/);
				assert.equal(existsSync(effect), false);
				return;
			}
			await vi.waitFor(
				async () =>
					assert.equal(
						(
							(await tool.execute("status", { action: "status" }, new AbortController().signal)).details as {
								runs: { status: string }[];
							}
						).runs[0]?.status,
						"completed",
					),
				{ timeout: 5000 },
			);
			assert.equal(readFileSync(effect, "utf8"), "accepted\n");
		} finally {
			await session.dispose();
			vi.unstubAllEnvs();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: one on-disk definition, identical runtime policy, real CLI dialog bridge.
test.each(["true", "false", "cancelled", "invalid", "late"] as const)(
	"unchanged workflow across hosts: %s",
	async (reply) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-same-host-source-"));
		const directory = join(cwd, ".atomic", "workflows");
		mkdirSync(directory, { recursive: true });
		const effect = join(cwd, "effects.jsonl");
		const source = join(directory, "sdk-host-durable.ts");
		writeFileSync(source, readFileSync(new URL("../fixtures/sdk-host-durable-workflow.ts", import.meta.url)));
		vi.stubEnv("ATOMIC_FAULT_TEST_HOME", cwd);
		const hash = () => createHash("sha256").update(readFileSync(source)).digest("hex");
		const original = hash();
		const text = "  durable text  ";
		const options = {
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: SettingsManager.inMemory(),
			builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		};
		try {
			for (const host of ["node", "cli"] as const) {
				const presentation = attachedCliPresentation(text, reply);
				const requests: HostInputOptions[] = [];
				const late = Promise.withResolvers<boolean>();
				const { session: cli } = await createAgentSession({
					...options,
					builtins: { ...options.builtins, workflows: false },
					sessionManager: SessionManager.inMemory(cwd),
					extensionBindings: { uiContext: presentation.uiContext },
				});
				const humanInput =
					host === "cli"
						? forwardCliDialogs(cli.extensionRunner!.createContext().ui)
						: {
								input: async () => text,
								confirm: async (_title: string, _message: string, options: HostInputOptions) => {
									requests.push(options);
									if (reply === "late" || reply === "cancelled") return late.promise;
									return (reply === "invalid" ? "true" : reply === "true") as boolean;
								},
								select: async () => undefined,
								editor: async () => undefined,
								questionnaire: async () => ({ answers: [], cancelled: true }),
							};
				const { session } = await createAgentSession({
					...options,
					sessionManager: SessionManager.inMemory(cwd),
					extensionBindings: { humanInput },
				});
				try {
					await session.prompt("/workflow sdk-host-durable --no-picker");
					const tool = session.agent.state.tools.find((t) => t.name === "workflow")!;
					await vi.waitFor(
						() =>
							assert.equal(
								host === "cli" ? presentation.dialogs.length : requests.length,
								host === "cli" ? 2 : 1,
							),
						{ timeout: 5000 },
					);
					if (reply === "late" || reply === "cancelled") {
						await session.bindExtensions({ humanInput: null });
						if (host === "cli")
							assert.equal(presentation.activeDialog, false, "actual CLI abort handler dismissed the dialog");
						else assert.equal(requests[0]!.signal.aborted, true);
						if (reply === "late") {
							presentation.lateTrue();
							late.resolve(true);
						}
					}
					// Drain adapter settlement before asserting that malformed/stale replies cannot advance.
					await new Promise((resolve) => setImmediate(resolve));
					await vi.waitFor(
						async () => {
							const result = await tool.execute("status", { action: "status" }, new AbortController().signal);
							assert.equal(
								(result.details as { runs: { status: string }[] }).runs[0]?.status,
								reply === "true" || reply === "false" ? "completed" : "running",
								JSON.stringify({ host, dialogs: presentation.dialogs, details: result.details }),
							);
							if (reply !== "true" && reply !== "false")
								assert.match(JSON.stringify(result.details), /"promptKind":"confirm"/);
							else
								assert.deepEqual(
									(result.details as { snapshots: { result: unknown }[] }).snapshots[0]?.result,
									{ text, approved: reply === "true" },
								);
						},
						{ timeout: 5000 },
					);
					if (host === "cli") assert.deepEqual(presentation.dialogs, ["input", "confirm"]);
					assert.equal(hash(), original);
				} finally {
					await session.dispose();
					await cli.dispose();
				}
			}
			if (reply === "true")
				assert.deepEqual(
					readFileSync(effect, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
					[{ text }, { text }],
				);
			else assert.equal(existsSync(effect), false);
		} finally {
			vi.unstubAllEnvs();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// Two fresh DBOS/Postgres processes, including backend startup and graceful shutdown.
const REAL_PERSISTED_HOST_HANDOFF_TIMEOUT_MS = 120_000;

// #3105: actual DBOS/Postgres disk reopen, not an in-memory checkpoint copy.
test.each(["node", "cli"] as const)(
	"persisted handoff from %s to the other host",
	async (host) => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		type Receipt = {
			runId: string;
			hash: string;
			requestId: string;
			dialogs: string[];
			pending?: { kind: string; message: string };
		};
		try {
			const first = home.client(
				listener.port,
				{ HANDOFF_HOST: host, HANDOFF_PHASE: "start", ATOMIC_WORKFLOW_ARTIFACT_DIR: join(home.path, "artifacts") },
				"sdk-host-durable-client.ts",
			);
			const before = await first.request<Receipt>("start");
			assert.equal(before.pending?.kind, "confirm");
			assert.equal(existsSync(join(home.path, "effects.jsonl")), false);
			await first.exit();
			const second = home.client(
				listener.port,
				{
					HANDOFF_HOST: host === "node" ? "cli" : "node",
					HANDOFF_PHASE: "resume",
					ATOMIC_WORKFLOW_ARTIFACT_DIR: join(home.path, "artifacts"),
				},
				"sdk-host-durable-client.ts",
			);
			const after = await second.request<Receipt>("resume", before.runId);
			assert.equal(after.runId, before.runId);
			assert.equal(after.hash, before.hash);
			assert.equal(after.pending?.kind, before.pending?.kind);
			assert.equal(after.pending?.message, before.pending?.message);
			assert.notEqual(after.requestId, before.requestId);
			assert.deepEqual(
				host === "cli" ? before.dialogs : after.dialogs,
				host === "cli" ? ["input", "confirm"] : ["confirm"],
			);
			assert.equal(
				readFileSync(join(home.path, "receipts.jsonl"), "utf8"),
				`${JSON.stringify({ text: "  durable text  " })}\n`,
			);
			assert.equal(
				readFileSync(join(home.path, "effects.jsonl"), "utf8"),
				`${JSON.stringify({ text: "  durable text  " })}\n`,
			);
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_PERSISTED_HOST_HANDOFF_TIMEOUT_MS,
);

// #3105: ordinary non-prompt-node refusal is separate from a required durable gate.
test("missing adapter refuses ordinary dialog and leaves durable approval pending", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-missing-host-"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
	});
	const context = session.extensionRunner!.createContext();
	const store = createStore();
	const controller = new AbortController();
	let effects = 0;
	try {
		const ordinary = workflow({
			name: "ordinary-missing",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.ui.input("ordinary");
				return {};
			},
		});
		const result = await run(
			ordinary,
			{},
			{
				store,
				durableBackend: new InMemoryDurableBackend(),
				usePromptNodesForUi: false,
				ui: {
					input: async (prompt) => (await context.ui.input(prompt))!,
					confirm: (message) => context.ui.confirm("approval", message),
					select: async (message, choices) => (await context.ui.select(message, [...choices])) as never,
					editor: async (initial) => (await context.ui.editor("editor", initial))!,
				},
			},
		);
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /HumanInputUnavailable/);
		const durable = workflow({
			name: "durable-missing",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				if (await ctx.ui.confirm("required approval")) await ctx.tool("guarded", {}, async () => ++effects);
				return {};
			},
		});
		const pending = run(
			durable,
			{},
			{ store, durableBackend: new InMemoryDurableBackend(), usePromptNodesForUi: true, signal: controller.signal },
		);
		try {
			await vi.waitFor(() =>
				assert.ok(store.runs().some((run) => run.stages.some((stage) => stage.pendingPrompt?.kind === "confirm"))),
			);
			assert.equal(effects, 0);
		} finally {
			controller.abort();
			await pending;
		}
		assert.equal(effects, 0);
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: human capability is not permission to bypass an exhausted budget.
test.each(["missing", "nonapproval"] as const)("workflow budget stays blocked with %s input", async (host) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-host-budget-"));
	const directory = join(cwd, ".atomic", "workflows");
	mkdirSync(directory, { recursive: true });
	const effect = join(cwd, "effect");
	writeFileSync(
		join(directory, "host-budget.ts"),
		`
import { workflow } from "@bastani/atomic/workflows";
import { writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
export default workflow({ name: "host-budget", description: "budget boundary", inputs: {}, outputs: {},
  budget: { maxDurationMs: 1 }, run: async (ctx) => {
    await ctx.tool("exhaust-budget", {}, async () => { await setTimeout(10); return true; });
    await ctx.tool("must-not-run", {}, async () => { writeFileSync(${JSON.stringify(effect)}, "unauthorized"); return true; });
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
		extensionBindings: {
			humanInput:
				host === "missing"
					? null
					: {
							input: async () => undefined,
							confirm: async () => false,
							select: async () => undefined,
							editor: async () => undefined,
							questionnaire: async () => ({ answers: [], cancelled: true }),
						},
		},
	});
	try {
		await session.prompt("/workflow host-budget --no-picker");
		const tool = session.agent.state.tools.find((entry) => entry.name === "workflow")!;
		await vi.waitFor(
			async () => {
				const details = (await tool.execute("status", { action: "status" }, new AbortController().signal)).details;
				assert.match(JSON.stringify(details), /"status":"budget_exceeded"/);
			},
			{ timeout: 5000 },
		);
		assert.equal(existsSync(effect), false);
		await session.bindExtensions({});
		await new Promise((resolve) => setImmediate(resolve));
		const details = (await tool.execute("status", { action: "status" }, new AbortController().signal)).details;
		assert.match(JSON.stringify(details), /"status":"budget_exceeded"/);
		assert.equal(existsSync(effect), false, "rebinding cannot raise the exhausted budget");
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// Real Node imports built assets and exits normally after awaited public session disposal.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;
// #3105: source-alias tests are not executable package host-routing evidence.
test(
	"built non-TTY Node routes the unchanged workflow and exits after public session disposal",
	() => {
		const result = spawnSyncCollect(
			[process.execPath, fileURLToPath(new URL("../fixtures/sdk-host-built-node.mjs", import.meta.url))],
			{
				timeout: BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
			},
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const receipt = JSON.parse(result.stdout.toString().trim());
		assert.equal(receipt.host, "built-node");
		assert.equal(
			receipt.hash,
			createHash("sha256")
				.update(readFileSync(new URL("../fixtures/sdk-host-durable-workflow.ts", import.meta.url)))
				.digest("hex"),
		);
		assert.deepEqual(receipt.result, { text: "  durable text  ", approved: true });
		assert.equal(receipt.effects, 1);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test(
	"built non-TTY Node finalizes a pending workflow when replacement creation rejects before a new session",
	() => {
		const result = spawnSyncCollect(
			[
				process.execPath,
				fileURLToPath(new URL("../fixtures/sdk-host-built-node.mjs", import.meta.url)),
				"--replacement-failure",
			],
			{ timeout: BUILT_NODE_HOST_PROCESS_TIMEOUT_MS },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString().trim()), {
			host: "built-node",
			replacementFailed: true,
			initiallyPending: true,
			disposed: true,
		});
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

// #3105: duplicate answers are rejected by the runtime's pending identity, not only Promise settlement.
test("durable prompt identity accepts one answer and refuses a repeated answer", async () => {
	const store = createStore();
	let effects = 0;
	const definition = workflow({
		name: "duplicate-gate",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			if (await ctx.ui.confirm("approve once")) await ctx.tool("guarded", {}, async () => ++effects);
			return {};
		},
	});
	const controller = new AbortController();
	const pending = run(
		definition,
		{},
		{ store, durableBackend: new InMemoryDurableBackend(), usePromptNodesForUi: true, signal: controller.signal },
	);
	try {
		await vi.waitFor(() => assert.ok(store.runs()[0]?.stages.some((stage) => stage.pendingPrompt)));
		const root = store.runs()[0]!;
		const stage = root.stages.find((stage) => stage.pendingPrompt)!;
		const promptId = stage.pendingPrompt!.id;
		assert.equal(store.resolveStagePendingPrompt(root.id, stage.id, promptId, true), true);
		assert.equal(store.resolveStagePendingPrompt(root.id, stage.id, promptId, true), false);
		assert.equal((await pending).status, "completed");
		assert.equal(store.resolveStagePendingPrompt(root.id, stage.id, promptId, true), false);
		assert.equal(effects, 1);
	} finally {
		controller.abort();
		await pending;
	}
});

// #3105: production workflow adapter must narrow, not replace, its parent's selection.
test("workflow child inherits SDK host and disabled tool ceiling", async () => {
	const { buildRuntimeAdapters } = await import("../../packages/workflows/src/extension/wiring.js");
	const cwd = mkdtempSync(join(tmpdir(), "atomic-child-inheritance-"));
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		excludedTools: ["bash"],
		extensionBindings: {
			humanInput: {
				input: async () => "  inherited  ",
				confirm: async () => false,
				select: async () => undefined,
				editor: async () => undefined,
				questionnaire: async () => ({ answers: [], cancelled: true }),
			},
		},
	});
	let child: typeof parent | undefined;
	try {
		const adapters = buildRuntimeAdapters(
			{ getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions },
			{
				createAgentSession: async (options) => {
					const result = await createAgentSession(options);
					child = result.session;
					return result as unknown as import("../../packages/workflows/src/runs/foreground/stage-runner.js").StageSessionCreateResult;
				},
			},
		);
		await adapters.agentSession!.create({
			tools: ["bash", "read", "workflow"],
			sessionManager: SessionManager.inMemory(cwd),
		});
		assert.ok(child);
		assert.deepEqual(child.getActiveToolNames(), ["read"]);
		assert.equal(child.settingsManager, parent.settingsManager);
		assert.equal(await child.extensionRunner.createContext().ui.input("question"), "  inherited  ");
	} finally {
		child?.dispose();
		parent.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: production workflow adapter preserves optional inheritance and manager cwd precedence.
test.each(["omitted", "undefined", "manager", "relative"] as const)(
	"workflow child configuration boundaries: %s",
	async (mode) => {
		const { buildRuntimeAdapters } = await import("../../packages/workflows/src/extension/wiring.js");
		const { getModel } = await import("@bastani/pi-ai/compat");
		const cwd = mkdtempSync(join(tmpdir(), "atomic-child-options-"));
		const managerCwd = join(cwd, "manager");
		mkdirSync(managerCwd);
		const host = {
			input: async () => "  inherited\n",
			confirm: async () => false,
			select: async () => undefined,
			editor: async () => "",
			questionnaire: async () => ({ answers: [], cancelled: true }),
		};
		const { session: parent } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			thinkingLevel: "high",
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["read"],
			extensionBindings: { humanInput: host },
		});
		let child: typeof parent | undefined;
		try {
			const adapters = buildRuntimeAdapters(
				{ getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions },
				{
					createAgentSession: async (options) => {
						const result = await createAgentSession(options);
						child = result.session;
						return result as unknown as import("../../packages/workflows/src/runs/foreground/stage-runner.js").StageSessionCreateResult;
					},
				},
			);
			const options = Object.freeze({
				sessionManager: SessionManager.inMemory(mode === "manager" || mode === "relative" ? managerCwd : cwd),
				...(mode === "relative" ? { cwd: "." } : {}),
				...(mode === "undefined"
					? {
							model: undefined,
							modelRuntime: undefined,
							settingsManager: undefined,
							agentDir: undefined,
							thinkingLevel: undefined,
							tools: undefined,
							builtins: undefined,
							extensionBindings: Object.freeze({ humanInput: undefined }),
						}
					: {}),
			});
			await adapters.agentSession!.create(options, {
				runId: "configuration",
				stageId: mode,
				stageName: mode,
				executionMode: "interactive",
				signal: new AbortController().signal,
			});
			assert.ok(child);
			assert.equal(child.extensionRunner.createContext().cwd, mode === "manager" ? managerCwd : cwd);
			assert.equal(child.sessionManager, options.sessionManager);
			assert.equal(child.model, parent.model);
			assert.equal(child.thinkingLevel, parent.thinkingLevel);
			assert.equal(child.settingsManager, parent.settingsManager);
			assert.deepEqual(child.getActiveToolNames(), ["read"]);
			assert.equal(await child.extensionRunner.createContext().ui.input("question"), "  inherited\n");
			assert.equal(options.extensionBindings?.humanInput, undefined);
		} finally {
			await child?.dispose();
			await parent.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: exercise the real in-process runner, not its testSession stub.
test.each([false, true])(
	"subagent child uses the parent's model runtime and tool ceiling, fallback=%s",
	async (fallback) => {
		const { getModel, createAssistantMessageEventStream } = await import("@bastani/pi-ai/compat");
		const { AuthStorage, ModelRuntime } = await import("../../packages/coding-agent/src/index.js");
		const { runSingleInProcess } = await import("../../packages/subagents/src/runs/foreground/inprocess-run-sync.js");
		const { clearSubagentControls } = await import("../../packages/subagents/src/runs/inprocess/control-registry.js");
		const cwd = mkdtempSync(join(tmpdir(), "atomic-real-child-"));
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, provider: "child-parity" };
		const fallbackModel = { ...model, id: "child-fallback" };
		const requestedModels: string[] = [];
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const observed: string[][] = [];
		runtime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "child-fixture-key",
			models: [model, fallbackModel],
			streamSimple: (requestModel, context) => {
				requestedModels.push(requestModel.id);
				observed.push(getCurrentTools(context.messages).map((tool) => tool.name));
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "child complete" }],
					api: model.api,
					provider: model.provider,
					model: requestModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				if (fallback && requestModel.id === model.id) {
					const error = { ...message, stopReason: "error" as const, errorMessage: "model not found" };
					stream.push({ type: "error", reason: "error", error });
					stream.end(error);
					return stream;
				}
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			},
		});
		const { session: parent } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime: runtime,
			model,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["read"],
			fallbackModels: fallback ? [`${model.provider}/${fallbackModel.id}`] : [],
		});
		try {
			const result = await runSingleInProcess(
				cwd,
				{
					name: "worker",
					description: "fixture",
					systemPrompt: "",
					systemPromptMode: "replace",
					inheritProjectContext: false,
					inheritSkills: false,
					source: "user",
					filePath: join(cwd, "worker.md"),
					tools: ["read", "bash", "intercom"],
				},
				"report",
				{
					cwd,
					runId: `parity-${parent.sessionManager.getSessionId()}`,
					sessionDir: join(cwd, "children"),
					testSession: false,
					currentModel: `${model.provider}/${model.id}`,
					resolveCandidateModel: () => ({ model }),
					getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
				},
			);
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.deepEqual(requestedModels, fallback ? [model.id, fallbackModel.id] : [model.id]);
			assert.deepEqual(
				observed,
				requestedModels.map(() => ["read"]),
			);
		} finally {
			parent.dispose();
			clearSubagentControls();
			runtime.unregisterProvider(model.provider);
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: exercise the real child session, broker waiter and workflow host consumer.
const childHostBindingModes = [
	"override",
	"null",
	"withdrawn",
	"parent-rebind",
	"parent-change",
	"reuse-null",
	"reuse-direct",
	"reuse-reload",
	"inherit-reload",
] as const;
test.each(childHostBindingModes)(
	"stage questionnaire respects child host precedence and durable rebind: %s",
	async (mode) => {
		const { buildRuntimeAdapters } = await import("../../packages/workflows/src/extension/wiring.js");
		const { bindWorkflowHumanInput } = await import("../../packages/workflows/src/extension/workflow-human-input.js");
		const { store } = await import("../../packages/workflows/src/shared/store.js");
		const { stageUiBroker } = await import("../../packages/workflows/src/shared/stage-ui-broker.js");
		const { buildStagePromptAdapter } = await import("../../packages/workflows/src/shared/stage-prompt.js");
		const cwd = mkdtempSync(join(tmpdir(), "atomic-child-questionnaire-"));
		const params = {
			questions: [
				{ question: "Private decision", header: "Private", options: [{ label: "parent" }, { label: "child" }] },
			],
		};
		const calls: string[] = [];
		const identities: HostInputOptions[] = [];
		const answerReady = Promise.withResolvers<void>();
		const host = (label: string) => ({
			input: async () => "",
			select: async () => undefined,
			confirm: async () => false,
			editor: async () => "",
			questionnaire: async (_params: typeof params, identity: HostInputOptions) => {
				calls.push(label);
				identities.push(identity);
				if (mode === "parent-change") await answerReady.promise;
				return {
					cancelled: false,
					answers: [
						{ questionIndex: 0, question: params.questions[0]!.question, kind: "option" as const, answer: label },
					],
				};
			},
		});
		const original = host("child");
		const reuse = mode.startsWith("reuse-");
		const { session: parent } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["ask_user_question"],
			extensionBindings: { humanInput: reuse ? original : host("parent") },
		});
		const unbind = bindWorkflowHumanInput(
			store,
			parent.extensionRunner!.createContext() as unknown as import("../../packages/workflows/src/extension/workflow-human-input.js").WorkflowHumanInputContext,
		);
		const runId = `child-precedence-${crypto.randomUUID()}`;
		const stageId = "private";
		store.recordRunStart({
			id: runId,
			name: "precedence",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
		const adapters = buildRuntimeAdapters(
			{ getChildSessionOptions: parent.extensionRunner!.createContext().getChildSessionOptions },
			{
				createAgentSession: async (options) =>
					(await createAgentSession(
						options,
					)) as unknown as import("../../packages/workflows/src/runs/foreground/stage-runner.js").StageSessionCreateResult,
			},
		);
		const result = await adapters.agentSession!.create(
			{
				sessionManager: SessionManager.inMemory(cwd),
				...(mode === "override" || mode === "null" || mode === "parent-change"
					? { extensionBindings: { humanInput: mode === "null" ? null : host("child") } }
					: {}),
			},
			{ runId, stageId, stageName: stageId, executionMode: "interactive", signal: new AbortController().signal },
		);
		const child = "session" in result ? result.session : result;
		let presentations = 0;
		const detachPresentation =
			mode === "parent-rebind" || mode === "inherit-reload" || reuse
				? () => {}
				: stageUiBroker.registerHost(runId, stageId, {
						showCustomUi: () => {
							presentations++;
						},
					});
		try {
			stageUiBroker.provideStagePrompt(
				runId,
				stageId,
				buildStagePromptAdapter("private-question", "ask_user_question", params, Date.now())!,
			);
			const session = child as import("../../packages/coding-agent/src/index.js").AgentSession;
			if (mode === "withdrawn") await session.bindExtensions({ humanInput: null });
			if (mode === "parent-rebind") await parent.bindExtensions({ humanInput: null });
			if (reuse) {
				await parent.bindExtensions({ humanInput: host("parent") });
				if (mode === "reuse-null") await session.bindExtensions({ humanInput: null });
				await session.bindExtensions({ humanInput: original });
				await session.bindExtensions({});
				if (mode === "reuse-reload") await session.reload();
			}
			if (mode === "inherit-reload") {
				await session.bindExtensions({});
				await session.reload();
				await parent.bindExtensions({ humanInput: host("child") });
			}
			const tool = session.agent.state.tools.find((entry) => entry.name === "ask_user_question")!;
			let settled = false;
			const pending = tool.execute("private-question", params, AbortSignal.timeout(5000)).then((reply) => {
				settled = true;
				return reply;
			});
			if (mode === "parent-change") {
				await vi.waitFor(() => assert.deepEqual(calls, ["child"]));
				await parent.bindExtensions({ humanInput: host("parent") });
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(
					identities[0]!.signal.aborted,
					false,
					"parent rebinding must not retire an explicit child host request",
				);
				answerReady.resolve();
			} else if (mode !== "override" && !reuse && mode !== "inherit-reload") {
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(settled, false, "withdrawal must leave the broker waiter pending");
				assert.deepEqual(calls, [], "the parent must not answer a withdrawn child request");
				assert.ok(stageUiBroker.peekStageQuestionnaire(runId, stageId));
				if (mode !== "parent-rebind") assert.equal(session.extensionRunner!.createContext().hasHumanInput, false);
				await (mode === "parent-rebind" ? parent : session).bindExtensions({ humanInput: host("child") });
			}
			const reply = await pending;
			assert.equal((reply.details as { answers: { answer: string }[] }).answers[0]!.answer, "child");
			assert.deepEqual(calls, ["child"]);
			assert.equal(presentations, 0, "an attached parent renderer must not bypass child host precedence");
			assert.equal(identities[0]!.sessionId, session.sessionId);
			assert.equal(identities[0]!.workflowRunId, runId);
			assert.equal(identities[0]!.workflowStageId, stageId);
		} finally {
			answerReady.resolve();
			detachPresentation();
			await child.dispose?.();
			unbind();
			await parent.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: the production controller must not launder fallback models into unrestricted primaries.
test("workflow fallback replacement enforces the inherited gate but explicit primary remains valid", async () => {
	const { getModel, createAssistantMessageEventStream } = await import("@bastani/pi-ai/compat");
	const { AuthStorage, ModelRuntime } = await import("../../packages/coding-agent/src/index.js");
	const { buildRuntimeAdapters } = await import("../../packages/workflows/src/extension/wiring.js");
	const { createStageContext } = await import("../../packages/workflows/src/runs/foreground/stage-runner.js");
	const cwd = mkdtempSync(join(tmpdir(), "atomic-stage-fallback-policy-"));
	const primary = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		provider: "stage-inheritance-fixture",
		id: "primary",
	};
	const forbidden = { ...primary, id: "forbidden" };
	const allowed = { ...primary, id: "allowed" };
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const calls: string[] = [];
	const checked: string[] = [];
	runtime.registerProvider(primary.provider, {
		api: primary.api,
		baseUrl: primary.baseUrl,
		apiKey: "fixture-key",
		models: [primary, forbidden, allowed],
		streamSimple: (model) => {
			calls.push(model.id);
			const stream = createAssistantMessageEventStream();
			const fail = model.id === "primary";
			const message: import("@bastani/pi-ai/compat").AssistantMessage = {
				role: "assistant",
				content: fail ? [] : [{ type: "text", text: model.id }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: fail ? "error" : "stop",
				...(fail ? { errorMessage: "model not found" } : {}),
				timestamp: Date.now(),
			};
			stream.push(
				fail ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message },
			);
			stream.end(message);
			return stream;
		},
	});
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		modelRuntime: runtime,
		model: primary,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: [],
		fallbackModels: [],
		isFallbackModelAllowed: (model) => {
			checked.push(model.id);
			return model.id !== "forbidden";
		},
	});
	const adapters = buildRuntimeAdapters(
		{ getChildSessionOptions: parent.extensionRunner!.createContext().getChildSessionOptions },
		{
			createAgentSession: async (options) =>
				(await createAgentSession(
					options,
				)) as unknown as import("../../packages/workflows/src/runs/foreground/stage-runner.js").StageSessionCreateResult,
		},
	);
	const models = {
		listModels: async () =>
			[primary, forbidden, allowed].map((model) => ({
				id: model.id,
				provider: model.provider,
				fullId: `${model.provider}/${model.id}`,
				model,
			})),
	};
	const stage = createStageContext({
		stageId: "fallback",
		stageName: "fallback",
		runId: "policy",
		adapters,
		models,
		stageOptions: {
			model: primary,
			fallbackModels: [`${primary.provider}/forbidden`, `${primary.provider}/allowed`],
		},
	});
	const explicit = createStageContext({
		stageId: "explicit",
		stageName: "explicit",
		runId: "policy",
		adapters,
		models,
		stageOptions: { model: forbidden },
	});
	try {
		assert.equal(await stage.prompt("reply once"), "allowed");
		assert.deepEqual(calls, ["primary", "allowed"]);
		assert.ok(checked.includes("forbidden"));
		assert.ok(checked.includes("allowed"));
		assert.equal(await explicit.prompt("explicit primary"), "forbidden");
		assert.deepEqual(calls, ["primary", "allowed", "forbidden"]);
	} finally {
		await stage.__dispose();
		await explicit.__dispose();
		await parent.dispose();
		runtime.unregisterProvider(primary.provider);
		rmSync(cwd, { recursive: true, force: true });
	}
});
