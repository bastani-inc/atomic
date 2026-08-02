import { mkdir } from "node:fs/promises";
import { describe, test } from "vitest";
import { lastAssistantTextFromSession } from "../../packages/workflows/src/runs/foreground/stage-runner-messages.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifacts.js";
import type {
	AgentSession,
	AgentSessionAdapter,
	InternalStageContext,
	PromptAdapter,
	StageExecutionMeta,
} from "./stage-runner-helpers.js";
import {
	assert,
	createStageContext,
	join,
	makeMockSession,
	makeOpts,
	makeSignal,
	mkdtemp,
	readFile,
	rm,
	tmpdir,
	writeFile,
} from "./stage-runner-helpers.js";

type SessionMessage = AgentSession["messages"][number];

function assistantTurn(text: string, stopReason = "stop"): SessionMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		timestamp: Date.now(),
	} as SessionMessage;
}
function assistantToolCallTurn(toolCallId = "t"): SessionMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "t", arguments: {} }],
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as SessionMessage;
}

type AdmissionProvenance = "active-stage" | "assistant-settled";

function latestAssistantText(messages: AgentSession["messages"]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("")
			.trim();
		if (text) return text;
	}
	return undefined;
}

function admittedTurn(
	stageAdmissionKey = "subagent:job-1",
	stageAdmissionProvenance?: AdmissionProvenance,
): SessionMessage {
	return {
		role: "custom",
		customType: "subagent-notify",
		stageAdmissionKey,
		...(stageAdmissionProvenance === undefined ? {} : { stageAdmissionProvenance }),
		content: "async result details",
		display: true,
		timestamp: Date.now(),
	} as SessionMessage;
}

function toolResultTurn(toolCallId = "t"): SessionMessage {
	return { role: "toolResult", toolCallId, toolName: "t", content: [], isError: false, timestamp: Date.now() };
}

