/**
 * A subagent launched on an explicit model never moves to another model the launch did not opt into, whatever ends
 * the model's turn (#4188). Real in-process runner and AgentSession against local providers; no network is
 * contacted. Two providers stand in for two accounts: each offers the requested model, and the second also offers a
 * model of another family, which is the parent's model and the settings `fallbackModels` entry.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools, getSystemMessageText } from "@bastani/pi-ai";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { AuthStorage, ModelRuntime } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { inspectInProcessChildStatus } from "../../packages/subagents/src/runs/inprocess/control-status.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
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
type Trigger =
	| "none"
	/** Every model fails at once. */
	| "all-fail"
	| "startup-error"
	| "mid-session-error"
	| "context-overflow"
	/** As mid-session-error, and the fallback model reads the same file once more before it answers. */
	| "mid-session-error-tools";

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

/** The parent's own request, which a forked child inherits as reference-only history. */
const PARENT_TASK = "PARENT TASK: coordinate every child and resume the other tasks.";
/** The child's own role prompt, which every model it runs on must get. */
const CHILD_ROLE =
	"ROLE: you are the isolated fallback-fixture child. Work only on your own task, and only inside your own working directory; never act as the parent.";
/** The child's task, which names its file by a path relative to its own directory. */
const CHILD_TASK = "Read notes.txt in your working directory, then reply done.";
/** What `notes.txt` holds in the parent's directory and in the child's, so a read shows whose directory it ran in. */
const PARENT_SENTINEL = "PARENT SENTINEL";
const CHILD_SENTINEL = "CHILD SENTINEL";

