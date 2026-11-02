/**
 * A subagent launched on an explicit model never moves to another model the launch did not opt into, whatever ends
 * the model's turn (#4188). Real in-process runner and AgentSession against local providers; no network is
 * contacted. Two providers stand in for two accounts: each offers the requested model, and the second also offers a
 * model of another family, which is the parent's model and the settings `fallbackModels` entry.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSystemMessageText } from "@bastani/pi-ai";
import { type AssistantMessage, createAssistantMessageEventStream, getModel, type Model } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { AuthStorage, ModelRuntime } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { ModelConstraints } from "../../packages/subagents/src/shared/model-constraints.js";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.js";

/** Each case builds a real parent AgentSession and a real child AgentSession with its resource loader. */
const REAL_CHILD_SESSION_TIMEOUT_MS = 90_000;

const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
/** The requested model, offered by both accounts. */
const REQUESTED = `${ACCOUNT_A}/argon`;
const REQUESTED_ON_B = `${ACCOUNT_B}/argon`;
/** Another family on the second account: the parent's model and the settings fallback. */
const OTHER_FAMILY = `${ACCOUNT_B}/opus`;
/** A model on the first account that a constraint may allow. */
const ALLOWED_OTHER = `${ACCOUNT_A}/sol`;

const UNAVAILABLE = "503 Service Unavailable: the model is overloaded";
const OVERFLOW = "The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).";

/** How the requested model on the first account ends its turns. */
type Trigger = "startup-error" | "mid-session-error" | "context-overflow";

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

function worker(cwd: string, fallbackModels?: string[]): AgentConfig {
	return {
		name: "worker",
		description: "fallback fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
		...(fallbackModels ? { fallbackModels } : {}),
	};
}

interface FixtureOptions {
	readonly trigger: Trigger;
	/** The parent session's own model; the requested model makes the parent's model add no candidate. */
	readonly parentModel?: string;
	/** Whether the launch knows the parent's model, as one launched from a session without a model does not. */
	readonly parentModelOffered?: boolean;
	/** The launch's `model`; `null` launches without one, so the child runs the parent's model. */
	readonly launchModel?: string | null;
	/** The worker agent's own `fallbackModels`, the launch's opt-in to other models. */
	readonly agentFallbackModels?: string[];
	/** The launch's `modelConstraints`. */
	readonly modelConstraints?: ModelConstraints;
}
interface ProviderRequest {
	readonly model: string;
	readonly systemPrompt: string;
}

async function fixture(options: FixtureOptions) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-explicit-fallback-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "notes.txt"), "notes\n");
	const base: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		reasoning: true,
		contextWindow: 1_048_576,
	};
	const model = (provider: string, id: string, name: string): Model<"anthropic-messages"> => ({
		...base,
		provider,
		id,
		name,
	});
	const catalogs = {
		[ACCOUNT_A]: [model(ACCOUNT_A, "argon", "Argon 4"), model(ACCOUNT_A, "sol", "Sol 6")],
		[ACCOUNT_B]: [model(ACCOUNT_B, "argon", "Argon 4"), model(ACCOUNT_B, "opus", "Opus 5")],
	};
	const catalog = [...catalogs[ACCOUNT_A], ...catalogs[ACCOUNT_B]];
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: ProviderRequest[] = [];
	for (const [provider, models] of Object.entries(catalogs)) {
		runtime.registerProvider(provider, {
			api: base.api,
			baseUrl: base.baseUrl,
			apiKey: `${provider}-key`,
			models,
			streamSimple: (requestModel, context) => {
				const fullId = `${requestModel.provider}/${requestModel.id}`;
				const requested = requests.filter((request) => request.model === fullId).length;
				requests.push({
					model: fullId,
					systemPrompt: context.messages
						.flatMap((message) => (message.role === "system" ? [getSystemMessageText(message)] : []))
						.join("\n"),
				});
				const stream = createAssistantMessageEventStream();
				const failure =
					fullId !== REQUESTED
						? undefined
						: options.trigger === "startup-error"
							? UNAVAILABLE
							: options.trigger === "context-overflow"
								? OVERFLOW
								: requested === 0
									? undefined
									: UNAVAILABLE;
				const toolCall = fullId === REQUESTED && options.trigger === "mid-session-error" && requested === 0;
				const message: AssistantMessage = {
					role: "assistant",
					content: failure
						? []
						: toolCall
							? [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.txt" } }]
							: [{ type: "text", text: `done on ${fullId}` }],
					api: base.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: usage(),
					stopReason: failure ? "error" : toolCall ? "toolUse" : "stop",
					...(failure ? { errorMessage: failure } : {}),
					timestamp: Date.now(),
				};
				if (failure) stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message });
				stream.end(message);
				return stream;
			},
		});
		cleanups.push(() => runtime.unregisterProvider(provider));
	}
	const find = (fullId: string) => catalog.find((entry) => `${entry.provider}/${entry.id}` === fullId)!;
	const parentModel = find(options.parentModel ?? OTHER_FAMILY);
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		model: parentModel,
		thinkingLevel: "medium",
		settingsManager: SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
			defaultThinkingLevel: "medium",
			fallbackModels: [OTHER_FAMILY],
		}),
		sessionManager: await SessionManager.create(cwd, join(cwd, "parent-sessions")),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => {
		parent.dispose();
		clearSubagentControls();
	});
	const resolve = createCandidateModelResolver({
		getAvailable: () => catalog,
		find: (provider, id) => catalog.find((entry) => entry.provider === provider && entry.id === id),
		hasConfiguredAuth: () => true,
	});
	const launch = (runId: string) =>
		runSingleInProcess(cwd, worker(cwd, options.agentFallbackModels), "reply done", {
			cwd,
			runId,
			index: 0,
			sessionDir: join(cwd, "children"),
			testSession: false,
			...(options.launchModel === null ? {} : { modelOverride: options.launchModel ?? `${REQUESTED}:high` }),
			...(options.modelConstraints ? { modelConstraints: options.modelConstraints } : {}),
			knownModelProviders: [ACCOUNT_A, ACCOUNT_B],
			...(options.parentModelOffered === false ? {} : { currentModel: `${parentModel.provider}/${parentModel.id}` }),
			currentThinkingLevel: "medium",
			availableModels: catalog.map((entry) => ({
				provider: entry.provider,
				id: entry.id,
				fullId: `${entry.provider}/${entry.id}`,
			})),
			resolveCandidateModel: resolve,
			getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
		});
	return { launch, requests };
}

