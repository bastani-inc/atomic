import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { recordStageSessionCheckpoint } from "../../packages/workflows/src/durable/stage-primitive.js";
import { StageArtifactCapture } from "../../packages/workflows/src/runs/foreground/stage-runner-artifact-capture.js";
import { stageOutputInstruction } from "../../packages/workflows/src/runs/foreground/stage-runner-output.js";
import { finalAnswerTo } from "../../packages/workflows/src/runs/foreground/stage-runner-reopen.js";
import { RESUME_CONTINUATION_PROMPT } from "../../packages/workflows/src/shared/resume-continuation.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { createStore, run, workflow } from "./executor-shared.js";
import { makeMockSession, type StageSessionRuntime } from "./stage-runner-helpers.js";
import {
	endsOnCalls,
	type FakeSessionFields,
	makeResumedRig,
	names,
	REPLAY_KEY,
	type ResumedRigConfig,
	recordedResult,
	rejection,
} from "./waiting-stage-controller-rig.js";

useTemporaryAgentDir();

type Messages = StageSessionRuntime["messages"];
type Message = Messages[number];
type StopReason = Extract<Message, { readonly role: "assistant" }>["stopReason"];

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The text the stage's call sends; its stored turn opens with it. */
const PROMPT = "the stage prompt";

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

function answer(text: string, stopReason: StopReason = "stop"): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: USAGE,
		stopReason,
		timestamp: 0,
	};
}

/** An assistant message calling the tool `name` with id `id`, with `text` before the call. */
function calling(name: string, id: string, text = ""): Message {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id, name, arguments: {} },
		],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: USAGE,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function toolResult(id: string, name = "read"): Message {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [], isError: false, timestamp: 0 };
}

function custom(customType: string): Message {
	return { role: "custom", customType, content: "notice", display: true, timestamp: 0 };
}

/** The turn a stage's previous process finished: `prompt`, a tool call, its result and the model's final answer. */
function finishedTurn(text = "the finished answer", prompt = PROMPT): Messages {
	return [user(prompt), calling("read", "r1"), toolResult("r1"), answer(text)];
}