function worker(cwd: string, fallbackModels?: string[], modelConstraints?: ModelConstraints): AgentConfig {
	return {
		name: "worker",
		description: "fallback fixture",
		systemPrompt: CHILD_ROLE,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
		...(fallbackModels ? { fallbackModels } : {}),
		...(modelConstraints ? { modelConstraints } : {}),
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
	/** Launch with `context: "fork"` from a parent that already ran a turn of its own. */
	readonly forkFromParent?: boolean;
	/** The models the parent session's own fallback gate allows, which its children inherit. */
	readonly parentAllowsOnly?: readonly string[];
	/** The model the original launch asked for, when this launch continues it on another one, as a restore does. */
	readonly requestedModel?: string;
	/** The worker agent's own `modelConstraints`. */
	readonly agentModelConstraints?: ModelConstraints;
	/** Launch without a candidate resolver, as a host on the lower-level API may. */
	readonly noResolver?: boolean;
	/** Run the child in a directory of its own, and give the parent a tool the child does not have. */
	readonly childWorkspace?: boolean;
	/** The provider bare model names resolve against, as the parent's provider is. */
	readonly preferredProvider?: string;
}

/** A provider the registry knows but has no auth for, so a launch on it starts on its first fallback. */
const LOCKED_ACCOUNT = "account-locked";
interface ProviderRequest {
	readonly model: string;
	readonly systemPrompt: string;
	readonly tools: readonly string[];
	/** Whether the request's history holds the parent's own request, as a forked child's does. */
	readonly inheritsParentHistory: boolean;
	/** The text of every tool result in the request's history. */
	readonly toolResults: readonly string[];
}

async function fixture(options: FixtureOptions) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-explicit-fallback-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "notes.txt"), `${PARENT_SENTINEL}\n`);
	const childCwd = options.childWorkspace ? join(cwd, "child-workspace") : cwd;
	if (options.childWorkspace) {
		mkdirSync(childCwd);
		writeFileSync(join(childCwd, "notes.txt"), `${CHILD_SENTINEL}\n`);
	}
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
					tools: getCurrentTools(context.messages).map((tool) => tool.name),
					inheritsParentHistory: context.messages.some(
						(message) => message.role === "user" && JSON.stringify(message.content).includes(PARENT_TASK),
					),
					toolResults: context.messages.flatMap((message) =>
						message.role === "toolResult"
							? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")]
							: [],
					),
				});
				const stream = createAssistantMessageEventStream();
				const midSession = options.trigger === "mid-session-error" || options.trigger === "mid-session-error-tools";
				const failure =
					options.trigger === "all-fail"
						? UNAVAILABLE
						: fullId !== REQUESTED || options.trigger === "none"
							? undefined
							: options.trigger === "startup-error"
								? UNAVAILABLE
								: options.trigger === "context-overflow"
									? OVERFLOW
									: requested === 0
										? undefined
										: UNAVAILABLE;
				const toolCall =
					requested === 0 &&
					((fullId === REQUESTED && midSession) ||
						(fullId === ALLOWED_OTHER && options.trigger === "mid-session-error-tools"));
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
	const parentSessions = await SessionManager.create(cwd, join(cwd, "parent-sessions"));
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
		sessionManager: parentSessions,
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: options.childWorkspace ? ["read", "bash"] : ["read"],
		...(options.parentAllowsOnly
			? {
					isFallbackModelAllowed: (model: Model<Api>) =>
						options.parentAllowsOnly!.includes(`${model.provider}/${model.id}`),
				}
			: {}),
	});
	cleanups.push(() => {
		parent.dispose();
		clearSubagentControls();
	});
	let forked: SessionManager | undefined;
	if (options.forkFromParent) {
		await parent.prompt(PARENT_TASK);
		requests.length = 0;
		forked = await createForkContextResolver(parentSessions, "fork").sessionManagerForIndex(0);
	}
	const resolve = createCandidateModelResolver(
		{
			getAvailable: () => catalog,
			find: (provider, id) => catalog.find((entry) => entry.provider === provider && entry.id === id),
			hasConfiguredAuth: () => true,
		},
		options.preferredProvider,
	);
	const launch = (runId: string) =>
		runSingleInProcess(cwd, worker(cwd, options.agentFallbackModels, options.agentModelConstraints), CHILD_TASK, {
			cwd: childCwd,
			...(options.requestedModel ? { requestedModel: options.requestedModel } : {}),
			...(options.preferredProvider ? { preferredModelProvider: options.preferredProvider } : {}),
			runId,
			index: 0,
			sessionDir: join(cwd, "children"),
			testSession: false,
			...(forked ? { sessionManager: forked } : {}),
			...(options.launchModel === null ? {} : { modelOverride: options.launchModel ?? `${REQUESTED}:high` }),
			...(options.modelConstraints ? { modelConstraints: options.modelConstraints } : {}),
			knownModelProviders: [ACCOUNT_A, ACCOUNT_B, LOCKED_ACCOUNT],
			...(options.parentModelOffered === false ? {} : { currentModel: `${parentModel.provider}/${parentModel.id}` }),
			currentThinkingLevel: "medium",
			availableModels: catalog.map((entry) => ({
				provider: entry.provider,
				id: entry.id,
				fullId: `${entry.provider}/${entry.id}`,
			})),
			...(options.noResolver ? {} : { resolveCandidateModel: resolve }),
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
		// Run status, by the run and by the child, says it too.
		const ranOn = "ran on account-a/sol  high, not the requested account-a/argon  high";
		const runStatus = inspectInProcessChildStatus("explicit-constrained-chain");
		assert.ok(JSON.stringify(runStatus?.content).includes(ranOn), JSON.stringify(runStatus?.content));
		const childStatus = inspectInProcessChildStatus("explicit-constrained-chain:0");
		assert.ok(JSON.stringify(childStatus?.content).includes(ranOn), JSON.stringify(childStatus?.content));
		assert.equal(
			runStatus?.details?.statusGroups?.[0]?.children[0]?.requestedModel,
			`${REQUESTED}:high`,
			JSON.stringify(runStatus?.details?.statusGroups),
		);
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

test(
	"a named model that is not in its provider's catalog fails before launch instead of running the parent's model",
	async () => {
		const { launch, requests } = await fixture({
			trigger: "startup-error",
			launchModel: `${ACCOUNT_A}/missing:high`,
		});
		const result = await launch("named-missing-model");

		assert.deepEqual(requests, [], "no model is asked, the parent's included");
		assert.equal(result.status, "error", JSON.stringify(result));
		assert.match(result.error ?? "", /account-a\/missing:high is not available/);
		assert.match(result.error ?? "", /No other model was used/);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a launch that names no model never starts on an agent fallback its modelConstraints exclude",
	async () => {
		const { launch, requests } = await fixture({
			trigger: "startup-error",
			parentModel: REQUESTED,
			launchModel: null,
			agentFallbackModels: [OTHER_FAMILY],
			modelConstraints: { allowedModels: [REQUESTED, REQUESTED_ON_B] },
		});
		const result = await launch("inherited-excluded-first-fallback");

		assert.deepEqual([...new Set(requests.map((request) => request.model))], [REQUESTED]);
		assert.equal(result.status, "error", JSON.stringify(result));
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a fallback that starts in place of an unavailable named model must meet modelConstraints at the effort it would run at",
	async () => {
		const { launch, requests } = await fixture({
			trigger: "startup-error",
			launchModel: `${LOCKED_ACCOUNT}/argon:low`,
			agentFallbackModels: [ALLOWED_OTHER],
			modelConstraints: { allowedEfforts: ["high"] },
		});
		const result = await launch("promoted-fallback-effort");

		assert.deepEqual(requests, [], "the promoted fallback would run at low, which the constraints forbid");
		assert.equal(result.status, "error", JSON.stringify(result));
		assert.match(result.error ?? "", /modelConstraints/);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

for (const forkFromParent of [false, true]) {
	test(
		`a ${forkFromParent ? "forked" : "fresh"} child that falls back partway through its task to an allowed model keeps its own prompt, role and tools, with the new model's name`,
		async () => {
			const { launch, requests } = await fixture({
				trigger: "mid-session-error",
				agentFallbackModels: [ALLOWED_OTHER],
				modelConstraints: { allowedModels: [REQUESTED, ALLOWED_OTHER] },
				forkFromParent,
			});
			const result = await launch(`mid-session-allowed-fallback-${forkFromParent ? "fork" : "fresh"}`);

			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.deepEqual(
				requests.map((request) => request.model),
				[REQUESTED, REQUESTED, ALLOWED_OTHER],
				"a tool turn on the requested model, its failure, then the allowed fallback",
			);
			const [before, , after] = requests as [ProviderRequest, ProviderRequest, ProviderRequest];
			assert.ok(before.systemPrompt.includes(CHILD_ROLE), before.systemPrompt);
			assert.equal(
				after.systemPrompt,
				before.systemPrompt.replace(
					"Model name (used for commit attribution): Argon 4",
					"Model name (used for commit attribution): Sol 6",
				),
				"the same child prompt, with only the model it runs on changed",
			);
			assert.deepEqual(after.tools, before.tools, "the same tools");
			assert.deepEqual(before.tools, ["read"]);
			assert.doesNotMatch(after.systemPrompt, /PARENT TASK/);
			assert.equal(before.inheritsParentHistory, forkFromParent);
			assert.equal(after.inheritsParentHistory, forkFromParent);
			assert.equal(result.model, ALLOWED_OTHER);
			assert.equal(result.requestedModel, `${REQUESTED}:high`);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);
}

test(
	"a fallback promoted in place of an unavailable named model must also meet the gate its parent session hands down",
	async () => {
		const { launch, requests } = await fixture({
			trigger: "none",
			launchModel: `${LOCKED_ACCOUNT}/argon:high`,
			agentFallbackModels: [OTHER_FAMILY],
			modelConstraints: { allowedModels: [REQUESTED, OTHER_FAMILY] },
			parentAllowsOnly: [REQUESTED],
		});
		const result = await launch("promoted-fallback-parent-gate");

		assert.deepEqual(requests, [], "the parent's gate forbids the promoted fallback");
		assert.equal(result.status, "error", JSON.stringify(result));
		assert.match(result.error ?? "", /No other model was used/);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child continued on a fallback that its agent's constraints no longer allow resumes on the model its launch named",
	async () => {
		const { launch, requests } = await fixture({
			trigger: "none",
			// As a restored child that had moved from argon to sol before its agent was narrowed to argon.
			launchModel: `${ALLOWED_OTHER}:medium`,
			requestedModel: `${REQUESTED}:high`,
			agentModelConstraints: { allowedModels: [REQUESTED] },
		});
		const result = await launch("resumed-fallback-narrowed");

		assert.deepEqual(
			requests.map((request) => request.model),
			[REQUESTED],
		);
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(result.model, REQUESTED);
		assert.equal(result.requestedModel, `${REQUESTED}:high`);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a named launch without a candidate resolver fails instead of starting on the parent's model",
	async () => {
		const { launch, requests } = await fixture({ trigger: "none", noResolver: true });
		const result = await launch("named-no-resolver");

		assert.deepEqual(requests, [], "no model is asked, the parent's included");
		assert.equal(result.status, "error", JSON.stringify(result));
		assert.match(result.error ?? "", /account-a\/argon:high/);
		assert.match(result.error ?? "", /No other model was used/);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"after a fallback partway through its task, a child in its own directory keeps its tools and reads its own files",
	async () => {
		const { launch, requests } = await fixture({
			trigger: "mid-session-error-tools",
			agentFallbackModels: [ALLOWED_OTHER],
			modelConstraints: { allowedModels: [REQUESTED, ALLOWED_OTHER] },
			childWorkspace: true,
		});
		const result = await launch("mid-session-fallback-own-directory");

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.deepEqual(
			requests.map((request) => request.model),
			[REQUESTED, REQUESTED, ALLOWED_OTHER, ALLOWED_OTHER],
			"a read on the requested model, its failure, then a read and the answer on the fallback",
		);
		for (const request of requests) {
			assert.deepEqual(request.tools, ["read"], "only the child's own tools, never the parent's bash");
			assert.ok(request.systemPrompt.includes(CHILD_ROLE), request.systemPrompt);
		}
		const afterFallbackRead = requests[3]!.toolResults;
		assert.equal(afterFallbackRead.length, 2, "both reads, the one before the fallback and the one after");
		for (const read of afterFallbackRead) {
			assert.match(read, new RegExp(CHILD_SENTINEL));
			assert.doesNotMatch(read, new RegExp(PARENT_SENTINEL));
		}
		assert.equal(
			requests[2]!.systemPrompt,
			requests[0]!.systemPrompt.replace(
				"Model name (used for commit attribution): Argon 4",
				"Model name (used for commit attribution): Sol 6",
			),
		);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a failed named model given by its bare name is reported as the model that ran, not as a fallback",
	async () => {
		const { launch } = await fixture({
			trigger: "startup-error",
			launchModel: "argon:high",
			preferredProvider: ACCOUNT_A,
		});
		const result = await launch("bare-named-failure");

		assert.equal(result.status, "error", JSON.stringify(result));
		assert.ok(result.error?.startsWith(`Model argon:high failed: ${UNAVAILABLE}`), result.error);
		assert.doesNotMatch(result.error ?? "", /continued on|fallbacks/);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child continued on a fallback says which models failed in place of the one its launch named",
	async () => {
		const { launch, requests } = await fixture({
			trigger: "all-fail",
			launchModel: `${ALLOWED_OTHER}:medium`,
			requestedModel: `${REQUESTED}:high`,
		});
		const result = await launch("continued-fallback-failure");

		assert.deepEqual(
			requests.map((request) => request.model),
			[ALLOWED_OTHER, REQUESTED],
		);
		assert.equal(result.status, "error", JSON.stringify(result));
		assert.ok(
			result.error?.startsWith(
				`This child continued on ${ALLOWED_OTHER} in place of ${REQUESTED}:high; ${ALLOWED_OTHER}, ${REQUESTED} failed: ${UNAVAILABLE}`,
			),
			result.error,
		);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);
