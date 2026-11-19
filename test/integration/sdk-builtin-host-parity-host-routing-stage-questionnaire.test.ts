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

/**
 * Each case starts a real SDK session with its bundled extensions, loads the provider extension and the workflow
 * definition from source, and runs a real workflow stage session through the broker: about 7 s on an idle machine and
 * 14-33 s on a loaded CI runner.
 */
const REAL_STAGE_HOST_SESSION_TIMEOUT_MS = 90_000;

// #3105: exact authored questionnaire through actual factory/stage/broker, no renderer.
test.for(["approval", "nested", "cancelled", "invalid", "missing", "stay"] as const)(
	"Node stage questionnaire preserves original params and readiness: %s",
	{ timeout: REAL_STAGE_HOST_SESSION_TIMEOUT_MS },
	async (scenario, { signal }) => {
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
  await ctx.stage("reviewer", { sessionDir: ${JSON.stringify(join(cwd, "stage-sessions"))}, builtins: { subagents: false, mcp: false, intercom: false, "web-access": false }, model: "host-questionnaire-fixture/fixture", cwd: ${JSON.stringify(cwd)}, agentDir: ${JSON.stringify(join(cwd, "agent"))}, tools: ["ask_user_question"] }).prompt(${JSON.stringify(`questionnaire ${JSON.stringify(params)}`)});
  await ctx.tool("counted-effect", {}, async () => { appendFileSync(${JSON.stringify(effect)}, "accepted\\n"); return true; });
  return {};
} });
export default ${scenario === "nested" ? 'workflow({ name: "stage-host", description: "nested host fixture", inputs: {}, outputs: {}, run: async (ctx) => { await ctx.workflow(child); return {}; } })' : "child"};`,
		);
		const received: unknown[] = [];
		const identities: HostInputOptions[] = [];
		// The host is asked once the stage session publishes the question's tool event, and a session publishes its
		// events in order behind the persistence of every earlier message, so the first question arrives at the
		// session store's pace. Wait for the host call itself; only the runner's own per-test signal bounds a hang.
		const waiting: { count: number; resolve: () => void }[] = [];
		const askedAtLeast = (count: number): Promise<void> =>
			new Promise((resolve, reject) => {
				if (received.length >= count) return resolve();
				waiting.push({ count, resolve });
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
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
						for (const waiter of waiting.splice(0)) {
							if (received.length >= waiter.count) waiter.resolve();
							else waiting.push(waiter);
						}
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
			const tool = session.agent.state.tools.find((entry) => entry.name === "workflow")!;
			await tool.execute("run", { action: "run", workflow: "stage-host", inputs: {} }, new AbortController().signal);
			// A hang reports where the workflow stopped instead of only the runner's timeout.
			signal.addEventListener(
				"abort",
				() => {
					void tool.execute("status", { action: "status" }, new AbortController().signal).then(
						(status) => console.error(`stage question never reached the host: ${JSON.stringify(status.details)}`),
						() => undefined,
					);
				},
				{ once: true },
			);
			await askedAtLeast(1);
			assert.deepEqual(received[0], params);
			await askedAtLeast(2);
			assert.equal(received.length, 2);
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
