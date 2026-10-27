import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	installWorkflowLifecycleNotifications,
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createExtensionRuntime, type ExtensionRuntimeOpts } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { WORKFLOW_AUTH_TIMEOUT_FAILURE_MESSAGE } from "../../packages/workflows/src/shared/workflow-failures.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";

// Issue #3085 / #3087

/**
 * Each status poll gives the run a real-time slice for its I/O, then advances fake time (retry, cooldown and auth
 * delays) by one step. A run under load needs more slices than an idle one before its next timer is even armed, so
 * the waits end on the state they wait for, not after a fixed number of polls: 60 polls failed under CPU contention
 * with the run still waiting on its first fallback (#3085/#3087).
 */
const RUN_STATUS_POLL_REAL_MS = 50;
const RUN_STATUS_POLL_FAKE_MS = 1_000;
/** Real time all of the test's waits share, inside the 30 s test timeout, leaving room to report and clean up. */
const WAITS_REAL_BUDGET_MS = 24_000;

/**
 * The real `process.hrtime.bigint`, saved when this module loads, before any test installs fake timers: vitest's fake
 * timers replace `process.hrtime` and `performance` too, so a clock read through them stands still in real time.
 */
const realHrtime = process.hrtime.bigint;

/** Real elapsed milliseconds, whether or not fake timers are installed. */
function realNow(): number {
	return Number(realHrtime() / 1_000_000n);
}

/** Runs `step` until `done`, or until the real clock passes `deadline` (whichever comes first). */
async function pollUntil(done: () => boolean, step: () => Promise<void>, deadline: number): Promise<void> {
	while (!done() && realNow() < deadline) await step();
}

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

function message(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	extra: {
		content?: AssistantMessage["content"];
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: extra.content ?? [{ type: "text", text: "ok" }],
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
		stopReason: extra.stopReason ?? "stop",
		timestamp: Date.now(),
		...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
	};
}

function response(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	extra: {
		content?: AssistantMessage["content"];
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
	} = {},
) {
	const stream = createAssistantMessageEventStream();
	const msg = message(model, extra);
	stream.push({ type: "start", partial: msg });
	if (msg.stopReason === "error") {
		stream.push({ type: "error", reason: "error", error: msg });
	} else {
		stream.push({ type: "done", reason: "stop", message: msg });
	}
	stream.end(msg);
	return stream;
}

function requestedProvider(model: unknown): string {
	if (typeof model === "string") return model.split("/")[0] ?? "primary";
	if (model !== null && typeof model === "object" && "provider" in model && typeof model.provider === "string") {
		return model.provider;
	}
	return "primary";
}

test("a wait on a run that never gets there ends at its real-time deadline while fake timers run (#3085)", async () => {
	// The deadline is taken before fake timers are installed, as the scenario below does.
	const deadline = realNow() + 300;
	vi.useFakeTimers();
	let abandoned = false;
	try {
		const outcome = await Promise.race([
			pollUntil(
				() => abandoned,
				async () => {
					await realSleep(RUN_STATUS_POLL_REAL_MS);
					await vi.advanceTimersByTimeAsync(RUN_STATUS_POLL_FAKE_MS);
				},
				deadline,
			).then(() => "ended at its deadline"),
			realSleep(5_000).then(() => "still polling after 5 s of real time"),
		]);
		assert.equal(outcome, "ended at its deadline");
	} finally {
		abandoned = true;
		vi.useRealTimers();
	}
});