for (const trigger of ["startup-error", "mid-session-error", "context-overflow"] as const) {
	test(
		`an explicit model ended by a ${trigger} fails naming the model instead of running the parent's or settings fallback model`,
		async () => {
			const { launch, requests } = await fixture({ trigger });
			const result = await launch(`explicit-${trigger}`);

			assert.deepEqual(
				[...new Set(requests.map((request) => request.model))],
				[REQUESTED],
				"only the requested model is asked",
			);
			assert.equal(result.status, "error", JSON.stringify(result));
			assert.equal(result.model, REQUESTED);
			const reason = trigger === "context-overflow" ? OVERFLOW : UNAVAILABLE;
			assert.ok(result.error?.includes(`${REQUESTED}:high`), result.error);
			assert.ok(result.error?.includes(reason), result.error);
			assert.match(result.error ?? "", /No other model was used/);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);
}

test(
	"an explicit model never takes up the settings fallbackModels chain when the parent's model adds no candidate",
	async () => {
		const { launch, requests } = await fixture({ trigger: "startup-error", parentModelOffered: false });
		const result = await launch("explicit-settings-chain");

		assert.deepEqual([...new Set(requests.map((request) => request.model))], [REQUESTED]);
		assert.equal(result.status, "error", JSON.stringify(result));
		assert.match(result.error ?? "", /No other model was used/);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"an explicit model moves only to its agent's fallbacks that modelConstraints allow, and reports and tells the child the model it ran on",
	async () => {
		const { launch, requests } = await fixture({
			trigger: "startup-error",
			agentFallbackModels: [OTHER_FAMILY, ALLOWED_OTHER],
			modelConstraints: { allowedModels: [REQUESTED, REQUESTED_ON_B, ALLOWED_OTHER] },
		});
		const result = await launch("explicit-constrained-chain");

		assert.deepEqual(
			requests.map((request) => request.model),
			[REQUESTED, ALLOWED_OTHER],
			"the disallowed fallback is skipped",
		);
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(result.model, ALLOWED_OTHER);
		assert.equal(result.requestedModel, `${REQUESTED}:high`);
		assert.deepEqual(result.attemptedModels, [REQUESTED, ALLOWED_OTHER]);
		const fallbackPrompt = requests.at(-1)!.systemPrompt;
		assert.match(fallbackPrompt, /Model name \(used for commit attribution\): Sol 6/);
		assert.doesNotMatch(fallbackPrompt, /Argon 4/);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a launch that names no model keeps the settings fallbackModels chain only within its modelConstraints",
	async () => {
		const { launch, requests } = await fixture({
			trigger: "startup-error",
			parentModel: REQUESTED,
			launchModel: null,
			modelConstraints: { allowedModels: [REQUESTED, REQUESTED_ON_B] },
		});
		const result = await launch("inherited-constrained-settings-chain");

		assert.deepEqual([...new Set(requests.map((request) => request.model))], [REQUESTED]);
		assert.equal(result.status, "error", JSON.stringify(result));
		assert.ok(result.error?.includes(UNAVAILABLE), result.error);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);
