import { testRunId } from "../helpers/run-id.js";
/**
 * Regression coverage for issue #2009's terminal workflow-send boundary.
 *
 * Programmatic sends fail before retained-session revival or delivery. The
 * separate post-mortem resolver and `/workflow attach` tests retain explicit
 * user-driven terminal chat coverage.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import type { PostMortemStageChatDeps } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { stageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

let tempDir = "";
const RUN_ID = testRunId("postmortem-send-run");
const CHILD_RUN_ID = testRunId("postmortem-send-child");
const TERMINAL_ROOT_STATUSES = ["completed", "failed", "skipped", "cancelled", "killed", "blocked"] as const;

interface RevivalCounter {
	creates: number;
	resolves: number;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "atomic-send-postmortem-"));
});
afterEach(() => {
	stageControlRegistry.clear();
	rmSync(tempDir, { recursive: true, force: true });
	store.removeRun(CHILD_RUN_ID);
	store.removeRun(RUN_ID);
});

function retainedSession(name: string): string {
	const path = join(tempDir, `${name}.jsonl`);
	writeFileSync(
		path,
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: `${name}-session`,
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			}),
			JSON.stringify({
				type: "message",
				id: `${name}-msg`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Original request" },
			}),
		].join("\n")}\n`,
	);
	return path;
}

function seedTerminalRun(sessionFile: string | undefined, status: "completed" | "failed" = "completed"): void {
	store.recordRunStart({ id: RUN_ID, name: "send-flow", inputs: {}, status, stages: [], startedAt: 1 });
	store.recordStageStart(RUN_ID, {
		id: "stage-a",
		name: "final",
		status: "completed",
		parentIds: [],
		toolEvents: [],
		result: "done",
		attachable: false,
		...(sessionFile !== undefined ? { sessionFile } : {}),
	});
}

function resolvePostMortemDeps(
	session: StageSessionRuntime,
	counter: RevivalCounter,
): (runId: string) => PostMortemStageChatDeps {
	const adapters: StageAdapters = {
		agentSession: {
			async create() {
				counter.creates += 1;
				return session;
			},
		},
	};
	return () => {
		counter.resolves += 1;
		return { registry: createStageControlRegistry(), adapters, cwd: tempDir };
	};
}
function runExecutionSnapshot(): object {
	const run = store.runs().find((candidate) => candidate.id === RUN_ID);
	assert.ok(run);
	return structuredClone(run);
}

function assertTerminalFailure(
	result: Awaited<ReturnType<typeof workflowSendAction>>,
	workflowStatus: (typeof TERMINAL_ROOT_STATUSES)[number] = "completed",
): void {
	assert.equal(result.status, "failed");
	if (result.status !== "failed") return;
	assert.equal(result.code, "WORKFLOW_TERMINAL");
	assert.equal(result.workflowStatus, workflowStatus);
	assert.equal(result.delivery, "rejected");
	assert.equal(result.error, result.message);
	assert.match(result.message, new RegExp(RUN_ID));
	assert.match(result.message, new RegExp(`status ${workflowStatus}`));
	assert.match(result.message, /start a new workflow/);
	assert.match(result.message, /small, deterministic, and low risk/);
	assert.doesNotMatch(result.message, /\bok\b|accepted|running|Prompt started|queued|sent|steered|resumed|answered/i);
}

describe("workflow send — terminal root rejection", () => {
	for (const workflowStatus of TERMINAL_ROOT_STATUSES) {
		test(`rejects ${workflowStatus} roots before resolving a nested stage target`, async () => {
			store.recordRunStart({
				id: RUN_ID,
				name: "terminal-root",
				inputs: {},
				status: workflowStatus,
				stages: [],
				startedAt: 1,
			});
			let resolverCalls = 0;
			const before = store.snapshot();

			const result = await workflowSendAction(
				{ runId: RUN_ID, stageId: "missing-child:missing-stage", text: "must not route" },
				{
					resolvePostMortemDeps: () => {
						resolverCalls += 1;
						throw new Error("terminal roots must not probe retained sessions");
					},
				},
			);

			assertTerminalFailure(result, workflowStatus);
			assert.equal(result.runId, RUN_ID);
			assert.equal(result.stageId, "missing-child:missing-stage");
			assert.equal(resolverCalls, 0);
			assert.equal(stageControlRegistry.get(RUN_ID, "missing-child:missing-stage"), undefined);
			assert.deepEqual(store.snapshot(), before);
		});
	}

	test("uses the authoritative root for direct and expanded nested targets", async () => {
		store.recordRunStart({
			id: RUN_ID,
			name: "terminal-root",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [
				{
					id: "child-boundary",
					name: "workflow:child",
					status: "completed",
					parentIds: [],
					toolEvents: [],
					attachable: false,
					workflowChildRun: { alias: "child", workflow: "child", runId: CHILD_RUN_ID },
				},
			],
		});
		store.recordRunStart({
			id: CHILD_RUN_ID,
			name: "child",
			inputs: {},
			status: "completed",
			startedAt: 1,
			parentRunId: RUN_ID,
			parentStageId: "child-boundary",
			rootRunId: RUN_ID,
			stages: [
				{
					id: "child-stage",
					name: "child stage",
					status: "completed",
					parentIds: [],
					toolEvents: [],
					attachable: true,
				},
			],
		});
		const calls: string[] = [];
		stageControlRegistry.register({
			runId: CHILD_RUN_ID,
			stageId: "child-stage",
			stageName: "child stage",
			status: "completed",
			sessionId: "child-session",
			sessionFile: undefined,
			isStreaming: false,
			messages: [],
			async ensureAttached() {
				calls.push("attach");
			},
			async sendUserMessage(_text, _options, beforeDelivery) {
				beforeDelivery?.();
				calls.push("prompt");
				return "prompt";
			},
			async prompt() {
				calls.push("prompt");
			},
			async steer() {
				calls.push("steer");
			},
			async followUp() {
				calls.push("followUp");
			},
			async pause() {
				calls.push("pause");
			},
			async resume() {
				calls.push("resume");
			},
			subscribe() {
				return () => {};
			},
		});
		const liveChildResult = await workflowSendAction({
			runId: CHILD_RUN_ID,
			stageId: "child-stage",
			text: "allowed while root remains live",
		});
		assert.equal(liveChildResult.status, "ok");
		assert.equal(liveChildResult.runId, CHILD_RUN_ID);
		assert.deepEqual(calls, ["prompt"]);
		store.recordRunEnd(RUN_ID, "failed");
		const before = store.snapshot();

		const result = await workflowSendAction({
			runId: RUN_ID,
			stageId: `${CHILD_RUN_ID}:child-stage`,
			text: "must not reach child",
		});

		assertTerminalFailure(result, "failed");
		assert.equal(result.runId, RUN_ID);
		assert.equal(result.stageId, `${CHILD_RUN_ID}:child-stage`);
		const directChildResult = await workflowSendAction({
			runId: CHILD_RUN_ID,
			stageId: "child-stage",
			text: "must not bypass terminal root",
		});
		assertTerminalFailure(directChildResult, "failed");
		assert.equal(directChildResult.runId, RUN_ID);
		assert.equal(directChildResult.stageId, "child-stage");
		assert.deepEqual(calls, ["prompt"]);
		assert.deepEqual(store.snapshot(), before);
	});

	for (const workflowStatus of ["completed", "failed"] as const) {
		test(`rejects a ${workflowStatus} root before reviving its retained stage session`, async () => {
			const sessionFile = retainedSession(`send-terminal-${workflowStatus}`);
			seedTerminalRun(sessionFile, workflowStatus);
			const prompts: string[] = [];
			const counter: RevivalCounter = { creates: 0, resolves: 0 };
			const sideEffectPath = join(tempDir, "model-tool-side-effect.txt");
			const session: StageSessionRuntime = {
				...mockSession(),
				sessionFile,
				async prompt(text: string) {
					prompts.push(text);
					writeFileSync(sideEffectPath, "unexpected model/tool work");
				},
			};
			const transcriptBefore = readFileSync(sessionFile);
			const before = store.snapshot();

			const result = await workflowSendAction(
				{ runId: RUN_ID, stageId: "stage-a", text: "any regressions?" },
				{ resolvePostMortemDeps: resolvePostMortemDeps(session, counter) },
			);

			assertTerminalFailure(result, workflowStatus);
			assert.deepEqual(prompts, []);
			assert.equal(counter.resolves, 0);
			assert.equal(counter.creates, 0);
			assert.equal(existsSync(sideEffectPath), false);
			assert.deepEqual(readFileSync(sessionFile), transcriptBefore);
			assert.equal(stageControlRegistry.get(RUN_ID, "stage-a"), undefined);
			assert.deepEqual(store.snapshot(), before);
		});
	}

	test("does not inspect or answer a stale brokered prompt on a terminal root", async () => {
		seedTerminalRun(undefined);
		const controller = new AbortController();
		let answerBuilds = 0;
		stageUiBroker.provideStagePrompt(RUN_ID, "stage-a", {
			prompt: {
				id: "stale-input",
				kind: "ask_user_question",
				questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }],
				createdAt: 1,
			},
			buildResult() {
				answerBuilds += 1;
				return { answers: [], cancelled: false };
			},
		});
		const pending = stageUiBroker
			.requestCustomUi(
				RUN_ID,
				"stage-a",
				() => ({ render: () => [], invalidate: () => {} }),
				undefined,
				controller.signal,
			)
			.catch(() => undefined);
		assert.equal(stageUiBroker.peekStagePrompt(RUN_ID, "stage-a")?.id, "stale-input");
		const before = store.snapshot();

		const result = await workflowSendAction({
			runId: RUN_ID,
			stageId: "stage-a",
			promptId: "stale-input",
			response: "Yes",
			delivery: "answer",
		});

		assertTerminalFailure(result);
		assert.equal(answerBuilds, 0);
		assert.equal(stageUiBroker.peekStagePrompt(RUN_ID, "stage-a")?.id, "stale-input");
		assert.deepEqual(store.snapshot(), before);
		controller.abort(new Error("test cleanup"));
		await pending;
	});

	test("leaves a native pending prompt and private answer ledger untouched", async () => {
		store.recordRunStart({
			id: RUN_ID,
			name: "terminal-native-prompt",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		store.recordStageStart(RUN_ID, {
			id: "stage-a",
			name: "ask",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		const priorPrompt = { id: "prior-input", kind: "input" as const, message: "Prior?", createdAt: 1 };
		const pendingPrompt = { id: "native-input", kind: "input" as const, message: "Value?", createdAt: 2 };
		assert.equal(store.recordStagePromptAnswer(RUN_ID, "stage-a", priorPrompt, "private-prior-answer"), true);
		assert.equal(store.recordStagePendingPrompt(RUN_ID, "stage-a", pendingPrompt), true);
		assert.equal(store.recordRunEnd(RUN_ID, "failed"), true);
		const terminalStage = store.runs().find((run) => run.id === RUN_ID)?.stages[0];
		assert.ok(terminalStage);
		terminalStage.pendingPrompt = structuredClone(pendingPrompt);
		terminalStage.status = "awaiting_input";
		terminalStage.awaitingInputSince = pendingPrompt.createdAt;
		const answerBefore = structuredClone(store.getStagePromptAnswer(RUN_ID, "stage-a"));
		const before = store.snapshot();
		assert.equal(answerBefore?.value, "private-prior-answer");

		const originalResolve = store.resolveStagePendingPrompt;
		let resolveCalls = 0;
		store.resolveStagePendingPrompt = (...args) => {
			resolveCalls += 1;
			return originalResolve(...args);
		};
		let result: Awaited<ReturnType<typeof workflowSendAction>> | undefined;
		try {
			result = await workflowSendAction({
				runId: RUN_ID,
				stageId: "stage-a",
				promptId: pendingPrompt.id,
				response: "must-not-answer",
				delivery: "answer",
			});
		} finally {
			store.resolveStagePendingPrompt = originalResolve;
		}

		assert.ok(result);
		assertTerminalFailure(result, "failed");
		assert.equal(resolveCalls, 0);
		const stageAfter = store.runs().find((run) => run.id === RUN_ID)?.stages[0];
		assert.deepEqual(stageAfter?.pendingPrompt, pendingPrompt);
		assert.deepEqual(store.getStagePromptAnswer(RUN_ID, "stage-a"), answerBefore);
		assert.deepEqual(store.snapshot(), before);
	});

	test("rejects explicit resume without reviving or mutating terminal state", async () => {
		const sessionFile = retainedSession("send-no-resume");
		seedTerminalRun(sessionFile);
		const deliveryCalls: string[] = [];
		const counter: RevivalCounter = { creates: 0, resolves: 0 };
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile,
			async prompt(text: string) {
				deliveryCalls.push(`prompt:${text}`);
			},
			async followUp(text: string) {
				deliveryCalls.push(`followUp:${text}`);
			},
			async steer(text: string) {
				deliveryCalls.push(`steer:${text}`);
			},
		};
		const before = runExecutionSnapshot();

		const result = await workflowSendAction(
			{ runId: RUN_ID, stageId: "stage-a", text: "resume should be rejected", delivery: "resume" },
			{ resolvePostMortemDeps: resolvePostMortemDeps(session, counter) },
		);

		assertTerminalFailure(result);
		assert.equal(result.delivery, "rejected");
		assert.deepEqual(deliveryCalls, []);
		assert.equal(counter.resolves, 0);
		assert.equal(counter.creates, 0);
		assert.deepEqual(runExecutionSnapshot(), before);
	});

	test("rejects explicit steer without reviving a terminal stage", async () => {
		const sessionFile = retainedSession("send-no-steer");
		seedTerminalRun(sessionFile);
		const deliveryCalls: string[] = [];
		const counter: RevivalCounter = { creates: 0, resolves: 0 };
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile,
			async prompt(text: string) {
				deliveryCalls.push(`prompt:${text}`);
			},
			async followUp(text: string) {
				deliveryCalls.push(`followUp:${text}`);
			},
			async steer(text: string) {
				deliveryCalls.push(`steer:${text}`);
			},
		};
		const before = runExecutionSnapshot();
		const result = await workflowSendAction(
			{ runId: RUN_ID, stageId: "stage-a", text: "steer attempt", delivery: "steer" },
			{ resolvePostMortemDeps: resolvePostMortemDeps(session, counter) },
		);
		assertTerminalFailure(result);
		assert.equal(result.delivery, "rejected");
		assert.deepEqual(deliveryCalls, []);
		assert.equal(counter.resolves, 0);
		assert.equal(counter.creates, 0);
		assert.deepEqual(runExecutionSnapshot(), before);
	});

	test("rejects auto delivery to a retained streaming terminal handle", async () => {
		seedTerminalRun(undefined);
		const deliveryCalls: string[] = [];
		const handle: StageControlHandle = {
			runId: RUN_ID,
			stageId: "stage-a",
			stageName: "final",
			status: "completed",
			sessionId: "retained-session",
			sessionFile: undefined,
			isStreaming: true,
			messages: [],
			async ensureAttached() {},
			async prompt(text: string) {
				deliveryCalls.push(`prompt:${text}`);
			},
			async followUp(text: string) {
				deliveryCalls.push(`followUp:${text}`);
			},
			async steer(text: string) {
				deliveryCalls.push(`steer:${text}`);
			},
			async pause() {},
			async resume() {},
			subscribe() {
				return () => {};
			},
		};
		stageControlRegistry.register(handle);
		const before = runExecutionSnapshot();

		const result = await workflowSendAction({
			runId: RUN_ID,
			stageId: "stage-a",
			text: "queue after the active turn",
		});

		assertTerminalFailure(result);
		assert.equal(result.delivery, "rejected");
		assert.deepEqual(deliveryCalls, []);
		assert.deepEqual(runExecutionSnapshot(), before);
	});

	test("returns the root-terminal error without probing an invalid session", async () => {
		seedTerminalRun(join(tempDir, "missing.jsonl"));
		const counter: RevivalCounter = { creates: 0, resolves: 0 };
		const result = await workflowSendAction(
			{ runId: RUN_ID, stageId: "stage-a", text: "hello" },
			{ resolvePostMortemDeps: resolvePostMortemDeps(mockSession(), counter) },
		);
		assertTerminalFailure(result);
		assert.equal(counter.resolves, 0);
		assert.equal(counter.creates, 0);
	});

	test("returns the same root-terminal error when no session was retained", async () => {
		seedTerminalRun(undefined);
		const counter: RevivalCounter = { creates: 0, resolves: 0 };
		const result = await workflowSendAction(
			{ runId: RUN_ID, stageId: "stage-a", text: "hello" },
			{ resolvePostMortemDeps: resolvePostMortemDeps(mockSession(), counter) },
		);
		assertTerminalFailure(result);
		assert.equal(counter.resolves, 0);
		assert.equal(counter.creates, 0);
	});
});
