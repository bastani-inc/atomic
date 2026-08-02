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
function assistantTextAndToolCallTurn(text: string, toolCallId = "t"): SessionMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: toolCallId, name: "t", arguments: {} },
		],
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
const SUBSTANTIVE_DELIVERABLE =
	"REAL DELIVERABLE: complete findings, supporting evidence, conclusions, and concrete next steps.";

type CandidateSizeRelationship = {
	readonly id: string;
	readonly stageOwnBytes: number;
	readonly postAdmissionBytes: number;
};

type NominationTexts = {
	readonly stageOwn: string;
	readonly postAdmission: string;
};

type NominationMatrixRow = {
	readonly id: string;
	readonly scenario: (provenance: AdmissionProvenance, texts: NominationTexts) => readonly SessionMessage[];
};

function exactSizedText(label: string, bytes: number): string {
	assert.ok(label.length <= bytes);
	return label.padEnd(bytes, ".");
}

const candidateSizeRelationships: readonly CandidateSizeRelationship[] = [
	{ id: "deliverable much larger than acknowledgement", stageOwnBytes: 96, postAdmissionBytes: 8 },
	{ id: "near parity", stageOwnBytes: 64, postAdmissionBytes: 63 },
	{ id: "acknowledgement much larger than deliverable", stageOwnBytes: 18, postAdmissionBytes: 155 },
];

const nominationMatrix: readonly NominationMatrixRow[] = [
	{
		id: "A1 [REAL, C, ACK]",
		scenario: (provenance, texts) => [
			assistantTurn(texts.stageOwn),
			admittedTurn("subagent:1", provenance),
			assistantTurn(texts.postAdmission),
		],
	},
	{
		id: "A2 [C, REAL, ACK]",
		scenario: (provenance, texts) => [
			admittedTurn("subagent:1", provenance),
			assistantTurn(texts.stageOwn),
			assistantTurn(texts.postAdmission),
		],
	},
	{
		id: "A3 [REAL, C, ACK+toolCall, toolResult, ACK2]",
		scenario: (provenance, texts) => [
			assistantTurn(texts.stageOwn),
			admittedTurn("subagent:1", provenance),
			assistantTextAndToolCallTurn(texts.postAdmission),
			toolResultTurn(),
			assistantTurn(texts.postAdmission),
		],
	},
	{
		id: "A4 [REAL, C1, ACK1, C2, ACK2]",
		scenario: (provenance, texts) => [
			assistantTurn(texts.stageOwn),
			admittedTurn("subagent:1", provenance),
			assistantTurn(texts.postAdmission),
			admittedTurn("subagent:2", provenance),
			assistantTurn(texts.postAdmission),
		],
	},
	{
		id: "B1 [INTRO, C, REAL]",
		scenario: (provenance, texts) => [
			assistantTurn(texts.stageOwn),
			admittedTurn("subagent:1", provenance),
			assistantTurn(texts.postAdmission),
		],
	},
	{
		id: "B2 [INTRO, toolResult, C, REAL]",
		scenario: (provenance, texts) => [
			assistantTurn(texts.stageOwn, "toolUse"),
			toolResultTurn(),
			admittedTurn("subagent:1", provenance),
			assistantTurn(texts.postAdmission),
		],
	},
	{
		id: "B3 [INTRO, C1, mid, C2, REAL]",
		scenario: (provenance, texts) => [
			assistantTurn(texts.stageOwn),
			admittedTurn("subagent:1", provenance),
			assistantTurn(texts.postAdmission),
			admittedTurn("subagent:2", provenance),
			assistantTurn(texts.postAdmission),
		],
	},
	{
		id: "B4 [INTRO, C, ACK, REAL]",
		scenario: (provenance, texts) => [
			assistantTurn(texts.stageOwn),
			admittedTurn("subagent:1", provenance),
			assistantTurn(texts.postAdmission),
			assistantTurn(texts.postAdmission),
		],
	},
	{
		id: "B5 [C, REAL]",
		scenario: (provenance, texts) => [admittedTurn("subagent:1", provenance), assistantTurn(texts.stageOwn)],
	},
	{
		id: "B6 [INTRO, C1, REPORT, C2, ACK]",
		scenario: (provenance, texts) => [
			assistantTurn(texts.stageOwn),
			admittedTurn("subagent:1", provenance),
			assistantTurn(texts.postAdmission),
			admittedTurn("subagent:2", provenance),
			assistantTurn(texts.postAdmission),
		],
	},
];

