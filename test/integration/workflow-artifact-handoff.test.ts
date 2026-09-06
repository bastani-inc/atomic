import assert from "node:assert/strict";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { test } from "vitest";
import type { StageAdmittedCustomMessage } from "../../packages/coding-agent/src/core/messages.js";
import { createHarness } from "../../packages/coding-agent/test/test-harness.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
	createStageContext,
	type StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { fileExists, readText, removePathSync } from "../helpers/runtime.js";
import { assistantMessageWithUsage } from "../unit/stage-runner-helpers.js";

const REPORT =
	"# Complete report\n\nFinding one: completed stages publish results.\nFinding two: replay has several paths.";
const CLARIFICATION =
	"### Additional verified caveat\n\nReplay callbacks are heterogeneous; store observation covers more paths.";
const PRIVATE_TOOL_TEXT = "TOOL-ONLY diagnostic, not a deliverable";
const PROGRESS_TEXT = "PROGRESS-ONLY checking the evidence";
const FOLLOW_UP = "USER-ONLY verify the replay callback caveat";

// Incident: report at producer JSONL line 115, tool call at 119, caveat at 122.
// Exercise real Agent/AgentSession queue timing, stage export, task receipt and
// downstream reads. No model service, Intercom broker or workflow launch is used.
test.each(["custom", "user"])(
	"a queued %s clarification preserves the report in the downstream artifact",
	async (kind) => {
		const trace: string[] = [];
		let output = "";
		let artifactExistedAtReport: boolean | undefined;
		const inspectTool: AgentTool = {
			name: "inspect_evidence",
			label: "Inspect evidence",
			description: "Return deterministic test evidence",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: PRIVATE_TOOL_TEXT }], details: {} };
			},
		};
		const producer = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false }, sessionSummary: { enabled: false } },
			baseToolsOverride: { inspect_evidence: inspectTool },
			responses: [
				{ text: PROGRESS_TEXT, toolCalls: [{ id: "initial-check", name: "inspect_evidence", args: {} }] },
				{ text: REPORT, thinking: "THINKING-ONLY report deliberation" },
				{ toolCalls: [{ id: "caveat-check", name: "inspect_evidence", args: {} }] },
				CLARIFICATION,
				"Continuation complete",
			],
			configureAgent(agent) {
				agent.subscribe(async (event) => {
					if (event.type === "turn_end" && event.message.role === "assistant") {
						const text = event.message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("");
						if (text === REPORT) {
							trace.push("report turn ended");
							artifactExistedAtReport = await fileExists(output);
							const followUp: StageAdmittedCustomMessage = {
								role: "custom",
								customType: "artifact-test-clarification",
								content: FOLLOW_UP,
								display: true,
								timestamp: Date.now(),
								stageAdmissionKey: "clarification-1",
							};
							agent.followUp(
								kind === "custom" ? followUp : { role: "user", content: FOLLOW_UP, timestamp: Date.now() },
							);
							trace.push("follow-up queued");
						}
						if (text === CLARIFICATION) trace.push("clarification turn ended");
					}
					if (event.type === "agent_end") trace.push("agent ended");
				});
			},
		});
		output = join(producer.tempDir, "complete report.md");
		// A forked/restored assistant answer is context, not this prompt's output.
		producer.sessionManager.appendMessage({ role: "user", content: "Earlier task", timestamp: 0 });
		producer.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "HISTORY-ONLY previous deliverable" }],
			api: "anthropic-messages",
			provider: "faux",
			model: "faux-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		});
		producer.agent.state.messages = producer.sessionManager.buildSessionContext().messages;
		producer.session.setActiveToolsByName(["inspect_evidence"]);
		let consumedArtifact: string | undefined;
		const readSchema = Type.Object({ path: Type.String() });
		const readArtifact: AgentTool<typeof readSchema> = {
			name: "read_artifact",
			label: "Read artifact",
			description: "Read the producer's actual saved artifact",
			parameters: readSchema,
			async execute(_id, args) {
				assert.equal(args.path, output);
				consumedArtifact = await readText(args.path);
				trace.push("consumer read artifact");
				return { content: [{ type: "text", text: consumedArtifact }], details: {} };
			},
		};
		const consumer = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false }, sessionSummary: { enabled: false } },
			baseToolsOverride: { read_artifact: readArtifact },
			responses: [
				{ toolCalls: [{ id: "read-report", name: "read_artifact", args: { path: output } }] },
				"Synthesis complete",
			],
		});
		consumer.session.setActiveToolsByName(["read_artifact"]);
		let receipt: string | undefined;
		let transcriptPath: string | undefined;
		try {
			const definition = workflow({
				name: "artifact-handoff-regression",
				description: "Deterministic report and clarification handoff",
				outputs: { receipt: Type.String(), synthesis: Type.String() },
				run: async (ctx) => {
					const result = await ctx.task("producer", {
						prompt: "Produce the complete report",
						output,
						outputMode: "file-only",
					});
					receipt = result.text;
					trace.push("producer task returned");
					transcriptPath = receipt.match(/^Transcript saved to: (.+) \([^\n]+\)\./m)?.[1];
					const synthesis = await ctx.task("consumer", {
						prompt: "Read the report and synthesize its findings",
						reads: [output],
					});
					return { receipt, synthesis: synthesis.text };
				},
			});
			const result = await run(
				definition,
				{},
				{
					cwd: producer.tempDir,
					store: createStore(),
					executionMode: "non_interactive",
					config: {
						maxDepth: 4,
						defaultConcurrency: 2,
						persistRuns: false,
						statusFile: false,
						resumeInFlight: "never",
					},
					adapters: {
						agentSession: {
							async create(_options, meta) {
								return (meta?.stageName === "producer"
									? producer.session
									: consumer.session) as unknown as StageSessionRuntime;
							},
						},
					},
				},
			);
			assert.equal(result.status, "completed", result.error);
			assert.equal(artifactExistedAtReport, false, "the report was not previously exported and overwritten");
			assert.deepEqual(trace, [
				"report turn ended",
				"follow-up queued",
				"clarification turn ended",
				"agent ended",
				...(kind === "user" ? ["agent ended"] : []),
				"producer task returned",
				"consumer read artifact",
			]);
			assert.equal(
				producer.faux.callCount,
				kind === "custom" ? 4 : 5,
				"user delivery adds an executor continuation",
			);
			assert.equal(consumer.faux.callCount, 2, "downstream session actually reads before producing synthesis");
			assert.equal(result.result?.synthesis, "Synthesis complete");
			assert.ok(receipt);
			assert.ok(receipt?.startsWith(`Output saved to: ${output} (`));
			assert.ok(transcriptPath, "file-only receipt keeps its searchable companion transcript");
			assert.equal(result.stages.find((stage) => stage.name === "producer")?.result, receipt);
			assert.ok(
				consumer.faux.contexts[0]?.messages.some((message) => {
					if (message.role !== "user") return false;
					const text =
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("");
					return text.includes(`[Read from: ${output}]`);
				}),
			);
			const transcript = await readText(transcriptPath);
			assert.ok(
				transcript.includes(REPORT) && transcript.includes(CLARIFICATION),
				"the baseline transcript already retains both",
			);
			assert.ok(consumedArtifact !== undefined);
			assert.ok(consumedArtifact?.includes(CLARIFICATION), "the material clarification must remain available");
			assert.ok(
				consumedArtifact?.includes(REPORT),
				`downstream received only the later answer:\n${consumedArtifact}`,
			);
			assert.ok(consumedArtifact.indexOf(REPORT) < consumedArtifact.indexOf(CLARIFICATION));
			for (const excluded of [PRIVATE_TOOL_TEXT, PROGRESS_TEXT, FOLLOW_UP, "THINKING-ONLY", "HISTORY-ONLY"]) {
				assert.ok(!consumedArtifact.includes(excluded), `${excluded} must remain transcript-only`);
			}
			assert.ok(
				!receipt.includes(REPORT) && !receipt.includes(CLARIFICATION),
				"file-only must not inline the handoff",
			);
		} finally {
			producer.cleanup();
			consumer.cleanup();
			if (transcriptPath) removePathSync(transcriptPath, { force: true });
		}
	},
);