test("fabricated provider exhaustion becomes blocked, durably discoverable, and resumes without replaying prefix", async () => {
	const deadline = realNow() + WAITS_REAL_BUDGET_MS;
	/** Polls until `done`, advancing fake time a step per real slice, or until the test's shared real budget is spent. */
	const until = (done: () => boolean, step: () => Promise<void>) => pollUntil(done, step, deadline);
	const cleanup: Array<() => void | Promise<void>> = [];
	try {
		const dir = mkdtempSync(join(tmpdir(), "atomic-3085-wf-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const backend = await JournalTestBackend.create();
		setDurableBackend(backend);
		cleanup.push(() => setDurableBackend(undefined));

		const parent = await SessionManager.create(dir, join(dir, "parent-sessions"));
		const store = createStore();
		const notices: Array<{ customType?: string; details?: { kind?: string; status?: string } }> = [];
		const blockedNoticeCommitted = Promise.withResolvers<void>();
		cleanup.push(
			installWorkflowLifecycleNotifications({
				store,
				config: { enabled: true, notifyOn: ["blocked", "completed", "failed"] },
				sendMessage: async (message) => {
					const details = message.details as { kind?: string; status?: string } | undefined;
					notices.push({ customType: message.customType, details });
					await parent.appendCustomMessageEntry(
						message.customType ?? LIFECYCLE_NOTICE_CUSTOM_TYPE,
						message.content,
						message.display !== false,
						details,
					);
					if (details?.kind === "blocked") blockedNoticeCommitted.resolve();
				},
			}),
		);

		let recovered = false;
		let prefix = 0;
		const definition = workflow({
			name: "provider-auth-block-3085",
			description: "isolated provider recovery",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("prefix", {}, async () => ++prefix);
				await ctx.stage("provider", { model: "primary/m", fallbackModels: ["probe/m"] }).prompt("go");
				return {};
			},
		});
		const runtimeOptions: ExtensionRuntimeOpts = {
			store,
			jobs: createJobTracker(),
			cwd: dir,
			registry: createRegistry([definition]),
			adapters: {
				sessionStore: parent.getSessionStore(),
				agentSession: {
					create: async (options) => {
						const credentials = AuthStorage.inMemory({
							probe: { type: "oauth", access: "fabricated", refresh: "fabricated", expires: 1 },
							primary: { type: "api_key", key: "fabricated" },
						});
						const modelRuntime = await ModelRuntime.create({
							credentials,
							modelsPath: null,
							refreshOnCreate: false,
						});
						modelRuntime.registerProvider("probe", {
							api: "openai-completions",
							baseUrl: "https://example.invalid",
							oauth: {
								name: "probe",
								login: async () => {
									throw new Error("not used");
								},
								refreshToken: async (credential) => {
									if (!recovered) return new Promise(() => {});
									return { ...credential, expires: Number.MAX_SAFE_INTEGER };
								},
								getApiKey: (credential) => credential.access,
							},
							models: [spec],
							streamSimple: (model) => response(model),
						});
						modelRuntime.registerProvider("primary", {
							api: "openai-completions",
							baseUrl: "https://example.invalid",
							apiKey: "fabricated",
							models: [spec],
							streamSimple: (model) =>
								response(model, {
									content: [],
									stopReason: "error",
									errorMessage: "429 rate limit exceeded",
								}),
						});
						const sessionDir = mkdtempSync(join(dir, "stage-"));
						assert.ok(options.sessionManager);
						const { session } = await createAgentSession({
							cwd: sessionDir,
							agentDir: sessionDir,
							// #3105: this provider-only stage fixture has no extension resources.
							builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
							modelRuntime,
							model: modelRuntime.getModel(requestedProvider(options.model), "m")!,
							fallbackModels: options.fallbackModels,
							settingsManager: SettingsManager.inMemory({
								retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 },
								compaction: { enabled: false },
							}),
							sessionManager: options.sessionManager,
							resourceLoader: createTestResourceLoader(),
						});
						cleanup.push(() => session.dispose());
						return session as unknown as StageSessionRuntime;
					},
				},
			},
		};
		const runtime = createExtensionRuntime(runtimeOptions);

		vi.useFakeTimers();
		let started: { action?: string; runId?: string } | undefined;
		const starting = runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} }).then((result) => {
			started = result;
		});
		await until(
			() => started !== undefined,
			async () => {
				await realSleep(1);
				await vi.advanceTimersByTimeAsync(1);
			},
		);
		assert.ok(started, "detached dispatch must acknowledge");
		await starting;
		const startedRun = started;
		assert.equal(startedRun.action, "run");
		assert.ok(startedRun.runId);

		await until(
			() => effectiveRunStatus(store.runs().find((run) => run.id === startedRun.runId)!) === "blocked",
			async () => {
				await realSleep(RUN_STATUS_POLL_REAL_MS);
				await vi.advanceTimersByTimeAsync(RUN_STATUS_POLL_FAKE_MS);
			},
		);
		const source = store.runs().find((run) => run.id === startedRun.runId);
		assert.ok(source);
		assert.equal(effectiveRunStatus(source), "blocked", JSON.stringify(source));
		assert.equal(source.failureKind, "auth");
		assert.equal(source.failureCode, "auth_timeout");
		assert.equal(source.failureDisposition, "active_blocked");
		assert.equal(source.failureRecoverability, "recoverable");
		assert.equal(source.resumable, true);
		assert.equal(source.error, WORKFLOW_AUTH_TIMEOUT_FAILURE_MESSAGE);
		assert.doesNotMatch(source.failureMessage ?? "", /log in/i);
		assert.doesNotMatch(source.failureMessage ?? "", /\/login/);
		assert.equal(prefix, 1);

		await blockedNoticeCommitted.promise;
		const blocks = () => notices.filter((notice) => notice.details?.kind === "blocked");
		assert.equal(blocks().length, 1);
		assert.equal(blocks()[0]?.details?.status, "blocked");
		await vi.advanceTimersByTimeAsync(60_000);
		assert.equal(blocks().length, 1);

		const parentFile = parent.getSessionFile();
		assert.ok(parentFile && existsSync(parentFile));
		const parentCards = readFileSync(parentFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; customType?: string; details?: { kind?: string } })
			.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE &&
					entry.details?.kind === "blocked",
			);
		assert.equal(parentCards.length, 1, "parent transcript must persist exactly one blocked lifecycle card");

		const fresh = await backend.reopen();
		await fresh.hydrateWorkflow(source.id);
		const hydrated = fresh.getWorkflow(source.id);
		assert.ok(hydrated, "blocked workflow must remain discoverable after journal reopen");
		assert.equal(hydrated.status, "blocked");
		assert.equal(hydrated.resumable, true);

		recovered = true;
		setDurableBackend(fresh);
		const restoredStore = createStore();
		const recoveryRuntime = createExtensionRuntime({
			...runtimeOptions,
			store: restoredStore,
			jobs: createJobTracker(),
		});
		let resumed: { ok?: boolean; runId?: string; message?: string } | undefined;
		const resuming = recoveryRuntime.resumeDurableWorkflow(source.id).then((result) => {
			resumed = result;
		});
		await until(
			() => resumed !== undefined,
			async () => {
				vi.useRealTimers();
				await realSleep(RUN_STATUS_POLL_REAL_MS);
				vi.useFakeTimers();
				await vi.advanceTimersByTimeAsync(1);
			},
		);
		assert.ok(resumed, "resume must acknowledge");
		await resuming;
		const resumedRun = resumed;
		assert.equal(resumedRun.ok, true, resumedRun.message);
		assert.ok(resumedRun.runId);

		await until(
			() => effectiveRunStatus(restoredStore.runs().find((run) => run.id === resumedRun.runId)!) === "completed",
			async () => {
				await realSleep(RUN_STATUS_POLL_REAL_MS);
				await vi.advanceTimersByTimeAsync(RUN_STATUS_POLL_FAKE_MS);
			},
		);
		const continuation = restoredStore.runs().find((run) => run.id === resumedRun.runId);
		assert.ok(continuation);
		assert.equal(effectiveRunStatus(continuation), "completed", JSON.stringify(continuation));
		assert.equal(prefix, 1, "completed prefix must not execute twice");
		assert.equal(blocks().length, 1);
	} finally {
		vi.useRealTimers();
		for (const dispose of cleanup.splice(0).reverse()) await dispose();
	}
});