describe("the final answer to a call that a stored transcript ends on (#4375)", () => {
	test("is the last message when it stopped on its own, called no tool and closes the turn the call's text opened", () => {
		const messages = finishedTurn();
		assert.equal(finalAnswerTo(messages, PROMPT), messages.at(-1));
		const single = [user("go"), answer("done")];
		assert.equal(finalAnswerTo(single, "go"), single[1]);
	});

	test("reads the opening message's text parts, one per line, and leaves its images out", () => {
		const withImage: Message = {
			role: "user",
			content: [
				{ type: "text", text: PROMPT },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			timestamp: 0,
		};
		assert.notEqual(finalAnswerTo([withImage, answer("done")], PROMPT), undefined);
		const twoParts: Message = {
			role: "user",
			content: [
				{ type: "text", text: "first part" },
				{ type: "text", text: "second part" },
			],
			timestamp: 0,
		};
		assert.notEqual(finalAnswerTo([twoParts, answer("done")], "first part\nsecond part"), undefined);
	});

	test("is an answer with no text as well, which the call would have returned had the process not stopped", () => {
		const messages = [user("go"), answer("")];
		assert.equal(finalAnswerTo(messages, "go"), messages[1]);
	});

	test("is none for a turn another prompt opened, as in the conversation a forked stage inherited", () => {
		assert.equal(finalAnswerTo([user("source task"), answer("answered source task")], "forked task"), undefined);
		assert.equal(finalAnswerTo(finishedTurn(), `${PROMPT} `), undefined);
	});

	test("is none for a turn a steering message opened, whose text is not the call's", () => {
		const messages = [
			user(PROMPT),
			calling("read", "r1"),
			toolResult("r1"),
			user("also check the tests"),
			answer("done"),
		];
		assert.equal(finalAnswerTo(messages, PROMPT), undefined);
	});

	for (const stopReason of ["length", "error", "aborted", "toolUse", "pending", "deferred"] as const)
		test(`is none for an answer that ended with "${stopReason}"`, () => {
			assert.equal(finalAnswerTo([user("go"), answer("cut off", stopReason)], "go"), undefined);
		});

	test("is none for a transcript that ends on a call, its result, the prompt or nothing", () => {
		assert.equal(finalAnswerTo([], "go"), undefined);
		assert.equal(finalAnswerTo([user("go")], "go"), undefined);
		assert.equal(finalAnswerTo([user("go"), ...endsOnCalls("c1")], "go"), undefined);
		assert.equal(finalAnswerTo([user("go"), calling("read", "r1"), toolResult("r1")], "go"), undefined);
	});

	test("is none for a last message that stopped while it still calls a tool", () => {
		const stoppedOnCall = { ...calling("read", "r1", "and one more thing"), stopReason: "stop" } as Message;
		assert.equal(finalAnswerTo([user("go"), stoppedOnCall], "go"), undefined);
	});

	test("is none for an answer after which the transcript holds a notice", () => {
		assert.equal(finalAnswerTo([...finishedTurn(), custom("session-recovery-notice")], PROMPT), undefined);
	});

	test("is none for a turn a delivery opened, or one with no opening message left", () => {
		assert.equal(finalAnswerTo([user("go"), answer("first"), custom("intercom"), answer("second")], "go"), undefined);
		assert.equal(finalAnswerTo([answer("orphan")], "go"), undefined);
		assert.equal(finalAnswerTo([calling("read", "r1"), toolResult("r1"), answer("orphan")], "go"), undefined);
	});

	test("is none for a turn that asked the user, after which the stage still asks whether it may move on", () => {
		const asked = [
			user("go"),
			calling("ask_user_question", "q1"),
			toolResult("q1", "ask_user_question"),
			answer("ok"),
		];
		assert.equal(finalAnswerTo(asked, "go"), undefined);
		const earlierTurnAsked = [
			user("go"),
			calling("ask_user_question", "q1"),
			toolResult("q1", "ask_user_question"),
			answer("first"),
			user("next"),
			answer("second"),
		];
		assert.equal(finalAnswerTo(earlierTurnAsked, "next"), earlierTurnAsked.at(-1));
	});
});

describe("the output artifact capture of a stage finished from its transcript (#4375)", () => {
	test("takes the adopted answer as an answer of a generation that writes an artifact, and of no other", () => {
		const finished = answer("the finished answer");
		const writing = new StageArtifactCapture();
		writing.reset(true);
		writing.adoptAnswer(finished);
		assert.deepEqual(writing.messages(), [finished]);

		const plain = new StageArtifactCapture();
		plain.reset(false);
		plain.adoptAnswer(finished);
		assert.deepEqual(plain.messages(), []);
	});
});

/**
 * A stage resumed over a session whose stored transcript is `messages`, as after its process died. The scripted model
 * answers each prompt it gets with `answered <prompt>`, appended to the transcript.
 */
function resumedOver(messages: Messages, config: ResumedRigConfig = {}) {
	return makeResumedRig({
		...config,
		customize: (number, log, ci, manager): FakeSessionFields => ({
			messages,
			async prompt(text: string) {
				log.push(`prompt#${number}:${text}`);
				messages.push(user(text), answer(`answered ${text}`));
			},
			// The stage's result comes from the transcript, as an `AgentSession` reads its last answer.
			getLastAssistantText: undefined,
			...config.customize?.(number, log, ci, manager),
		}),
	});
}

const INSIDE_CALL: StageOptions = { resumeInsideCall: true };

describe("a durably resumed stage whose model answered its call before the stage recorded its completion (#4375)", () => {
	test("finishes the call from the transcript with that answer, sending the model nothing and counting no model attempt", async () => {
		const rig = await resumedOver(finishedTurn(), { stageOptions: INSIDE_CALL });

		assert.equal(await rig.ctx.prompt(PROMPT), "the finished answer");

		assert.equal(rig.created(), 1);
		assert.deepEqual(names(rig.log, "prompt#"), []);
		assert.equal(rig.ctx.getLastAssistantText(), "the finished answer");
		assert.equal(rig.ctx.__modelFallbackMeta().modelAttempts, undefined);
	});

	test("finishes a first complete() the same way", async () => {
		const rig = await resumedOver(finishedTurn(), { stageOptions: INSIDE_CALL });

		assert.equal(await rig.ctx.complete(PROMPT), "the finished answer");
		assert.deepEqual(names(rig.log, "prompt#"), []);
	});

	test("sends its next prompt as written, to the same session", async () => {
		const rig = await resumedOver(finishedTurn(), { stageOptions: INSIDE_CALL });

		await rig.ctx.prompt(PROMPT);
		await rig.ctx.prompt("a later prompt");

		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:a later prompt"]);
		assert.equal(rig.created(), 1);
	});

	test("writes its output artifact from that answer, the turn having opened with the call's text and its output instruction", async () => {
		const directory = mkdtempSync(join(tmpdir(), "resume-finished-turn-"));
		try {
			const sent = `${PROMPT}${stageOutputInstruction({ output: "report.md" })}`;
			const rig = await resumedOver(finishedTurn("the finished report", sent), {
				stageOptions: { ...INSIDE_CALL, cwd: directory },
			});

			await rig.ctx.prompt(PROMPT, { output: "report.md" });

			assert.equal(readFileSync(join(directory, "report.md"), "utf8"), "the finished report");
			assert.deepEqual(names(rig.log, "prompt#"), []);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("spends the results its previous process recorded, which the transcript has moved past", async () => {
		const rig = await resumedOver(finishedTurn(), {
			stageOptions: INSIDE_CALL,
			durableReplayKey: REPLAY_KEY,
			pendingTurn: false,
		});
		rig.dispatcher.keepResultsForResume(REPLAY_KEY, [recordedResult("r1", "already in the transcript")]);

		assert.equal(await rig.ctx.prompt(PROMPT), "the finished answer");

		assert.deepEqual(names(rig.log, "resultsInTranscript"), ["resultsInTranscript"]);
		assert.deepEqual(names(rig.log, "prompt#"), []);
	});

	test("rejects with the run's abort reason and sends the model nothing when the run was aborted, and a later resume still finishes the call", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		controller.abort(reason);
		const transcript = finishedTurn();
		const aborted = await resumedOver(transcript, { stageOptions: INSIDE_CALL, signal: controller.signal });

		assert.equal(await rejection(aborted.ctx.prompt(PROMPT)), reason);
		assert.deepEqual(names(aborted.log, "prompt#"), []);
		assert.deepEqual(transcript, finishedTurn());

		const resumedAgain = await resumedOver(transcript, { stageOptions: INSIDE_CALL });
		assert.equal(await resumedAgain.ctx.prompt(PROMPT), "the finished answer");
		assert.deepEqual(names(resumedAgain.log, "prompt#"), []);
	});
});

describe("a durably resumed stage that still prompts the model (#4375)", () => {
	test("a forked stage whose inherited conversation ends on another prompt's answer continues its turn, never returning that answer", async () => {
		const rig = await resumedOver([user("source task"), answer("answered source task")], {
			stageOptions: INSIDE_CALL,
		});

		const result = await rig.ctx.prompt("forked task");

		assert.deepEqual(names(rig.log, "prompt#"), [`prompt#1:${RESUME_CONTINUATION_PROMPT}`]);
		assert.equal(result, `answered ${RESUME_CONTINUATION_PROMPT}`);
	});

	test("a first complete() whose turn is not in the transcript sends its own text", async () => {
		const rig = await resumedOver([user("source task"), answer("answered source task")], {
			stageOptions: INSIDE_CALL,
		});

		assert.equal(await rig.ctx.complete("the stage question"), "answered the stage question");
		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:the stage question"]);
	});

	test("a stage not resumed inside a call sends its prompt as written, as a stage resumed between turns does", async () => {
		const rig = await resumedOver(finishedTurn(undefined, "report"));

		await rig.ctx.prompt("report");

		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:report"]);
	});

	test("a transcript that does not end on a final answer gets the continuation", async () => {
		const rig = await resumedOver([user(PROMPT), answer("cut off", "length")], { stageOptions: INSIDE_CALL });

		await rig.ctx.prompt(PROMPT);

		assert.deepEqual(names(rig.log, "prompt#"), [`prompt#1:${RESUME_CONTINUATION_PROMPT}`]);
	});

	test("a stage that writes an artifact gets the continuation with its output instruction", async () => {
		const directory = mkdtempSync(join(tmpdir(), "resume-finished-turn-"));
		try {
			const rig = await resumedOver([user("source task"), answer("answered source task")], {
				stageOptions: { ...INSIDE_CALL, cwd: directory },
			});

			await rig.ctx.prompt(PROMPT, { output: "report.md" });

			const continuation = `${RESUME_CONTINUATION_PROMPT}${stageOutputInstruction({ output: "report.md" })}`;
			assert.deepEqual(names(rig.log, "prompt#"), [`prompt#1:${continuation}`]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a turn still waiting on its detached calls continues from them instead", async () => {
		const rig = await resumedOver([user(PROMPT), ...endsOnCalls("c1")], {
			stageOptions: INSIDE_CALL,
			pendingTurn: true,
			redispatch: (ci) => [ci.call("c1", { settled: true })],
		});

		await rig.ctx.prompt(PROMPT);

		assert.deepEqual(
			names(rig.log, "resume#").map((entry) => entry.split(":")[1]),
			["c1"],
		);
		assert.deepEqual(names(rig.log, "prompt#"), []);
	});

	test("a schema-backed stage gets the continuation with its output instruction even after a final answer to its call, its structured result being one the transcript does not give back", async () => {
		const directory = mkdtempSync(join(tmpdir(), "resume-finished-turn-"));
		try {
			const instruction = stageOutputInstruction({ output: "verdict.md" }, true);
			const rig = await resumedOver(finishedTurn(undefined, `${PROMPT}${instruction}`), {
				stageOptions: { ...INSIDE_CALL, cwd: directory, schema: Type.Object({ verdict: Type.String() }) },
			});

			await rejection(rig.ctx.prompt(PROMPT, { output: "verdict.md" }));

			assert.equal(names(rig.log, "prompt#")[0], `prompt#1:${RESUME_CONTINUATION_PROMPT}${instruction}`);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("a durably resumed task (#4375)", () => {
	test("compares its transcript with the prompt it was started with, files it reads included, and finishes even though one is gone", async () => {
		const runId = "wf-resumed-task-reads";
		const backend = await JournalTestBackend.create();
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "resumed-task-reads",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		const sessionStore = new MemorySessionStore();
		const removed = join(tmpdir(), "resume-finished-turn-removed-artifact.md");
		const sent = `[Read from: ${removed}]\n\nsummarize the findings`;
		const prior = await SessionManager.create(sessionStore, process.cwd());
		await prior.appendMessage(user(sent) as never);
		await prior.appendMessage(answer("the summary") as never);
		await recordStageSessionCheckpoint(
			{
				workflowId: runId,
				backend,
				nextCheckpointId: () => "unused",
				nextReplayKey: () => "stage:task:reader:1",
			},
			{
				id: "reader-stage",
				name: "reader",
				status: "running",
				parentIds: [],
				startedAt: 1_000,
				toolEvents: [],
				replayKey: "stage:task:reader:1",
				sessionId: prior.getSessionId(),
			},
		);
		const prompts: string[] = [];
		const definition = workflow({
			name: "resumed-task-reads",
			description: "",
			inputs: {},
			outputs: { text: Type.String() },
			run: async (ctx) => {
				const result = await ctx.task("reader", { prompt: "summarize the findings", reads: [removed] });
				return { text: result.text };
			},
		});

		const result = await run(
			definition,
			{},
			{
				runId,
				store: createStore(),
				durableBackend: backend,
				adapters: {
					sessionStore,
					agentSession: {
						async create(options) {
							const manager = options.sessionManager as SessionManager;
							return makeMockSession({
								sessionId: manager.getSessionId(),
								messages: manager.buildSessionProjection().messages,
								async prompt(text: string) {
									prompts.push(text);
								},
								getLastAssistantText: undefined,
							}).session;
						},
					},
				},
			},
		);

		assert.equal(result.status, "completed", JSON.stringify(result.error));
		assert.deepEqual(result.result, { text: "the summary" });
		assert.deepEqual(prompts, []);
	});
});