test.each([
	[true, false],
	[true, true],
	[false, false],
	[false, true],
])(
	"navigation excludes old branch history from downstream output, with events=%s continuation=%s",
	async (emitsEvents, continueAfterNavigation) => {
		const producer = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false }, sessionSummary: { enabled: false } },
			responses: [REPORT, CLARIFICATION],
		});
		// A compatible adapter can expose completed messages without emitting events.
		if (!emitsEvents) producer.session.subscribe = () => () => {};
		const history = assistantMessageWithUsage("HISTORY-ONLY unrelated branch answer", {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
		assert.ok(history.role === "assistant");
		producer.sessionManager.appendMessage({ role: "user", content: "An old task", timestamp: 0 });
		const oldLeaf = producer.sessionManager.appendMessage(history);
		producer.sessionManager.resetLeaf();
		producer.agent.state.messages = producer.sessionManager.buildSessionContext().messages;
		assert.equal(producer.session.messages.length, 0);
		const output = join(producer.tempDir, "navigated report.md");
		const context = createStageContext({
			stageId: "navigation",
			stageName: "navigation",
			runId: `navigation-${producer.session.sessionId}`,
			adapters: {
				agentSession: {
					async create() {
						return producer.session as unknown as StageSessionRuntime;
					},
				},
			},
		});
		let consumedArtifact: string | undefined;
		const readArtifact: AgentTool = {
			name: "read_artifact",
			label: "Read artifact",
			description: "Read the producer's saved output",
			parameters: Type.Object({}),
			async execute() {
				consumedArtifact = await readText(output);
				return { content: [{ type: "text", text: consumedArtifact }], details: {} };
			},
		};
		const consumer = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false }, sessionSummary: { enabled: false } },
			baseToolsOverride: { read_artifact: readArtifact },
			responses: [{ toolCalls: [{ id: "read", name: "read_artifact", args: {} }] }, "Read complete"],
		});
		consumer.session.setActiveToolsByName(["read_artifact"]);
		let transcriptPath: string | undefined;
		try {
			const initial = await context.prompt("Report on the current task", { output, outputMode: "file-only" });
			transcriptPath = initial.match(/^Transcript saved to: (.+) \([^\n]+\)\./m)?.[1];
			assert.equal(await readText(output), REPORT);
			assert.equal((await context.navigateTree(oldLeaf, { summarize: false })).cancelled, false);
			assert.equal(producer.session.getLastAssistantText(), "HISTORY-ONLY unrelated branch answer");
			assert.equal(producer.faux.callCount, 1, "navigation did not produce a new answer");
			if (continueAfterNavigation) await context.__continuePrompt("Clarify the current report");
			const receipt = await context.__closeGeneration();
			assert.ok(receipt?.startsWith(`Output saved to: ${output} (`));
			await consumer.session.prompt(`Read the producer artifact. ${receipt}`);
			const expected = continueAfterNavigation ? `${REPORT}\n\n## Supplement 1\n\n${CLARIFICATION}` : REPORT;
			assert.equal(consumedArtifact, expected, "downstream must receive only newly generated answers");
			assert.equal(await readText(output), expected);
			assert.equal(producer.faux.callCount, continueAfterNavigation ? 2 : 1);
			assert.equal(consumer.faux.callCount, 2);
			assert.equal(await context.__closeGeneration(), receipt);
		} finally {
			await context.__dispose();
			producer.cleanup();
			consumer.cleanup();
			if (transcriptPath) removePathSync(transcriptPath, { force: true });
		}
	},
);
