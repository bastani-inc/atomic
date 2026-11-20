/**
 * A forked subagent's first request is its parent's last request, byte for byte up to its end, followed by what the
 * child adds: a note, its own role and the task. So it is read from the parent's prompt cache. The child's tool and
 * context policy is enforced when it calls a tool, not by rewriting the parent's prefix. Real AgentSession, fork and
 * Anthropic request serialization against scripted replies; no network is contacted.
 */
import assert from "node:assert/strict";
import {
	type AssistantMessage,
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/atomic-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import type { AgentSessionInternalSurface } from "../../packages/coding-agent/src/core/agent-session-methods.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { Skill } from "../../packages/coding-agent/src/core/skills.js";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.js";
import { forkToolDeclarations } from "../../packages/coding-agent/src/core/transformed-system-prompt.js";
import { createCodemodeExtension } from "../../packages/coding-agent/src/extensions/codemode/index.js";
import { createTestExtensionsResult } from "../../packages/coding-agent/test/utilities.js";
import { createInProcessChildPromptBehavior } from "../../packages/subagents/src/runs/inprocess/prompt-behavior.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { wrapForkTask } from "../../packages/subagents/src/shared/types-runtime.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const PROVIDER = "fork-prompt-cache";
const NATIVE = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true };
/** Mid-conversation system messages, but tool changes only in the top-level list (as some proxies of the API). */
const FLAT_TOOLS = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: false };
const narrow = { inheritProjectContext: false, inheritSkills: false, fanoutAuthorized: false };
const inheriting = { inheritProjectContext: true, inheritSkills: true, fanoutAuthorized: false };
const DAY_ONE = new Date("2026-11-20T12:00:00");
const DAY_TWO = new Date("2026-11-21T12:00:00");