const reviewerRegressionCases = [
	{ id: "reviewer 518 B vs 430 B", before: exactSizedText("REAL", 518), after: exactSizedText("ACK", 430) },
	{ id: "reviewer 64 B vs 168 B", before: exactSizedText("REAL", 64), after: exactSizedText("ACK", 168) },
	{ id: "reviewer 18 B vs 155 B", before: exactSizedText("REAL", 18), after: exactSizedText("ACK", 155) },
	{
		id: "reviewer exact parity [REAL, C, ACK]",
		before: exactSizedText("REAL", 64),
		after: exactSizedText("ACK", 64),
	},
	{
		id: "reviewer exact parity [ACK, C, REAL]",
		before: exactSizedText("ACK", 64),
		after: exactSizedText("REAL", 64),
	},
] as const;

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

	for (const row of nominationMatrix) {
		for (const relationship of candidateSizeRelationships) {
			for (const provenance of ["active-stage", "assistant-settled"] as const) {
				test(`${row.id} with ${relationship.id} and ${provenance} provenance`, async () => {
					const texts = {
						stageOwn: exactSizedText("OWN", relationship.stageOwnBytes),
						postAdmission: exactSizedText("POST", relationship.postAdmissionBytes),
					};
					await assertNominationScenario(row.scenario(provenance, texts), texts.stageOwn);
				});
			}
		}
	}

	for (const row of reviewerRegressionCases) {
		for (const provenance of ["active-stage", "assistant-settled"] as const) {
			test(`${row.id} always nominates bytes before ${provenance} admission`, async () => {
				await assertNominationScenario(
					[assistantTurn(row.before), admittedTurn("subagent:reviewer", provenance), assistantTurn(row.after)],
					row.before,
				);
			});
		}
	}

	test("Z1 without an admission keeps origin/main's last-assistant behavior", async () => {
		await assertNominationScenario(
			[assistantTurn("first response"), assistantTurn("last response")],
			"last response",
		);
	});

	test("Z2 admission without provenance still uses the absolute admission boundary", async () => {
		await assertNominationScenario(
			[
				assistantTurn(SUBSTANTIVE_DELIVERABLE),
				admittedTurn("subagent:legacy"),
				assistantTurn("legacy acknowledgement"),
			],
			SUBSTANTIVE_DELIVERABLE,
		);
	});
	test("candidate size never overrides the pre-admission stage-own turn", async () => {
		await assertNominationScenario(
			[assistantTurn("123456"), admittedTurn("subagent:1", "active-stage"), assistantTurn("1234")],
			"123456",
		);
	});

	test("near-equal candidates always nominate the pre-admission stage-own turn", async () => {
		await assertNominationScenario(
			[assistantTurn("123456"), admittedTurn("subagent:1", "active-stage"), assistantTurn("12345")],
			"123456",
		);
	});

	test("near-equal candidates ignore assistant-settled provenance", async () => {
		await assertNominationScenario(
			[assistantTurn("123456"), admittedTurn("subagent:1", "assistant-settled"), assistantTurn("12345")],
			"123456",
		);
	});

	test("nominates a substantive deliverable before an active-stage admission acknowledgement", async () => {
		await assertNominationScenario(
			[
				assistantTurn("REAL DELIVERABLE WITH SUBSTANTIVE DETAIL"),
				admittedTurn("subagent:job-1", "active-stage"),
				assistantTurn("ACK"),
			],
			"REAL DELIVERABLE WITH SUBSTANTIVE DETAIL",
		);
	});

	test("persists the pre-admission introduction instead of a post-admission deliverable", async () => {
		await assertNominationScenario(
			[
				assistantTurn("INTRO"),
				admittedTurn("subagent:job-1", "assistant-settled"),
				assistantTurn("REAL DELIVERABLE WITH SUBSTANTIVE DETAIL"),
			],
			"INTRO",
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
