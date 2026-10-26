/**
 * #3981: a stage's model fallback retires the session that launched a background subagent while that child keeps
 * running. The child's model route was built from the launching tool's context, and the child consults it as its own
 * fallback gate. A real workflow run, a real stage AgentSession with stage fallback, and a real in-process child
 * session against local providers; no network is contacted.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Message } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { isStaleExtensionContextError } from "../../packages/coding-agent/src/core/extensions/stale-context.js";
import { AuthStorage, ModelRuntime, SettingsManager } from "../../packages/coding-agent/src/index.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, sleep } from "../helpers/runtime.js";

/** Structural cost, not a slow test: a real stage session, its fallback replacement, and a real child session. */
const REAL_SESSIONS_TIMEOUT_MS = 120_000;
const SECOND_TASK = "Second queued fixture task.";
/** How long the replacement session waits for a child's step before the stage moves on without it. */
const CHILD_BOUND_MS = 20_000;
const SAFETY_NET_LOG = "ignored a stale extension-context rejection";
/** Distinct from any routed text: auto routing refuses a task that contains a configured credential. */
const PROVIDER_KEY = "local-provider-key-3981";

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

function reply(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	content: AssistantMessage["content"],
	failure?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: failure !== undefined ? "error" : content.length > 0 ? "toolUse" : "stop",
		timestamp: Date.now(),
		...(failure === undefined ? {} : { errorMessage: failure }),
	};
}

function firstUserText(messages: readonly Message[]): string {
	const user = messages.find((message) => message.role === "user");
	if (!user) return "";
	return typeof user.content === "string"
		? user.content
		: user.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

type Caller = "stage" | "child" | "router";

function callerOf(messages: readonly Message[]): Caller {
	const text = firstUserText(messages);
	if (text === "go") return "stage";
	// Auto routing of the subagent asks its questions as a structured state object.
	if (text.includes('"questions"')) return "router";
	return "child";
}

interface ChildCall {
	readonly provider: string;
	readonly task: string;
}

/**
 * Run one schema stage whose first turn launches background subagents with `launch`, after which every stage call is
 * rate limited, so stage fallback replaces the launching session. Children stay mid-turn until that has happened, then
 * are rate limited too.
 */
async function runStageThatLaunchesSubagents(
	launch: Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"],
	hooks: {
		/** Holds the replacement session's model calls, keeping the stage open until a child has done its part. */
		readonly replacementHold?: () => Promise<void>;
		readonly onChildCall?: (call: ChildCall) => void;
	} = {},
) {
	const directory = makeTempDirectory("stage-fallback-subagent-3981-");
	directories.push(directory);
	// `fallback-worker` is `worker` with a fallback model of its own, so its fallback walk consults its route's gate.
	const agentDir = join(directory, "agent-home");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	const worker = readFileSync(join(moduleDir(import.meta.url), "../../packages/subagents/agents/worker.md"), "utf8");
	writeFileSync(
		join(agentDir, "agents", "fallback-worker.md"),
		worker
			.replace("name: worker", "name: fallback-worker")
			.replace("model: auto", "model: auto\nfallbackModels: spare/m"),
	);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	// Subagent children are test doubles under NODE_ENV=test; these must be real sessions.
	vi.stubEnv("NODE_ENV", "development");

	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	const consoleError = vi.spyOn(console, "error");

	const launchingSessionRetired = Promise.withResolvers<void>();
	const childCalls: ChildCall[] = [];
	let stageCalls = 0;
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({
			limited: { type: "api_key", key: PROVIDER_KEY },
			spare: { type: "api_key", key: PROVIDER_KEY },
		}),
		modelsPath: null,
		refreshOnCreate: false,
	});
	for (const provider of ["limited", "spare"]) {
		modelRuntime.registerProvider(provider, {
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			apiKey: PROVIDER_KEY,
			models: [spec],
			streamSimple: (model, context) => {
				const stream = createAssistantMessageEventStream();
				const caller = callerOf(context.messages);
				if (caller === "stage" && provider === "spare") launchingSessionRetired.resolve();
				if (caller === "child") {
					const call = { provider, task: firstUserText(context.messages) };
					childCalls.push(call);
					hooks.onChildCall?.(call);
				}
				const launches = caller === "stage" && provider === "limited" && stageCalls++ === 0;
				void (async () => {
					if (caller === "child") await launchingSessionRetired.promise;
					if (caller === "stage" && provider === "spare") await hooks.replacementHold?.();
					const message =
						caller === "router"
							? reply(model, [], "400 router unavailable")
							: launches
								? reply(model, [
										{ type: "toolCall", id: "launch-children", name: "subagent", arguments: launch },
									])
								: reply(model, [], "429 rate limit exceeded");
					stream.push({ type: "start", partial: message });
					if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: "toolUse", message });
					stream.end(message);
				})();
				return stream;
			},
		});
	}

	let stageError: unknown;
	const definition = workflow({
		name: "stage-fallback-subagents",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			try {
				await ctx.task("design-and-implement", {
					prompt: "go",
					model: modelRuntime.getModel("limited", "m")!,
					fallbackModels: ["spare/m"],
					modelRuntime,
					agentDir: join(directory, "stage-agent"),
					settingsManager: SettingsManager.inMemory({
						// No same-model retries: each candidate is spent at once, so no cooldown round waits.
						retry: { enabled: true, maxRetries: 0, baseDelayMs: 10 },
						compaction: { enabled: false },
					}),
					builtins: { workflows: false, subagents: true, intercom: false, mcp: false, "web-access": false },
					schema: Type.Object({ done: Type.Boolean() }),
				});
			} catch (error) {
				stageError = error;
			}
			return {};
		},
	});
	try {
		const result = await run(definition, {}, { cwd: directory, journal: { memory: true }, store: createStore() });
		return {
			result,
			stageError,
			childCalls,
			staleRejections: rejections.filter(isStaleExtensionContextError),
			safetyNetReported: consoleError.mock.calls.some((args) => String(args[0]).includes(SAFETY_NET_LOG)),
		};
	} finally {
		process.off("unhandledRejection", onRejection);
	}
}