interface AnthropicPayload {
	model: string;
	tools?: unknown[];
	system?: unknown[];
	messages: { role: string; content: unknown }[];
}
interface Recorded {
	payload: AnthropicPayload;
	sessionId: string | undefined;
}
type Reply = (model: Model<"anthropic-messages">, count: number) => AssistantMessage;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function skill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/tmp/${name}/SKILL.md`, { source: "sdk" }),
		disableModelInvocation: false,
	};
}

function resourceLoader(
	systemPrompt: string | undefined,
	extensions?: Awaited<ReturnType<typeof createTestExtensionsResult>>,
): ResourceLoader {
	return {
		getExtensions: () => extensions ?? { extensions: [], errors: [], runtime: createExtensionRuntime() },
		getSkills: () => ({
			skills: [skill("parent-skill", "PARENT_SKILL_SENTINEL"), skill("subagent", "Delegate work to subagents.")],
			diagnostics: [],
		}),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [{ path: "AGENTS.md", content: "PROJECT_CONTEXT_SENTINEL" }] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: async () => {},
		reload: async () => {},
	};
}

function message(model: Model<"anthropic-messages">, content: AssistantMessage["content"]): AssistantMessage {
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
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

const textReply: Reply = (model, count) => message(model, [{ type: "text", text: `reply ${count}` }]);

/** Models of one provider whose requests the Anthropic transport serializes; `reply` scripts each answer. */
async function recordingRuntime(compat: object, reply: Reply = textReply) {
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	const model = (id: string): Model<"anthropic-messages"> => ({
		...base,
		id,
		provider: PROVIDER,
		compat: { ...base.compat, ...compat },
	});
	const parentModel = model("claude-sonnet-4-5");
	const otherModel = model("claude-opus-4-1");
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: Recorded[] = [];
	runtime.registerProvider(PROVIDER, {
		api: base.api,
		baseUrl: base.baseUrl,
		apiKey: "fixture-key",
		models: [parentModel, otherModel],
		streamSimple: (requestModel, context, options) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				let payload: AnthropicPayload | undefined;
				await anthropicMessagesApi()
					.streamSimple(requestModel, context, {
						...options,
						apiKey: "fixture-key",
						onPayload: (value) => {
							payload = value as AnthropicPayload;
							// Stop at the HTTP boundary: the serialized request is all this test needs.
							throw new Error("payload captured");
						},
					})
					.result();
				assert.ok(payload, "the request must be serialized");
				requests.push({ payload, sessionId: options?.sessionId });
				const answer = reply(requestModel as Model<"anthropic-messages">, requests.length);
				stream.push({
					type: "done",
					reason: answer.stopReason === "toolUse" ? "toolUse" : "stop",
					message: answer,
				});
				stream.end(answer);
			})();
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(PROVIDER));
	return { runtime, parentModel, otherModel, requests };
}

async function codemodeOnly() {
	return createTestExtensionsResult([
		{ path: "builtin:codemode", factory: createCodemodeExtension({ mode: "only" }) },
	]);
}

async function openParent(
	manager: SessionManager,
	runtime: ModelRuntime,
	model: Model<"anthropic-messages">,
	options: { tools?: string[]; codemodeOnly?: boolean } = {},
) {
	const cwd = manager.getCwd();
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		// Scripted replies carry no thinking blocks, so requests do not enable thinking.
		thinkingLevel: "off",
		modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager: manager,
		resourceLoader: resourceLoader(undefined, options.codemodeOnly ? await codemodeOnly() : undefined),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: options.tools ?? ["read", "bash", "edit"],
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** A forked child as the in-process runner opens it: the parent's session forked at its leaf. */
async function openFork(
	manager: SessionManager,
	runtime: ModelRuntime,
	model: Model<"anthropic-messages">,
	options: {
		tools?: string[];
		policy?: typeof narrow;
		codemodeOnly?: boolean;
		parentHiddenTools?: readonly string[];
	} = {},
) {
	const cwd = manager.getCwd();
	const policy = options.policy ?? narrow;
	const parentSessionId = manager.getHeader()?.parentSessionId;
	assert.ok(parentSessionId, "a fork's session names its parent");
	const behavior = createInProcessChildPromptBehavior(policy, '<skill name="checks">\nRun the checks.\n</skill>', {
		parentSessionId,
		parentHiddenTools: options.parentHiddenTools,
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		// Scripted replies carry no thinking blocks, so requests do not enable thinking.
		thinkingLevel: "off",
		modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager: manager,
		resourceLoader: resourceLoader("You review changes.", options.codemodeOnly ? await codemodeOnly() : undefined),
		subagentPolicy: { ...policy, managementActions: "restricted", depth: 1 },
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: options.tools ?? ["read"],
		...behavior,
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** The cacheable request in prefix order, without the cache markers that move to the newest message. */
function cachedPrefix(payload: AnthropicPayload): string[] {
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value)
					.filter(([key]) => key !== "cache_control")
					.map(([key, item]) => [key, strip(item)]),
			);
		}
		return value;
	};
	return [
		JSON.stringify(strip(payload.tools ?? [])),
		...(payload.system ?? []).map((block) => JSON.stringify(strip(block))),
		...payload.messages.flatMap((message) =>
			(typeof message.content === "string" ? [message.content] : (message.content as unknown[])).map((block) =>
				JSON.stringify([message.role, strip(block)]),
			),
		),
	];
}

function extendsRequest(before: AnthropicPayload, after: AnthropicPayload): boolean {
	const left = cachedPrefix(before);
	const right = cachedPrefix(after);
	return left.every((block, index) => right[index] === block);
}

function added(before: AnthropicPayload, after: AnthropicPayload): string {
	return cachedPrefix(after).slice(cachedPrefix(before).length).join("\n");
}

async function parentAndFork(compat: object, reply?: Reply, parentOptions?: Parameters<typeof openParent>[3]) {
	const dir = makeTempDirectory("atomic-fork-cache-");
	cleanups.push(() => removeTempDirectory(dir));
	const recorded = await recordingRuntime(compat, reply);
	const parentManager = SessionManager.inMemory(dir);
	const parent = await openParent(parentManager, recorded.runtime, recorded.parentModel, parentOptions);
	await parent.prompt("first parent task");
	await parent.prompt("second parent task");
	const forkManager = await createForkContextResolver(parentManager, "fork").sessionManagerForIndex(0);
	assert.ok(forkManager);
	// What the runner reads from the parent when it starts the child.
	const childOptions = (parent as unknown as AgentSessionInternalSurface)._childSessionOptions?.({});
	return { ...recorded, parentManager, forkManager, parentHiddenTools: childOptions?.parentHiddenTools };
}

describe("a forked subagent continues its parent's cached request", () => {
	for (const [mode, compat] of [
		["native tool changes", NATIVE],
		["top-level tools only", FLAT_TOOLS],
	] as const) {
		test(`its first request extends the parent's last one, with a narrower tool policy (${mode})`, async () => {
			const { runtime, parentModel, requests, parentManager, forkManager } = await parentAndFork(compat);
			const child = await openFork(forkManager, runtime, parentModel);
			await child.prompt(wrapForkTask("child task"));

			assert.equal(requests.length, 3);
			const [, parentLast, forkFirst] = requests;
			assert.ok(extendsRequest(parentLast.payload, forkFirst.payload), "the fork reuses the parent's whole request");
			assert.equal(forkFirst.payload.model, parentLast.payload.model);
			assert.equal(forkFirst.sessionId, parentManager.getSessionId(), "the fork keeps the parent's cache key");
			const appended = added(parentLast.payload, forkFirst.payload);
			assert.match(appended, /You are now a subagent started from the conversation above/);
			assert.match(appended, /You are a child subagent, not the parent orchestrator/);
			assert.match(appended, /Run the checks/);
			assert.match(appended, /child task/);
			assert.doesNotMatch(appended, /Removed system prompt section/);
			if (compat === NATIVE) assert.match(appended, /tool_removal/);
			else assert.equal(cachedPrefix(forkFirst.payload)[0], cachedPrefix(parentLast.payload)[0]);
		});
	}

	test("declares a tool only it has after the parent's request, or changes the tool list where it cannot", async () => {
		for (const compat of [NATIVE, FLAT_TOOLS]) {
			const { runtime, parentModel, requests, forkManager } = await parentAndFork(compat);
			const child = await openFork(forkManager, runtime, parentModel, { tools: ["read", "todo"] });
			await child.prompt(wrapForkTask("child task"));

			const [, parentLast, forkFirst] = requests.map((request) => request.payload);
			if (compat === NATIVE) {
				assert.ok(extendsRequest(parentLast, forkFirst));
				assert.match(added(parentLast, forkFirst), /tool_addition[\s\S]*"name":"todo"/);
			} else {
				assert.notEqual(cachedPrefix(forkFirst)[0], cachedPrefix(parentLast)[0]);
				assert.deepEqual(
					cachedPrefix(forkFirst).slice(1, cachedPrefix(parentLast).length),
					cachedPrefix(parentLast).slice(1),
				);
			}
		}
	});

	test("keeps the project context and skills its parent was sent, whatever its own inheritance", async () => {
		const { runtime, parentModel, requests, forkManager } = await parentAndFork(NATIVE);
		const child = await openFork(forkManager, runtime, parentModel, { policy: inheriting });
		await child.prompt(wrapForkTask("child task"));

		const [, parentLast, forkFirst] = requests.map((request) => request.payload);
		assert.ok(extendsRequest(parentLast, forkFirst));
		assert.match(JSON.stringify(forkFirst.system), /PROJECT_CONTEXT_SENTINEL[\s\S]*PARENT_SKILL_SENTINEL/);
		assert.doesNotMatch(added(parentLast, forkFirst), /section \\"(project_context|skills)\\"/);
	});

	test("sends the parent's tool list as the parent did when the parent's codemode hides its other tools", async () => {
		for (const compat of [NATIVE, FLAT_TOOLS]) {
			const { runtime, parentModel, requests, forkManager, parentHiddenTools } = await parentAndFork(
				compat,
				undefined,
				{
					tools: ["read", "bash", "codemode"],
					codemodeOnly: true,
				},
			);
			assert.deepEqual([...(parentHiddenTools ?? [])].sort(), ["bash", "read"]);
			const child = await openFork(forkManager, runtime, parentModel, {
				tools: ["read", "codemode"],
				codemodeOnly: true,
				parentHiddenTools,
			});
			await child.prompt(wrapForkTask("child task"));

			const [, parentLast, forkFirst] = requests.map((request) => request.payload);
			assert.ok(extendsRequest(parentLast, forkFirst), "the fork declares the tools the parent declared");
			assert.doesNotMatch(added(parentLast, forkFirst), /"name":"bash"/);
		}
	});

	test("refuses a call to a parent tool outside its policy", async () => {
		const reply: Reply = (model, count) =>
			count === 3
				? message(model, [
						{ type: "toolCall", id: "call_edit", name: "edit", arguments: { path: "x", edits: [] } },
						{ type: "toolCall", id: "call_subagent", name: "subagent", arguments: {} },
					])
				: textReply(model, count);
		const { runtime, parentModel, forkManager } = await parentAndFork(FLAT_TOOLS, reply);
		const child = await openFork(forkManager, runtime, parentModel);
		await child.prompt(wrapForkTask("child task"));

		const results = child.messages.filter((entry) => entry.role === "toolResult");
		assert.deepEqual(
			results.map((result) => [result.toolName, result.isError]),
			[
				["edit", true],
				["subagent", true],
			],
		);
		for (const result of results)
			assert.match(JSON.stringify(result.content), /is not available to this session\. It may call: read/);
	});

	test("on another model it still sends the parent's conversation, as its own request", async () => {
		const { runtime, otherModel, requests, forkManager } = await parentAndFork(NATIVE);
		const child = await openFork(forkManager, runtime, otherModel);
		await child.prompt(wrapForkTask("child task"));

		const [, parentLast, forkFirst] = requests;
		assert.notEqual(forkFirst.payload.model, parentLast.payload.model);
		assert.deepEqual(
			cachedPrefix(forkFirst.payload).slice(1, cachedPrefix(parentLast.payload).length),
			cachedPrefix(parentLast.payload).slice(1),
		);
	});

	test("a fork reopened the next day keeps its prefix; under another policy it sends its own prompt without the parent's", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(DAY_ONE);
		const { runtime, parentModel, requests, forkManager } = await parentAndFork(NATIVE);
		const child = await openFork(forkManager, runtime, parentModel);
		await child.prompt(wrapForkTask("child task"));
		await child.dispose();
		const reopen = () => SessionManager.open(forkManager.getSessionStore(), forkManager.getSessionId());
		vi.setSystemTime(DAY_TWO);

		const reopened = await openFork(await reopen(), runtime, parentModel);
		await reopened.prompt("follow-up");
		await reopened.dispose();
		const narrowed = await openFork(await reopen(), runtime, parentModel, {
			policy: { ...narrow, fanoutAuthorized: true },
		});
		await narrowed.prompt("another follow-up");

		const [, , forkFirst, forkSecond, afterPolicy] = requests.map((request) => request.payload);
		assert.ok(extendsRequest(forkFirst, forkSecond), "a reopened fork reuses its whole request");
		assert.match(added(forkFirst, forkSecond), /2026-11-21/);
		assert.doesNotMatch(JSON.stringify(afterPolicy.system), /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
		assert.match(JSON.stringify(afterPolicy.system), /explicit fanout responsibility/);
	});
});

describe("which tools a fork declares", () => {
	const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
	const inherited = [tool("read"), tool("bash"), tool("codemode")];

	test("keeps the parent's tools, declares a removal only where changes are declared in place", () => {
		for (const support of ["none", "additions", "changes"] as const) {
			const { keepRemoval, keepAddition } = forkToolDeclarations(inherited, support, false);
			assert.equal(keepRemoval("bash"), support === "changes");
			assert.equal(keepAddition(tool("read") as never), false);
		}
	});

	test("reaches a tool only the fork has through the parent's codemode where the transport cannot add it", () => {
		assert.equal(forkToolDeclarations(inherited, "none", true).throughCodemode, true);
		assert.equal(forkToolDeclarations(inherited, "none", true).keepAddition(tool("todo") as never), false);
		assert.equal(forkToolDeclarations(inherited, "none", false).keepAddition(tool("todo") as never), true);
		assert.equal(forkToolDeclarations(inherited, "additions", true).keepAddition(tool("todo") as never), true);
		assert.equal(forkToolDeclarations([tool("read")], "none", true).throughCodemode, false);
	});
});
