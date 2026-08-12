import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_CODEX_FAST_MODE, getEnvNames } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.ts";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { createAsyncJobTracker } from "../../packages/subagents/src/runs/background/async-job-tracker.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { executeAsyncSingle } from "../../packages/subagents/src/runs/inprocess/background-single.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import {
	ASYNC_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	type SubagentState,
} from "../../packages/subagents/src/shared/types.ts";

const fastModeEnvNames = getEnvNames(ENV_CODEX_FAST_MODE);
const agentDirEnvNames = getEnvNames(ENV_AGENT_DIR);
let previousFastModeEnv: Record<string, string | undefined> = {};
let previousAgentDirEnv: Record<string, string | undefined> = {};

const tempRoots: string[] = [];
const CODEX_MODEL = "openai/gpt-5.1-codex";
const REAL_SUBAGENT_EVENT_TIMEOUT_MS = 15_000;
const REAL_SUBAGENT_REQUEST_TIMEOUT_MS = 60_000;

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "fast-mode fixture worker",
		systemPrompt: "Return the fixture output.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/fast-mode-worker.md",
	};
}

type EventHandler = (payload: unknown) => void;

class TestEvents {
	private readonly handlers = new Map<string, Set<EventHandler>>();

	on(event: string, handler: EventHandler): () => void {
		const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, payload: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
	}
}

