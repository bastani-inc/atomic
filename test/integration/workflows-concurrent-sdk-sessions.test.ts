import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import {
	type AgentSession,
	createAgentSession,
	type HostInputOptions,
	type QuestionnaireResult,
	type QuestionParams,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { sleep } from "../helpers/runtime.js";

/** Several real SDK host sessions, each loading the builtin workflows extension and a real stage AgentSession. */
const CONCURRENT_SDK_SESSIONS_TIMEOUT_MS = 90_000;
/** Bound on every session's workflow completing once all sessions started; a lost question fails here instead of hanging. */
const ROUTING_SETTLE_TIMEOUT_MS = 20_000;
/** "About a second apart", as in the issue report. */
const START_SPACING_MS = 1_000;
const SESSION_COUNT = 3;

const READINESS_QUESTION = "Are you ready to move on to the next stage?";
const READY_ANSWER = "I'm ready to move on to the next workflow stage.";

interface QuestionnaireCall {
	readonly params: QuestionParams;
	readonly identity: HostInputOptions;
	readonly atMs: number;
}

interface HostedSession {
	readonly label: string;
	readonly cwd: string;
	readonly params: QuestionParams;
	readonly calls: QuestionnaireCall[];
	/** Settles when the human behind this host answers the stage question. */
	answerStageQuestion: Promise<void>;
	session?: AgentSession;
	createdAtMs?: number;
	readyAtMs?: number;
	workflowStartedAtMs?: number;
}

interface WorkflowStatusRun {
	readonly runId: string;
	readonly status: string;
	readonly awaitingInputCount: number;
	readonly activeStages: readonly { readonly name: string; readonly status: string }[];
}

function hostedSession(label: string): HostedSession {
	const cwd = mkdtempSync(join(tmpdir(), `atomic-concurrent-sdk-${label}-`));
	mkdirSync(join(cwd, ".atomic", "workflows"), { recursive: true });
	mkdirSync(join(cwd, ".atomic", "extensions"), { recursive: true });
	writeFileSync(
		join(cwd, ".atomic", "extensions", "provider.ts"),
		readFileSync(new URL("./fixtures/sdk-host-questionnaire-provider.ts", import.meta.url), "utf8"),
	);
	const params: QuestionParams = {
		questions: [
			{
				question: `Which path should session ${label} take?`,
				header: label,
				options: [
					{ label: `${label} first`, description: `first option for ${label}` },
					{ label: `${label} second`, description: `second option for ${label}` },
				],
			},
		],
	};
	const stageOptions = {
		sessionDir: join(cwd, "stage-sessions"),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		model: "host-questionnaire-fixture/fixture",
		cwd,
		agentDir: join(cwd, "agent"),
		tools: ["ask_user_question"],
	};
	writeFileSync(
		join(cwd, ".atomic", "workflows", "ask-first.ts"),
		`
import { workflow } from "@bastani/atomic/workflows";
export default workflow({ name: "ask-first", description: "first stage asks the host", inputs: {}, outputs: {},
  run: async (ctx) => {
    await ctx.stage("asker", ${JSON.stringify(stageOptions)}).prompt(${JSON.stringify(`questionnaire ${JSON.stringify(params)}`)});
    return {};
  }
});`,
	);
	return { label, cwd, params, calls: [], answerStageQuestion: Promise.resolve() };
}

async function startHostedSession(hosted: HostedSession, originMs: number): Promise<void> {
	hosted.createdAtMs = Date.now() - originMs;
	const { session } = await createAgentSession({
		cwd: hosted.cwd,
		agentDir: join(hosted.cwd, "agent"),
		sessionManager: SessionManager.inMemory(hosted.cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		extensionBindings: {
			humanInput: {
				input: async () => undefined,
				confirm: async () => false,
				select: async () => undefined,
				editor: async () => undefined,
				questionnaire: async (questions, identity): Promise<QuestionnaireResult> => {
					hosted.calls.push({ params: questions, identity, atMs: Date.now() - originMs });
					const question = questions.questions[0]!;
					const readiness = question.question === READINESS_QUESTION;
					if (!readiness) await hosted.answerStageQuestion;
					return {
						cancelled: false,
						answers: [
							{
								questionIndex: 0,
								question: question.question,
								kind: "option",
								answer: readiness ? READY_ANSWER : question.options[0]!.label,
							},
						],
					};
				},
			},
		},
	});
	hosted.session = session;
	hosted.readyAtMs = Date.now() - originMs;
	await session.prompt("/workflow ask-first --no-picker");
	hosted.workflowStartedAtMs = Date.now() - originMs;
}

async function workflowRuns(session: AgentSession): Promise<WorkflowStatusRun[]> {
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow")!;
	const result = await tool.execute("status", { action: "status" }, new AbortController().signal);
	return (result.details as { runs: WorkflowStatusRun[] }).runs;
}

async function routingSummary(sessions: readonly HostedSession[]) {
	return await Promise.all(
		sessions.map(async (hosted) => {
			const run = hosted.session === undefined ? undefined : (await workflowRuns(hosted.session))[0];
			const own = (call: QuestionnaireCall, params: QuestionParams): boolean =>
				JSON.stringify(call.params) === JSON.stringify(params) && call.identity.workflowRunId === run?.runId;
			const readiness = hosted.calls.filter((call) => call.params.questions[0]?.question === READINESS_QUESTION);
			const stageQuestions = hosted.calls.filter((call) => !readiness.includes(call));
			return {
				label: hosted.label,
				ownStageQuestionCalls: stageQuestions.filter((call) => own(call, hosted.params)).length,
				foreignQuestionCalls: stageQuestions.filter((call) => !own(call, hosted.params)).length,
				ownReadinessCalls: readiness.filter((call) => call.identity.workflowRunId === run?.runId).length,
				runStatus: run?.status,
				awaitingInputCount: run?.awaitingInputCount,
				stagesAwaitingInput: run?.activeStages.filter((stage) => stage.status === "awaiting_input").length,
			};
		}),
	);
}

function timeline(sessions: readonly HostedSession[]): string {
	return sessions
		.map(
			(hosted) =>
				`${hosted.label}: createAgentSession +${hosted.createdAtMs}ms, ready +${hosted.readyAtMs}ms, workflow started +${hosted.workflowStartedAtMs}ms; questionnaire calls ${JSON.stringify(
					hosted.calls.map((call) => ({ at: `+${call.atMs}ms`, question: call.params.questions[0]?.question })),
				)}`,
		)
		.join("\n");
}

async function expectEachSessionAnsweredItsOwnStage(sessions: readonly HostedSession[]): Promise<void> {
	try {
		await vi.waitFor(
			async () => {
				for (const hosted of sessions) {
					assert.ok(hosted.session);
					assert.equal((await workflowRuns(hosted.session))[0]?.status, "completed");
				}
			},
			{ timeout: ROUTING_SETTLE_TIMEOUT_MS, interval: 100 },
		);
	} catch {
		// The per-session summary below names the session whose question was lost.
	}
	assert.deepEqual(
		await routingSummary(sessions),
		sessions.map((hosted) => ({
			label: hosted.label,
			ownStageQuestionCalls: 1,
			foreignQuestionCalls: 0,
			ownReadinessCalls: 1,
			runStatus: "completed",
			awaitingInputCount: 0,
			stagesAwaitingInput: 0,
		})),
		timeline(sessions),
	);
}

async function withHostedSessions(
	start: (sessions: readonly HostedSession[], originMs: number) => Promise<void>,
): Promise<void> {
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("NODE_TEST_CONTEXT", undefined);
	const sessions = Array.from({ length: SESSION_COUNT }, (_, index) => hostedSession(`S${index + 1}`));
	try {
		await start(sessions, Date.now());
		await expectEachSessionAnsweredItsOwnStage(sessions);
		console.log(timeline(sessions));
	} finally {
		await Promise.allSettled(sessions.map((hosted) => hosted.session?.dispose()));
		for (const hosted of sessions) rmSync(hosted.cwd, { recursive: true, force: true });
		vi.unstubAllEnvs();
	}
}

test(
	"SDK sessions created about a second apart each receive their own stage question (#3456)",
	async () => {
		await withHostedSessions(async (sessions, originMs) => {
			const started: Promise<void>[] = [];
			for (const [index, hosted] of sessions.entries()) {
				if (index > 0) await sleep(START_SPACING_MS);
				started.push(startHostedSession(hosted, originMs));
			}
			await Promise.all(started);
		});
	},
	CONCURRENT_SDK_SESSIONS_TIMEOUT_MS,
);

test(
	"SDK sessions created together each receive their own stage question (#3456)",
	async () => {
		await withHostedSessions(async (sessions, originMs) => {
			await Promise.all(sessions.map((hosted) => startHostedSession(hosted, originMs)));
		});
	},
	CONCURRENT_SDK_SESSIONS_TIMEOUT_MS,
);

test(
	"an SDK session answered after a sibling started a second later still receives its readiness question (#3456)",
	async () => {
		await withHostedSessions(async (sessions, originMs) => {
			const allStarted = Promise.withResolvers<void>();
			for (const hosted of sessions) hosted.answerStageQuestion = allStarted.promise;
			for (const [index, hosted] of sessions.entries()) {
				if (index > 0) await sleep(START_SPACING_MS);
				await startHostedSession(hosted, originMs);
				// The next sibling starts while this host's human is still answering its stage question.
				await vi
					.waitFor(() => assert.equal(hosted.calls.length, 1), { timeout: ROUTING_SETTLE_TIMEOUT_MS })
					.catch(() => undefined);
			}
			allStarted.resolve();
		});
	},
	CONCURRENT_SDK_SESSIONS_TIMEOUT_MS,
);