test(
	"a background subagent outlives the stage session that model fallback retires, without a stale-context rejection (#3981)",
	async () => {
		// The replacement stays open until the child has moved on to its fallback model, or long enough to show it never
		// will.
		const fallbackReached = Promise.withResolvers<void>();
		const childProviders = new Set<string>();
		const run = await runStageThatLaunchesSubagents(
			{
				agent: "fallback-worker",
				task: "Inspect the fixture and report.",
				context: "fresh",
				output: false,
				progress: false,
				wait: { kind: "background" },
			},
			{
				onChildCall: (call) => {
					childProviders.add(call.provider);
					if (childProviders.size === 2) fallbackReached.resolve();
				},
				replacementHold: () => Promise.race([fallbackReached.promise, sleep(CHILD_BOUND_MS)]),
			},
		);

		assert.deepEqual(run.staleRejections, []);
		assert.equal(run.safetyNetReported, false, "the run boundary's stale-context safety net has nothing to report");
		// The stage's real failure stays the outcome.
		assert.equal(run.result.status, "completed", run.result.error);
		assert.match(String(run.stageError), /429/);
		// The child's own fallback walk reached its next model after its launching session was gone.
		const providers = run.childCalls.map((call) => call.provider);
		assert.ok(providers.includes("limited"), `child calls: ${providers.join(",")}`);
		assert.ok(providers.includes("spare"), `child calls: ${providers.join(",")}`);
	},
	REAL_SESSIONS_TIMEOUT_MS,
);

test(
	"a queued subagent that starts after model fallback retired its launching stage session still launches (#3981)",
	async () => {
		// One slot: the second child waits until the first ends, which is after its launching session is replaced. The
		// replacement stays open until the second child reaches its model, or long enough to show it never will.
		const secondReached = Promise.withResolvers<void>();
		const run = await runStageThatLaunchesSubagents(
			{
				tasks: [
					{ agent: "worker", task: "First queued fixture task." },
					{ agent: "worker", task: SECOND_TASK },
				],
				concurrency: 1,
				context: "fresh",
				output: false,
				progress: false,
				wait: { kind: "background" },
			},
			{
				onChildCall: (call) => {
					if (call.task.includes(SECOND_TASK)) secondReached.resolve();
				},
				replacementHold: () => Promise.race([secondReached.promise, sleep(CHILD_BOUND_MS)]),
			},
		);

		const tasks = run.childCalls.map((call) => call.task);
		assert.ok(
			tasks.some((task) => task.includes(SECOND_TASK)),
			`the queued child reached its model; child calls: ${JSON.stringify(tasks)}`,
		);
		assert.deepEqual(run.staleRejections, []);
		assert.equal(run.safetyNetReported, false);
		assert.equal(run.result.status, "completed", run.result.error);
		assert.match(String(run.stageError), /429/);
	},
	REAL_SESSIONS_TIMEOUT_MS,
);
