/**
 * A subagent explicitly launched as `provider/model:effort` starts at once and runs at that effort on each model that
 * supports it, and at that model's default level on one that does not. Real in-process runner and AgentSession
 * against a local provider; no network is contacted.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
	type ThinkingLevel,
} from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { createAgentSession, withResourceAdmission } from "../../packages/coding-agent/src/core/sdk.js";
import type { ResourceAdmission } from "../../packages/coding-agent/src/core/sdk-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { AuthStorage, ModelRuntime } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { inspectInProcessChildStatus } from "../../packages/subagents/src/runs/inprocess/control-status.js";

/**
 * The start budget a wedged child gets: long enough for a loaded machine to open its session and load its resources,
 * so the budget runs out where the child waits for its permit.
 */
const WEDGED_START_BUDGET_MS = 10_000;
/** How long a red run waits for a child that never starts before it gives up on it; past any start budget here. */
const STUCK_CHILD_GIVE_UP_MS = 3 * WEDGED_START_BUDGET_MS;

/**
 * Structural cost, not a slow test: each case builds a real parent AgentSession and a real child AgentSession with
 * its resource loader and tool registry.
 */
const REAL_CHILD_SESSION_TIMEOUT_MS = 90_000;

const UP_TO_XHIGH: Model<"anthropic-messages">["thinkingLevelMap"] = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
};
/** No xhigh: clamping an xhigh request would give high, so a child at medium or low ran at a default. */
const UP_TO_HIGH: Model<"anthropic-messages">["thinkingLevelMap"] = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
};

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function worker(cwd: string): AgentConfig {
	return {
		name: "worker",
		description: "effort fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
	};
}