function makeState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: "parent-session",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function withEventTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} did not arrive within ${REAL_SUBAGENT_EVENT_TIMEOUT_MS} ms`)),
			REAL_SUBAGENT_EVENT_TIMEOUT_MS,
		);
		void promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function requestBody(init: RequestInit | undefined): Promise<Record<string, unknown> | undefined> {
	const text = await new Response(init?.body).text();
	return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}

function completedOpenAIResponse(): Response {
	const message = {
		id: "msg_subagent_fast_mode",
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text: "ok", annotations: [] }],
		phase: "final_answer",
	};
	const events = [
		{ type: "response.created", response: { id: "resp_subagent_fast_mode", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message, status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item: message },
		{
			type: "response.completed",
			response: {
				id: "resp_subagent_fast_mode",
				status: "completed",
				output: [message],
				usage: {
					input_tokens: 0,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 0,
					total_tokens: 0,
				},
			},
		},
	];
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function setupRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-fast-mode-"));
	tempRoots.push(root);
	mkdirSync(join(root, ".atomic"), { recursive: true });
	writeFileSync(
		join(root, ".atomic", "settings.json"),
		JSON.stringify({
			defaultProvider: "openai",
			defaultModel: "gpt-5.1-codex",
			codexFastMode: { chat: false, workflow: true },
		}),
		"utf8",
	);
	return root;
}

beforeEach(() => {
	previousFastModeEnv = Object.fromEntries(fastModeEnvNames.map((name) => [name, process.env[name]]));
	previousAgentDirEnv = Object.fromEntries(agentDirEnvNames.map((name) => [name, process.env[name]]));
	for (const name of fastModeEnvNames) delete process.env[name];
	for (const name of agentDirEnvNames) delete process.env[name];
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearSubagentControls();
	for (const name of fastModeEnvNames) {
		if (previousFastModeEnv[name] === undefined) delete process.env[name];
		else process.env[name] = previousFastModeEnv[name];
	}
	for (const name of agentDirEnvNames) {
		if (previousAgentDirEnv[name] === undefined) delete process.env[name];
		else process.env[name] = previousAgentDirEnv[name];
	}
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("in-process child results use the workflow fast-mode setting for workflow stages", async () => {
	const root = setupRoot();
	const workflowResult = await runSingleInProcess(root, agent(), "workflow task", {
		cwd: root,
		runId: "workflow-fast-mode",
		modelOverride: CODEX_MODEL,
		workflowStageSubagentGuard: true,
		workflowSessionMetadata: {
			runId: "workflow-run",
			stageId: "stage-1",
			stageName: "Stage 1",
		},
		testSession: { output: "workflow result" },
	});
	const chatResult = await runSingleInProcess(root, agent(), "chat task", {
		cwd: root,
		runId: "chat-fast-mode",
		modelOverride: CODEX_MODEL,
		testSession: { output: "chat result" },
	});

	assert.equal(workflowResult.model, CODEX_MODEL);
	assert.equal(workflowResult.fastMode, true);
	assert.equal(chatResult.model, CODEX_MODEL);
	assert.equal(chatResult.fastMode, undefined);
});

test(
	"stage-launched in-process children carry workflow priority tier to the provider request",
	async () => {
		const root = setupRoot();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ openai: { type: "api_key", key: "test-api-key" } }),
			"utf8",
		);
		for (const name of agentDirEnvNames) process.env[name] = agentDir;
		const payloads: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const payload = await requestBody(init);
				if (payload) payloads.push(payload);
				return completedOpenAIResponse();
			}),
		);
		const workflowSessionMetadata = { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" };
		const enabled = await runSingleInProcess(root, agent(), "priority request", {
			cwd: root,
			runId: "workflow-real-request-enabled",
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			workflowSessionMetadata,
			testSession: false,
		});
		assert.equal(enabled.status, "ok");
		assert.ok(payloads.length > 0);
		for (const payload of payloads) assert.equal(payload.service_tier, "priority");
		payloads.length = 0;

		writeFileSync(
			join(root, ".atomic", "settings.json"),
			JSON.stringify({
				defaultProvider: "openai",
				defaultModel: "gpt-5.1-codex",
				codexFastMode: { chat: false, workflow: false },
			}),
			"utf8",
		);
		const disabled = await runSingleInProcess(root, agent(), "ordinary request", {
			cwd: root,
			runId: "workflow-real-request-disabled",
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			workflowSessionMetadata,
			testSession: false,
		});
		assert.equal(disabled.status, "ok");
		assert.ok(payloads.length > 0);
		for (const payload of payloads) assert.equal(payload.service_tier, undefined);
	},
	REAL_SUBAGENT_REQUEST_TIMEOUT_MS,
);

test("live and detached results follow the effective fallback model's fast-mode scope", async () => {
	const root = setupRoot();
	const fallbackModel = "anthropic/claude-sonnet-4";
	const detached = Promise.withResolvers<Awaited<ReturnType<typeof runSingleInProcess>>>();
	const liveResults: Array<{ model?: string; fastMode?: boolean }> = [];
	const fallbackAgent: AgentConfig = { ...agent(), fallbackModels: [fallbackModel] };

	const continued = await runSingleInProcess(root, fallbackAgent, "fallback task", {
		cwd: root,
		runId: "workflow-fallback-metadata",
		modelOverride: CODEX_MODEL,
		workflowSessionMetadata: { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" },
		backgroundContinuation: true,
		testSession: { output: "fallback result", fallbackModel },
		onUpdate: (update) => {
			const result = update.details?.results[0];
			if (result) liveResults.push(result);
		},
		onDetachedExit: (result) => detached.resolve(result),
	});

	assert.equal(continued.model, fallbackModel);
	assert.equal(continued.fastMode, undefined);
	const recovered = await withEventTimeout(detached.promise, "fallback detached result");
	assert.equal(recovered.model, fallbackModel);
	assert.equal(recovered.fastMode, undefined);
	assert.ok(
		liveResults.some((result) => result.model === fallbackModel && result.fastMode === undefined),
		"live progress should use the fallback model's fast-mode scope",
	);
});
test("async workflow child launch and completion retain the scoped fast marker", async () => {
	const root = setupRoot();
	const runId = `workflow-fast-mode-async-${crypto.randomUUID()}`;
	const started = Promise.withResolvers<unknown>();
	const completed = Promise.withResolvers<unknown>();
	const events = new TestEvents();
	events.on(SUBAGENT_ASYNC_STARTED_EVENT, (payload) => started.resolve(payload));
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => completed.resolve(payload));

	try {
		const launched = await executeAsyncSingle(runId, {
			agent: "worker",
			task: "async workflow task",
			agentConfig: agent(),
			ctx: {
				pi: { events } as never,
				cwd: root,
				currentSessionId: "parent-session",
				workflowSessionMetadata: { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" },
			},
			cwd: root,
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 0,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			testSession: { output: "async workflow result" },
		});

		assert.equal(launched.details.results[0]?.model, CODEX_MODEL);
		assert.equal(launched.details.results[0]?.fastMode, true);
		const startedEvent = (await withEventTimeout(started.promise, "async started event")) as {
			model?: string;
			fastMode?: boolean;
		};
		assert.equal(startedEvent.model, CODEX_MODEL);
		assert.equal(startedEvent.fastMode, true);
		const completionEvent = (await withEventTimeout(completed.promise, "async completion event")) as {
			result?: { model?: string; fastMode?: boolean };
		};
		assert.equal(completionEvent.result?.model, CODEX_MODEL);
		assert.equal(completionEvent.result?.fastMode, true);
	} finally {
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
	}
});

test("async workflow fast metadata survives live registry hydration", async () => {
	const root = setupRoot();
	const runId = `workflow-fast-mode-hydration-${crypto.randomUUID()}`;
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<unknown>();
	const completed = Promise.withResolvers<void>();
	const events = new TestEvents();
	const currentState = makeState(root);
	const tracker = createAsyncJobTracker({ events } as never, currentState, join(root, "async"), {
		pollIntervalMs: 60_000,
	});
	events.on(SUBAGENT_ASYNC_STARTED_EVENT, tracker.handleStarted);
	events.on(SUBAGENT_ASYNC_STARTED_EVENT, (payload) => started.resolve(payload));
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, tracker.handleComplete);
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, () => completed.resolve());
	let launched = false;

	try {
		await executeAsyncSingle(runId, {
			agent: "worker",
			task: "async workflow hydration task",
			agentConfig: agent(),
			ctx: {
				pi: { events } as never,
				cwd: root,
				currentSessionId: "parent-session",
				workflowSessionMetadata: { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" },
			},
			cwd: root,
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 0,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			testSession: { output: "async workflow hydration result", promptGate: gate.promise },
		});
		launched = true;
		await withEventTimeout(started.promise, "hydration async started event");
		const before = currentState.asyncJobs.get(runId);
		assert.equal(before?.steps?.[0]?.model, CODEX_MODEL);
		assert.equal(before?.steps?.[0]?.fastMode, true);
		const startedAt = before?.startedAt;
		assert.ok(startedAt !== undefined);

		tracker.hydrateActiveJobs();
		const after = currentState.asyncJobs.get(runId);
		assert.equal(after?.steps?.[0]?.model, CODEX_MODEL);
		assert.equal(after?.steps?.[0]?.fastMode, true);
		assert.equal(after?.startedAt, startedAt);
	} finally {
		if (launched) {
			gate.resolve();
			await withEventTimeout(completed.promise, "hydration async completion event");
		}
		tracker.resetJobs();
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
	}
});