async function assertNominationScenario(scenario: readonly SessionMessage[], expected: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflows-stage-nomination-"));
	let transcriptPath: string | undefined;
	try {
		const output = join(dir, "deliverable.md");
		const messages = [assistantTurn("PREVIOUS PROMPT")] as AgentSession["messages"];
		const { session } = makeMockSession({
			messages,
			getLastAssistantText: () => latestAssistantText(messages),
			async prompt() {
				messages.push(...scenario);
			},
		});
		const ctx = createStageContext(makeOpts({ adapters: { agentSession: { create: async () => session } } }));
		const result = await ctx.prompt("go", { output, outputMode: "file-only" });
		assert.equal(await readFile(output, "utf8"), expected);
		const directMessages = [assistantTurn("PREVIOUS PROMPT"), ...scenario] as AgentSession["messages"];
		const { session: directSession } = makeMockSession({
			messages: directMessages,
			getLastAssistantText: () => latestAssistantText(directMessages),
		});
		assert.equal(lastAssistantTextFromSession(directSession, "fallback", new Set<string>(), 1), expected);
		const transcriptMatch = result.match(/Transcript saved to: ([^ ]+) \(/);
		assert.ok(transcriptMatch?.[1]);
		transcriptPath = transcriptMatch[1];
		return await readFile(transcriptPath, "utf8");
	} finally {
		await rm(dir, { recursive: true, force: true });
		if (transcriptPath) await rm(transcriptPath, { force: true });
	}
}

describe("createStageContext — prompt metadata propagation", () => {
	test("prompt adapter receives runId from opts", async () => {
		const received: StageExecutionMeta[] = [];
		const promptAdapter: PromptAdapter = {
			async prompt(_text, meta) {
				received.push(meta!);
				return "ok";
			},
		};
		const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter }, runId: "run-001" }));
		await ctx.prompt("hello");
		assert.equal(received[0]?.runId, "run-001");
	});
	test("legacy sessions without admission identity keep the previous last-message behavior", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "legacy deliverable" }] },
			{ role: "custom", customType: "subagent-notify", content: "legacy notification", display: true },
			{ role: "assistant", content: [{ type: "text", text: "legacy acknowledgement" }] },
		] as AgentSession["messages"];
		const { session } = makeMockSession({
			messages,
			getLastAssistantText: () => "legacy acknowledgement",
		});
		assert.equal(lastAssistantTextFromSession(session, "fallback", new Set<string>(), 0), "legacy acknowledgement");
	});

	test("prompt adapter receives stageId from opts", async () => {
		const received: StageExecutionMeta[] = [];
		const promptAdapter: PromptAdapter = {
			async prompt(_text, meta) {
				received.push(meta!);
				return "ok";
			},
		};
		const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter }, stageId: "s-99" }));
		await ctx.prompt("hi");
		assert.equal(received[0]?.stageId, "s-99");
	});

	test("prompt adapter receives stageName from opts", async () => {
		const received: StageExecutionMeta[] = [];
		const promptAdapter: PromptAdapter = {
			async prompt(_text, meta) {
				received.push(meta!);
				return "ok";
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { prompt: promptAdapter },
				stageName: "Analysis",
			}),
		);
		await ctx.prompt("analyze");
		assert.equal(received[0]?.stageName, "Analysis");
	});

	test("prompt adapter receives signal from opts", async () => {
		const received: StageExecutionMeta[] = [];
		const signal = makeSignal();
		const promptAdapter: PromptAdapter = {
			async prompt(_text, meta) {
				received.push(meta!);
				return "ok";
			},
		};
		const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter }, signal }));
		await ctx.prompt("go");
		assert.equal(received[0]?.signal, signal);
	});

	test("prompt adapter receives full meta object in one call", async () => {
		const received: StageExecutionMeta[] = [];
		const signal = makeSignal();
		const promptAdapter: PromptAdapter = {
			async prompt(_text, meta) {
				received.push(meta!);
				return "done";
			},
		};
		const ctx = createStageContext({
			stageId: "s-42",
			stageName: "Summarise",
			runId: "r-100",
			signal,
			adapters: { prompt: promptAdapter },
		});
		await ctx.prompt("summarise this");
		assert.deepEqual(received[0], {
			runId: "r-100",
			stageId: "s-42",
			stageName: "Summarise",
			signal,
			stageOptions: undefined,
			executionMode: undefined,
		});
	});

	test("prompt adapter receives workflow intercom group when provided", async () => {
		const received: StageExecutionMeta[] = [];
		const promptAdapter: PromptAdapter = {
			async prompt(_text, meta) {
				received.push(meta!);
				return "done";
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { prompt: promptAdapter },
				workflowIntercomGroup: "workflow-run-r-100",
			}),
		);

		await ctx.prompt("summarise this");

		assert.equal(received[0]?.workflowIntercomGroup, "workflow-run-r-100");
	});

	test("prompt adapter receives the text passed to ctx.prompt", async () => {
		const texts: string[] = [];
		const promptAdapter: PromptAdapter = {
			async prompt(text) {
				texts.push(text);
				return "ack";
			},
		};
		const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));
		await ctx.prompt("specific text payload");
		assert.deepEqual(texts, ["specific text payload"]);
	});

	test("signal is undefined in meta when opts.signal absent", async () => {
		const received: StageExecutionMeta[] = [];
		const promptAdapter: PromptAdapter = {
			async prompt(_text, meta) {
				received.push(meta!);
				return "ok";
			},
		};
		const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));
		await ctx.prompt("go");
		assert.equal(received[0]?.signal, undefined);
	});

	test("prompt adapter receives executionMode from opts", async () => {
		const received: StageExecutionMeta[] = [];
		const promptAdapter: PromptAdapter = {
			async prompt(_text, meta) {
				received.push(meta!);
				return "ok";
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { prompt: promptAdapter },
				executionMode: "non_interactive",
			}),
		);
		await ctx.prompt("go");
		assert.equal(received[0]?.executionMode, "non_interactive");
	});

	test("prompt outputMode=file-only writes full output, transcript, and both receipt paths", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-stage-output-"));
		let transcriptPath: string | undefined;
		try {
			const output = join(dir, "answer.md");
			const promptAdapter: PromptAdapter = {
				async prompt() {
					return "line one\nline two";
				},
			};
			const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));

			const result = await ctx.prompt("go", {
				output,
				outputMode: "file-only",
			});

			assert.match(result, /^Output saved to: /);
			assert.match(result, /answer\.md/);
			const transcriptMatch = result.match(/Transcript saved to: ([^ ]+) \(/);
			assert.ok(transcriptMatch?.[1]);
			transcriptPath = transcriptMatch[1];
			assert.equal(transcriptPath.startsWith(dir), false);
			assert.match(result, /Search it with rg, read narrow line ranges, and do not read it whole\./);
			assert.equal(await readFile(output, "utf8"), "line one\nline two");
			const transcript = await readFile(transcriptPath, "utf8");
			assert.match(transcript, /## 1 assistant/);
			assert.match(transcript, /line one/);
			assert.match(transcript, /line two/);
		} finally {
			await rm(dir, { recursive: true, force: true });
			if (transcriptPath) await rm(transcriptPath, { force: true });
		}
	});

	test("transcript failure preserves a compact file-only receipt and the primary artifact", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-stage-transcript-failure-"));
		const artifactRoot = await mkdtemp(join(tmpdir(), "pi-workflows-stage-transcript-root-"));
		const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		const output = join(dir, "answer.md");
		const blockedRunDirectory = join(artifactRoot, "runs", "transcript-failure-run");
		try {
			await mkdir(join(artifactRoot, "runs"), { recursive: true });
			await writeFile(blockedRunDirectory, "not a directory", "utf8");
			process.env[ENV_WORKFLOW_ARTIFACT_DIR] = artifactRoot;
			const ctx = createStageContext(
				makeOpts({
					runId: "transcript-failure-run",
					adapters: {
						prompt: {
							async prompt() {
								return "PRIMARY OUTPUT";
							},
						},
					},
				}),
			);
			const result = await ctx.prompt("go", { output, outputMode: "file-only" });

			assert.match(result, /^Output saved to: /);
			assert.match(result, /Transcript unavailable at: /);
			assert.match(result, /WARNING: companion transcript unavailable at .*transcript-failure-run/);
			assert.doesNotMatch(result, /PRIMARY OUTPUT/);
			assert.doesNotMatch(result, /Output file error:/);
			assert.equal(await readFile(output, "utf8"), "PRIMARY OUTPUT");
		} finally {
			if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
			else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
			await rm(dir, { recursive: true, force: true });
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});
	test("durable transcript survives simulated resume after the output worktree is removed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-stage-resume-"));
		let transcriptPath: string | undefined;
		try {
			const output = join(dir, "resume.md");
			const ctx = createStageContext(
				makeOpts({
					runId: "resume-transcript-run",
					adapters: {
						prompt: {
							async prompt() {
								return "durable stage work";
							},
						},
					},
				}),
			);
			const receipt = await ctx.prompt("go", { output, outputMode: "file-only" });
			const transcriptMatch = receipt.match(/Transcript saved to: ([^ ]+) \(/);
			assert.ok(transcriptMatch?.[1]);
			transcriptPath = transcriptMatch[1];
			await rm(dir, { recursive: true, force: true });
			assert.match(await readFile(transcriptPath, "utf8"), /durable stage work/);
		} finally {
			await rm(dir, { recursive: true, force: true });
			if (transcriptPath) await rm(transcriptPath, { force: true });
		}
	});

	test("prompt outputMode=inline names the artifact and transcript while returning inline text", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-stage-inline-"));
		let transcriptPath: string | undefined;
		try {
			const output = join(dir, "inline.md");
			const ctx = createStageContext(
				makeOpts({
					adapters: {
						prompt: {
							async prompt() {
								return "inline result";
							},
						},
					},
				}),
			);
			const result = await ctx.prompt("go", { output, outputMode: "inline" });
			assert.match(result, /^inline result\n\nOutput saved to: /);
			const transcriptMatch = result.match(/Transcript saved to: ([^ ]+) \(/);
			assert.ok(transcriptMatch?.[1]);
			transcriptPath = transcriptMatch[1];
			assert.match(await readFile(transcriptPath, "utf8"), /inline result/);
		} finally {
			await rm(dir, { recursive: true, force: true });
			if (transcriptPath) await rm(transcriptPath, { force: true });
		}
	});

	test("S1 nominates a deliverable completed directly after an active-stage admission", async () => {
		await assertNominationScenario(
			[assistantTurn("INTRO"), admittedTurn("subagent:job-1", "active-stage"), assistantTurn("REAL DELIVERABLE")],
			"REAL DELIVERABLE",
		);
	});

	test("S2 nominates a deliverable after tool output and an active-stage admission", async () => {
		await assertNominationScenario(
			[
				assistantTurn("INTRO", "toolUse"),
				toolResultTurn(),
				admittedTurn("subagent:job-1", "active-stage"),
				assistantTurn("REAL DELIVERABLE"),
			],
			"REAL DELIVERABLE",
		);
	});

	test("S3 nominates the final work after two active-stage admissions", async () => {
		await assertNominationScenario(
			[
				assistantTurn("INTRO"),
				admittedTurn("subagent:job-1", "active-stage"),
				assistantTurn("mid"),
				admittedTurn("subagent:job-2", "active-stage"),
				assistantTurn("REAL DELIVERABLE"),
			],
			"REAL DELIVERABLE",
		);
	});

	test("S4/N2 nominates work completed after an active-stage admission acknowledgement", async () => {
		await assertNominationScenario(
			[
				assistantTurn("INTRO"),
				admittedTurn("subagent:job-1", "active-stage"),
				assistantTurn("ACK"),
				assistantTurn("REAL DELIVERABLE"),
			],
			"REAL DELIVERABLE",
		);
	});

	test("S5/N4 nominates work after an active-stage acknowledgement and tool result", async () => {
		await assertNominationScenario(
			[
				assistantTurn("INTRO"),
				admittedTurn("subagent:job-1", "active-stage"),
				assistantTurn("ACK", "toolUse"),
				toolResultTurn(),
				assistantTurn("REAL DELIVERABLE"),
			],
			"REAL DELIVERABLE",
		);
	});

	test("S6/N7 nominates the first assistant response when admission precedes all assistant work", async () => {
		await assertNominationScenario(
			[admittedTurn("subagent:job-1", "active-stage"), assistantTurn("REAL DELIVERABLE")],
			"REAL DELIVERABLE",
		);
	});

	test("S7/N3 nominates the report before a settled-assistant admission acknowledgement", async () => {
		await assertNominationScenario(
			[
				assistantTurn("INTRO"),
				admittedTurn("subagent:job-1", "active-stage"),
				assistantTurn("REPORT"),
				admittedTurn("subagent:job-2", "assistant-settled"),
				assistantTurn("ACK"),
			],
			"REPORT",
		);
	});

	test("S8/N6 uses the last assistant response when there is no admission", async () => {
		await assertNominationScenario([assistantTurn("A"), assistantTurn("B")], "B");
	});

	test("S9 excludes the response to one settled-assistant admission", async () => {
		const transcript = await assertNominationScenario(
			[assistantTurn("REAL DELIVERABLE"), admittedTurn("subagent:job-1", "assistant-settled"), assistantTurn("ACK")],
			"REAL DELIVERABLE",
		);
		assert.match(transcript, /subagent-notify/);
		assert.match(transcript, /async result details/);
		assert.match(transcript, /ACK/);
	});

	test("S10 excludes acknowledgements to two settled-assistant admissions", async () => {
		await assertNominationScenario(
			[
				assistantTurn("REAL DELIVERABLE"),
				admittedTurn("subagent:job-1", "assistant-settled"),
				assistantTurn("ACK1"),
				admittedTurn("subagent:job-2", "assistant-settled"),
				assistantTurn("ACK2"),
			],
			"REAL DELIVERABLE",
		);
	});

	test("S11 excludes a multi-turn response to a settled-assistant admission", async () => {
		await assertNominationScenario(
			[
				assistantTurn("REAL DELIVERABLE"),
				admittedTurn("subagent:job-1", "assistant-settled"),
				assistantTurn("ACK1", "toolUse"),
				toolResultTurn(),
				assistantTurn("ACK2"),
			],
			"REAL DELIVERABLE",
		);
	});

	test("S12 excludes a tool-calling response to a settled-assistant admission", async () => {
		await assertNominationScenario(
			[
				assistantTurn("REAL DELIVERABLE"),
				admittedTurn("subagent:job-1", "assistant-settled"),
				assistantToolCallTurn(),
				toolResultTurn(),
				assistantTurn("ACK"),
			],
			"REAL DELIVERABLE",
		);
	});

	test("S13 excludes all three admitted acknowledgement turns", async () => {
		await assertNominationScenario(
			[
				assistantTurn("REAL DELIVERABLE"),
				admittedTurn("subagent:job-1", "assistant-settled"),
				assistantTurn("ACK1"),
				admittedTurn("subagent:job-2", "assistant-settled"),
				assistantTurn("ACK2"),
				admittedTurn("subagent:job-3", "assistant-settled"),
				assistantTurn("ACK3"),
			],
			"REAL DELIVERABLE",
		);
	});

	test("N5 legacy external turns keep the previous end-to-end last-message behavior", async () => {
		await assertNominationScenario(
			[
				assistantTurn("REAL DELIVERABLE"),
				{ role: "custom", customType: "subagent-notify", content: "legacy notification" } as SessionMessage,
				assistantTurn("legacy acknowledgement"),
			],
			"legacy acknowledgement",
		);
	});

	test("N8 admitted legacy messages without provenance preserve origin/main latest-assistant behavior", async () => {
		await assertNominationScenario(
			[assistantTurn("INTRO"), admittedTurn("subagent:legacy"), assistantTurn("REAL DELIVERABLE")],
			"REAL DELIVERABLE",
		);
	});

	test("warns for empty and self-pointer artifacts but accepts short real output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-stage-degenerate-"));
		const transcriptPaths: string[] = [];
		try {
			const cases = [
				{ name: "empty.md", output: "", warning: /artifact is empty/ },
				{
					name: "pointer.md",
					output: "research complete, saved to PLACEHOLDER",
					warning: /only points to its own output path/,
				},
				{ name: "short.md", output: "short.md: OK", warning: undefined },
			] as const;
			for (const item of cases) {
				const output = join(dir, item.name);
				const resultText = item.name === "pointer.md" ? `research complete, saved to ${output}` : item.output;
				const ctx = createStageContext(
					makeOpts({
						adapters: {
							prompt: {
								async prompt() {
									return resultText;
								},
							},
						},
					}),
				);
				const result = await ctx.prompt("go", { output, outputMode: "file-only" });
				if (item.warning) assert.match(result, item.warning);
				else assert.doesNotMatch(result, /WARNING:/);
				const transcriptMatch = result.match(/Transcript saved to: ([^ ]+) \(/);
				assert.ok(transcriptMatch?.[1]);
				transcriptPaths.push(transcriptMatch[1]);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
			for (const path of transcriptPaths) await rm(path, { force: true });
		}
	});

	test("prompt outputMode=file-only requires an output path", async () => {
		const promptAdapter: PromptAdapter = {
			async prompt() {
				return "ok";
			},
		};
		const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));
		await assert.rejects(ctx.prompt("go", { outputMode: "file-only" }), /outputMode: "file-only".*output file/);
	});

	test("prompt maxOutput truncates inline output", async () => {
		const promptAdapter: PromptAdapter = {
			async prompt() {
				return "first line\nsecond line";
			},
		};
		const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));

		const result = await ctx.prompt("go", { maxOutput: { lines: 1 } });

		assert.equal(result, "first line\n\n[workflow output truncated; limits: 204800 bytes, 1 lines]");
	});

	test("prompt strips workflow output options before delegating to the SDK session", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-session-dir-"));
		try {
			const receivedOptions: Array<Record<string, unknown> | undefined> = [];
			const { session } = makeMockSession({
				async prompt(_text, options) {
					receivedOptions.push(options as Record<string, unknown> | undefined);
				},
				getLastAssistantText() {
					return "ok";
				},
			});
			const agentSession: AgentSessionAdapter = {
				async create() {
					return session;
				},
			};
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession },
					stageOptions: {
						cwd: dir,
						sessionDir: dir,
						context: "fork",
					},
				}),
			) as InternalStageContext;

			const result = await ctx.prompt("go", {
				output: false,
				maxOutput: { bytes: 10 },
				cwd: "/ignored-for-session",
				context: "fresh",
				sessionDir: "/ignored-sessions",
				expandPromptTemplates: false,
			});

			assert.equal(result, "ok");
			assert.deepEqual(receivedOptions[0], {
				expandPromptTemplates: false,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