/** A workflow root's admission with no headroom left, as when the host is below its free-memory floor. */
class ExhaustedWorkflowAdmission implements ResourceAdmission {
	readonly requests: string[] = [];
	acquire(kind: "session" | "process", signal?: AbortSignal): Promise<() => Promise<void>> {
		this.requests.push(kind);
		return new Promise((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	}
}

/** An admission that grants its holder's own session, then never answers again, as a wedged permit store would. */
class WedgedAdmission implements ResourceAdmission {
	readonly requests: string[] = [];
	acquire(kind: "session" | "process", signal?: AbortSignal): Promise<() => Promise<void>> {
		this.requests.push(kind);
		if (this.requests.length === 1) return Promise.resolve(async () => undefined);
		return new Promise((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	}
}

interface EffortFixtureOptions {
	/** The parent's own admission, as a workflow stage session holds one. */
	readonly parentAdmission?: ResourceAdmission;
	/** The requested model's quota is exhausted, so the child falls back to the parent's model. */
	readonly primaryQuotaExhausted?: boolean;
	/** The levels the requested model supports. */
	readonly requestedModelLevels?: Model<"anthropic-messages">["thinkingLevelMap"];
	/** The levels the parent's model, the child's fallback, supports. */
	readonly parentModelLevels?: Model<"anthropic-messages">["thinkingLevelMap"];
	/** Per-model default thinking levels, as `modelThinkingLevels` in settings configures them. */
	readonly modelThinkingLevels?: Record<string, ThinkingLevel>;
}

async function effortFixture(options: EffortFixtureOptions = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-effort-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const model: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		provider: "effort-fixture",
		reasoning: true,
		thinkingLevelMap: options.requestedModelLevels ?? UP_TO_XHIGH,
	};
	// The parent's own chat model, which every child falls back to.
	const parentModel: Model<"anthropic-messages"> = {
		...model,
		id: "parent-model",
		thinkingLevelMap: options.parentModelLevels ?? UP_TO_XHIGH,
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: { model: string; effort: ThinkingLevel | undefined }[] = [];
	runtime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture-key",
		models: [model, parentModel],
		streamSimple: (requestModel, _context, streamOptions) => {
			requests.push({ model: requestModel.id, effort: streamOptions?.reasoning });
			const stream = createAssistantMessageEventStream();
			const exhausted = options.primaryQuotaExhausted === true && requestModel.id === model.id;
			const message: AssistantMessage = {
				role: "assistant",
				content: exhausted ? [] : [{ type: "text", text: "child done" }],
				api: model.api,
				provider: model.provider,
				model: requestModel.id,
				usage: usage(),
				stopReason: exhausted ? "error" : "stop",
				...(exhausted ? { errorMessage: "402 insufficient_quota: the requested model's quota is exhausted" } : {}),
				timestamp: Date.now(),
			};
			if (exhausted) stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(model.provider));
	// A top-level session: created outside any workflow, so it holds no resource admission of its own.
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		model: parentModel,
		thinkingLevel: "medium",
		settingsManager: SettingsManager.inMemory({
			retry: { enabled: false },
			defaultThinkingLevel: "medium",
			...(options.modelThinkingLevels ? { modelThinkingLevels: options.modelThinkingLevels } : {}),
		}),
		sessionManager: await SessionManager.create(cwd, join(cwd, "parent-sessions")),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
		...(options.parentAdmission ? { resourceAdmission: options.parentAdmission } : {}),
	});
	cleanups.push(() => {
		parent.dispose();
		clearSubagentControls();
	});
	const launch = (runId: string, signal?: AbortSignal, sessionStartTimeoutMs?: number) =>
		runSingleInProcess(cwd, worker(cwd), "reply done", {
			cwd,
			...(signal ? { signal } : {}),
			...(sessionStartTimeoutMs === undefined ? {} : { sessionStartTimeoutMs }),
			runId,
			index: 0,
			sessionDir: join(cwd, "children"),
			testSession: false,
			modelOverride: `${model.provider}/${model.id}:xhigh`,
			currentModel: `${parentModel.provider}/${parentModel.id}`,
			currentThinkingLevel: "medium",
			availableModels: [model, parentModel].map((entry) => ({
				provider: entry.provider,
				id: entry.id,
				fullId: `${entry.provider}/${entry.id}`,
			})),
			resolveCandidateModel: (candidate) =>
				candidate.startsWith(`${model.provider}/${model.id}`)
					? { model, thinkingLevel: "xhigh" }
					: { model: parentModel },
			getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
		});
	return { launch, requests, model, parentModel };
}

test(
	"a subagent launched from a turn a workflow's admission scope started runs at its requested effort without taking that workflow's permit",
	async () => {
		const fixture = await effortFixture();
		const workflowAdmission = new ExhaustedWorkflowAdmission();
		// A workflow lifecycle notice wakes the idle parent from inside the run's admission scope; the
		// parent's turn, and the `subagent` call it makes, run in that scope.
		const giveUp = new AbortController();
		const launched = withResourceAdmission(workflowAdmission, () => fixture.launch("effort-scoped", giveUp.signal));
		const outcome = await Promise.race([
			launched.then((result) => ({ kind: "settled" as const, result })),
			new Promise<{ kind: "stuck" }>((resolve) =>
				setTimeout(() => resolve({ kind: "stuck" }), STUCK_CHILD_GIVE_UP_MS),
			),
		]);
		giveUp.abort();
		await launched;

		assert.deepEqual(workflowAdmission.requests, [], "the child never waits on another workflow's admission");
		assert.equal(outcome.kind, "settled", "the child must start, not wait for a session permit");
		if (outcome.kind !== "settled") return;
		assert.equal(outcome.result.status, "ok", JSON.stringify(outcome.result));
		assert.equal(outcome.result.thinking, "xhigh");
		assert.deepEqual(fixture.requests, [{ model: fixture.model.id, effort: "xhigh" }], "asked at exactly xhigh");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child whose session never starts fails within its start budget, and status no longer calls it running",
	async () => {
		const admission = new WedgedAdmission();
		const fixture = await effortFixture({ parentAdmission: admission });
		const giveUp = new AbortController();
		const launched = fixture.launch("effort-wedged", giveUp.signal, WEDGED_START_BUDGET_MS);
		const outcome = await Promise.race([
			launched.then((result) => ({ kind: "settled" as const, result })),
			new Promise<{ kind: "stuck" }>((resolve) =>
				setTimeout(() => resolve({ kind: "stuck" }), STUCK_CHILD_GIVE_UP_MS),
			),
		]);
		const statusWhileWaiting = JSON.stringify(inspectInProcessChildStatus("effort-wedged")?.content);
		giveUp.abort();
		await launched;

		assert.deepEqual(admission.requests, ["session", "session"], "the child waited on its parent's admission");
		assert.equal(
			outcome.kind,
			"settled",
			`the child must fail within its start budget; status: ${statusWhileWaiting}`,
		);
		if (outcome.kind !== "settled") return;
		assert.equal(outcome.result.status, "error", JSON.stringify(outcome.result));
		assert.match(outcome.result.error ?? "", /did not start within 10s \(still creating its agent session/);
		assert.deepEqual(fixture.requests, [], "its task never reached the provider");
		assert.match(
			statusWhileWaiting,
			/worker_1 — error \((?:loaded|cold)\) · id effort-wedged:0 · Subagent session did not start within 10s/,
		);
		assert.doesNotMatch(statusWhileWaiting, /running/);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"an explicit effort the model does not support starts the child at that model's default level",
	async () => {
		const fixture = await effortFixture({ requestedModelLevels: UP_TO_HIGH });
		const result = await fixture.launch("effort-unsupported");

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.deepEqual(fixture.requests, [{ model: fixture.model.id, effort: "medium" }], "the default, not a clamp");
		assert.equal(result.thinking, "medium");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a fallback model that supports the explicit effort keeps it",
	async () => {
		const fixture = await effortFixture({ primaryQuotaExhausted: true });
		const result = await fixture.launch("effort-fallback-kept");

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.deepEqual(fixture.requests, [
			{ model: fixture.model.id, effort: "xhigh" },
			{ model: fixture.parentModel.id, effort: "xhigh" },
		]);
		assert.equal(result.thinking, "xhigh");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a fallback model that does not support the explicit effort runs at its own default level",
	async () => {
		const fixture = await effortFixture({
			primaryQuotaExhausted: true,
			parentModelLevels: UP_TO_HIGH,
			modelThinkingLevels: { "effort-fixture/parent-model": "low" },
		});
		const result = await fixture.launch("effort-fallback-default");

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.deepEqual(fixture.requests, [
			{ model: fixture.model.id, effort: "xhigh" },
			{ model: fixture.parentModel.id, effort: "low" },
		]);
		assert.equal(result.thinking, "low");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);
