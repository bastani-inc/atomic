/**
 * A forked subagent's first request is its parent's last request, byte for byte up to its end, followed by what the
 * child adds: a note, its own role and the task. So it is read from the parent's prompt cache. The child's tool and
 * context policy is enforced when it calls a tool, not by rewriting the parent's prefix. Real AgentSession, fork and
 * Anthropic request serialization against scripted replies; no network is contacted.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import type { AgentSessionInternalSurface } from "../../packages/coding-agent/src/core/agent-session-methods.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { Skill } from "../../packages/coding-agent/src/core/skills.js";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.js";
import { forkToolDeclarations } from "../../packages/coding-agent/src/core/transformed-system-prompt.js";
import { createCodemodeExtension } from "../../packages/coding-agent/src/extensions/codemode/index.js";
import { createTestExtensionsResult } from "../../packages/coding-agent/test/utilities.js";
import {
	createInProcessChildPromptBehavior,
	createInProcessChildSystemPromptTransform,
	forkedChildTools,
	forkedParentSessionId,
} from "../../packages/subagents/src/runs/inprocess/prompt-behavior.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
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

type Codemode = "only" | "direct";

async function codemode(mode: Codemode | undefined) {
	if (mode === undefined) return undefined;
	return createTestExtensionsResult([
		{ path: "builtin:codemode", factory: createCodemodeExtension(mode === "only" ? { mode: "only" } : {}) },
	]);
}

async function openParent(
	manager: SessionManager,
	runtime: ModelRuntime,
	model: Model<"anthropic-messages">,
	options: { tools?: string[]; codemode?: Codemode } = {},
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
		resourceLoader: resourceLoader(undefined, await codemode(options.codemode)),
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
		codemode?: Codemode;
		parentHiddenTools?: readonly string[];
		customTools?: CreateAgentSessionOptions["customTools"];
		codemodeRoutingOnly?: boolean;
		/** The parent the runner found the session continues (`forkedParentSessionId`); by default its header's. */
		forkedFrom?: string;
	} = {},
) {
	const cwd = manager.getCwd();
	const policy = options.policy ?? narrow;
	const parentSessionId = "forkedFrom" in options ? options.forkedFrom : manager.getHeader()?.parentSessionId;
	const behavior = createInProcessChildPromptBehavior(
		policy,
		'<skill name="checks">\nRun the checks.\n</skill>',
		parentSessionId === undefined ? undefined : { parentSessionId, parentHiddenTools: options.parentHiddenTools },
	);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		// Scripted replies carry no thinking blocks, so requests do not enable thinking.
		thinkingLevel: "off",
		modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager: manager,
		resourceLoader: resourceLoader("You review changes.", await codemode(options.codemode)),
		subagentPolicy: {
			...policy,
			managementActions: "restricted",
			depth: 1,
			...(options.codemodeRoutingOnly ? { codemodeRoutingOnly: true } : {}),
		},
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: options.tools ?? ["read"],
		...(options.customTools ? { customTools: options.customTools } : {}),
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

/**
 * A parent with two settled turns and a fork of it, made as the subagent tool makes one. `madeByEarlierVersion` makes
 * it as an earlier version did, with nothing recording where the copied history ends; `clockFromParentReply` makes it
 * while the clock reads that many milliseconds after the parent's last reply was stamped (0: the same millisecond;
 * negative: after the clock stepped back).
 */
async function parentAndFork(
	compat: object,
	reply?: Reply,
	parentOptions?: Parameters<typeof openParent>[3],
	fork: { readonly madeByEarlierVersion?: boolean; readonly clockFromParentReply?: number } = {},
) {
	const dir = makeTempDirectory("atomic-fork-cache-");
	cleanups.push(() => removeTempDirectory(dir));
	const recorded = await recordingRuntime(compat, reply);
	const parentManager = SessionManager.inMemory(dir);
	const parent = await openParent(parentManager, recorded.runtime, recorded.parentModel, parentOptions);
	await parent.prompt("first parent task");
	await parent.prompt("second parent task");
	const lastReply = parentManager
		.getBranch()
		.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
	assert.ok(lastReply?.type === "message");
	const clock = fork.clockFromParentReply;
	if (clock !== undefined) vi.useFakeTimers({ toFake: ["Date"], now: lastReply.message.timestamp + clock });
	const forkManager = await (fork.madeByEarlierVersion
		? parentManager.captureFork(parentManager.getLeafId()!)()
		: createForkContextResolver(parentManager, "fork").sessionManagerForIndex(0)
	).finally(() => vi.useRealTimers());
	assert.ok(forkManager);
	if (clock !== undefined) {
		assert.equal(Date.parse(forkManager.getHeader()!.createdAt), lastReply.message.timestamp + clock);
	}
	// What the runner reads from the parent when it starts the child.
	const childOptions = (parent as unknown as AgentSessionInternalSurface)._childSessionOptions?.({});
	return {
		...recorded,
		parentManager,
		forkManager,
		parentHiddenTools: childOptions?.parentHiddenTools,
		parentToolNames: childOptions?.parentToolNames,
	};
}

describe("a forked subagent continues its parent's cached request", () => {
	for (const [mode, compat] of [
		["native tool changes", NATIVE],
		["top-level tools only", FLAT_TOOLS],
	] as const) {
		test(`its first request extends the parent's last one, with a narrower tool policy (${mode})`, async () => {
			const { runtime, parentModel, requests, parentManager, forkManager } = await parentAndFork(compat);
			const child = await openFork(forkManager, runtime, parentModel);
			await child.prompt("child task");

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
			await child.prompt("child task");

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
		await child.prompt("child task");

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
					codemode: "only",
				},
			);
			assert.deepEqual([...(parentHiddenTools ?? [])].sort(), ["bash", "read"]);
			const child = await openFork(forkManager, runtime, parentModel, {
				tools: ["read", "codemode"],
				codemode: "only",
				parentHiddenTools,
			});
			await child.prompt("child task");

			const [, parentLast, forkFirst] = requests.map((request) => request.payload);
			assert.ok(extendsRequest(parentLast, forkFirst), "the fork declares the tools the parent declared");
			assert.doesNotMatch(added(parentLast, forkFirst), /"name":"bash"/);
			assert.doesNotMatch(added(parentLast, forkFirst), /tool_removal/, "the fork keeps the codemode it may call");
		}
	});

	test("a worker fork without codemode keeps the parent's tool list where tools cannot be added, reaching its own tools through codemode", async () => {
		const supervisor: string[] = [];
		const reply: Reply = (model, count) =>
			count === 3
				? message(model, [
						{
							type: "toolCall",
							id: "call_supervisor",
							name: "codemode",
							arguments: { code: 'return await tools.contact_supervisor({ message: "done" });' },
						},
					])
				: count === 4
					? message(model, [
							{
								type: "toolCall",
								id: "call_bash",
								name: "codemode",
								arguments: { code: 'return await tools.bash({ command: "echo outside" });' },
							},
						])
					: textReply(model, count);
		const { runtime, parentModel, requests, forkManager, parentToolNames } = await parentAndFork(FLAT_TOOLS, reply, {
			tools: ["read", "bash", "codemode"],
			codemode: "direct",
		});
		const { tools, codemodeRoutingOnly } = forkedChildTools(["read", "contact_supervisor"], parentToolNames);
		assert.deepEqual(tools, ["read", "contact_supervisor", "codemode"]);
		assert.equal(codemodeRoutingOnly, true);
		const child = await openFork(forkManager, runtime, parentModel, {
			tools,
			codemodeRoutingOnly,
			codemode: "direct",
			customTools: [
				{
					name: "contact_supervisor",
					label: "Contact supervisor",
					description: "Send the supervisor a message.",
					parameters: Type.Object({ message: Type.String() }),
					execute: async (_id, params) => {
						supervisor.push((params as { message: string }).message);
						return { content: [{ type: "text", text: "delivered" }], details: {} };
					},
				},
			],
		});
		await child.prompt("child task");

		const [, parentLast, forkFirst] = requests.map((request) => request.payload);
		assert.ok(extendsRequest(parentLast, forkFirst), "the fork keeps the parent's tool list and conversation");
		assert.match(added(parentLast, forkFirst), /Call contact_supervisor through codemode/);
		assert.deepEqual(supervisor, ["done"]);
		const results = child.messages.filter((entry) => entry.role === "toolResult");
		assert.deepEqual(
			results.map((result) => [result.toolName, result.isError]),
			[
				["codemode", false],
				["codemode", true],
			],
		);
		assert.match(JSON.stringify(results[1].content), /tools\.bash does not exist/);
	});

	test("a codemode the fork adds reaches only the child's own tools, as a fresh child of the same agent can", async () => {
		const secretRuns: string[] = [];
		const secret: NonNullable<CreateAgentSessionOptions["customTools"]>[number] = {
			name: "secret",
			label: "Secret",
			description: "A deferred tool the child has but has not activated.",
			exposure: "deferred",
			parameters: Type.Object({}),
			execute: async () => {
				secretRuns.push("ran");
				return { content: [{ type: "text", text: "secret" }], details: {} };
			},
		};
		const script = (id: string, code: string) => ({
			type: "toolCall" as const,
			id,
			name: "codemode",
			arguments: { code },
		});
		const scripts = [
			script("call_models", 'return await models.getAvailableOfType("classifier");'),
			script("call_secret", "return await tools.secret({});"),
			script("call_bash", 'return await tools.bash({ command: "echo outside" });'),
			script("call_read", 'return await tools.read({ path: "notes.txt" });'),
		];
		const reply: Reply = (model, count) => (count === 3 ? message(model, scripts) : textReply(model, count));
		const { runtime, parentModel, forkManager, parentToolNames } = await parentAndFork(NATIVE, reply, {
			tools: ["read", "bash", "codemode"],
			codemode: "direct",
		});
		writeFileSync(join(forkManager.getCwd(), "notes.txt"), "the child's own file");
		const { tools, codemodeRoutingOnly } = forkedChildTools(["read", "secret"], parentToolNames);
		const fork = await openFork(forkManager, runtime, parentModel, {
			tools,
			codemodeRoutingOnly,
			codemode: "direct",
			customTools: [secret],
		});
		// Registered, but outside what the child may call now.
		fork.setActiveToolsByName(["read", "codemode"]);
		await fork.prompt("child task");

		const results = fork.messages.filter((entry) => entry.role === "toolResult");
		assert.deepEqual(
			results.map((result) => [result.toolCallId, result.isError]),
			[
				["call_models", true],
				["call_secret", true],
				["call_bash", true],
				["call_read", false],
			],
		);
		assert.match(JSON.stringify(results[0].content), /models is not defined/);
		assert.match(JSON.stringify(results[1].content), /tools\.secret does not exist/);
		assert.match(JSON.stringify(results[2].content), /tools\.bash does not exist/);
		assert.deepEqual(secretRuns, []);

		// A fresh child of the same read-only agent has no codemode at all: it cannot reach any of them either.
		const freshReplies: Reply = (model, count) =>
			count === 1
				? message(model, [
						script("call_fresh", "return await tools.secret({});"),
						{ type: "toolCall", id: "call_secret_direct", name: "secret", arguments: {} },
					])
				: textReply(model, count);
		const freshRecorded = await recordingRuntime(NATIVE, freshReplies);
		const dir = makeTempDirectory("atomic-fork-fresh-");
		cleanups.push(() => removeTempDirectory(dir));
		const { session: fresh } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			model: freshRecorded.parentModel,
			thinkingLevel: "off",
			modelRuntime: freshRecorded.runtime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			sessionManager: SessionManager.inMemory(dir),
			resourceLoader: resourceLoader("You review changes.", await codemode("direct")),
			subagentPolicy: { ...narrow, managementActions: "restricted", depth: 1 },
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["read", "secret"],
			customTools: [secret],
			...createInProcessChildPromptBehavior(narrow),
		});
		cleanups.push(() => fresh.dispose());
		fresh.setActiveToolsByName(["read"]);
		await fresh.prompt("child task");
		const freshResults = fresh.messages.filter((entry) => entry.role === "toolResult");
		assert.deepEqual(
			freshResults.map((result) => [result.toolName, result.isError]),
			[
				["codemode", true],
				["secret", true],
			],
		);
		assert.deepEqual(secretRuns, []);
	});

	test("a fork made in the millisecond of its parent's last reply, or after the clock stepped back, continues its parent", async () => {
		// A fork an earlier version made says nothing of where its copied history ends, so only the clock tells.
		for (const fork of [
			{ madeByEarlierVersion: false, clockFromParentReply: 0 },
			{ madeByEarlierVersion: false, clockFromParentReply: -60_000 },
			{ madeByEarlierVersion: true, clockFromParentReply: 0 },
		]) {
			const { runtime, parentModel, requests, parentManager, forkManager } = await parentAndFork(
				NATIVE,
				undefined,
				undefined,
				fork,
			);
			const forkedFrom = forkedParentSessionId(forkManager);
			assert.equal(forkedFrom, parentManager.getSessionId(), "the parent's reply is not the child's own turn");
			const child = await openFork(forkManager, runtime, parentModel, { forkedFrom });
			await child.prompt("child task");
			const [, parentLast, forkFirst] = requests;
			assert.ok(extendsRequest(parentLast.payload, forkFirst.payload), "the fork reuses the parent's whole request");
			assert.equal(forkFirst.sessionId, parentManager.getSessionId());
		}
	});

	test("the start a fork copied from its parent's history is not its own", async () => {
		const dir = makeTempDirectory("atomic-fork-cache-");
		cleanups.push(() => removeTempDirectory(dir));
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const turn = async (manager: SessionManager, text: string) => {
			await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			await manager.appendMessage(message(model, [{ type: "text", text: `${text} done` }]));
		};
		const grandparent = SessionManager.inMemory(dir);
		await turn(grandparent, "grandparent task");
		// The parent is a fork this version made, with a turn of its own after its start.
		const parent = await createForkContextResolver(grandparent, "fork").sessionManagerForIndex(0);
		assert.ok(parent);
		await turn(parent, "parent task");
		// Its fork, made as an earlier version made one, records no start of its own.
		const fork = await parent.captureFork(parent.getLeafId()!)();
		assert.equal(forkedParentSessionId(fork), parent.getSessionId(), "the parent's turn is not the fork's own");
	});

	for (const madeByEarlierVersion of [true, false]) {
		const made = madeByEarlierVersion ? "an earlier version made" : "this version made";
		test(`a fork child ${made} and an earlier version ran is reopened as the child it was, every time`, async () => {
			// The parent's history holds one of its own subagent calls, which the earlier version filtered out of the
			// fork.
			const reply: Reply = (model, count) =>
				count === 1
					? message(model, [{ type: "toolCall", id: "call_sub_1", name: "subagent", arguments: {} }])
					: textReply(model, count);
			const { runtime, parentModel, requests, parentManager, forkManager } = await parentAndFork(
				NATIVE,
				reply,
				undefined,
				{ madeByEarlierVersion },
			);
			assert.equal(
				forkedParentSessionId(forkManager),
				parentManager.getSessionId(),
				"a new fork continues its parent",
			);
			// The earlier version: the child's own transformed prompt, the parent's orchestration history filtered
			// out, and no recorded prompt.
			const cwd = forkManager.getCwd();
			const { session: legacy } = await createAgentSession({
				cwd,
				agentDir: cwd,
				model: parentModel,
				thinkingLevel: "off",
				modelRuntime: runtime,
				settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
				sessionManager: forkManager,
				resourceLoader: resourceLoader("You review changes."),
				subagentPolicy: { ...narrow, managementActions: "restricted", depth: 1 },
				builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
				tools: ["read"],
				...createInProcessChildPromptBehavior(narrow),
				systemPromptSections: undefined,
				systemPromptTransform: createInProcessChildSystemPromptTransform(narrow),
			});
			await legacy.prompt("child task");
			await legacy.dispose();

			const reopen = async (task: string) => {
				const manager = await SessionManager.open(forkManager.getSessionStore(), forkManager.getSessionId());
				const parentSessionId = forkedParentSessionId(manager);
				assert.equal(parentSessionId, undefined, "it is reopened as the child it was");
				const child = await openFork(manager, runtime, parentModel, { forkedFrom: parentSessionId });
				await child.prompt(task);
				await child.dispose();
				return requests.at(-1)!;
			};
			const first = await reopen("follow-up");
			const second = await reopen("another follow-up");

			for (const { payload } of [first, second]) {
				assert.doesNotMatch(JSON.stringify(payload), /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
				assert.doesNotMatch(JSON.stringify(payload), /You are now a subagent started from the conversation above/);
				assert.doesNotMatch(JSON.stringify(payload.messages), /call_sub_1/);
				assert.match(JSON.stringify(payload.system), /You are a child subagent, not the parent orchestrator/);
				assert.deepEqual(
					(payload.tools as { name: string }[]).map((tool) => tool.name).filter((name) => !name.startsWith("__")),
					["read"],
				);
			}
			assert.equal(first.sessionId, forkManager.getSessionId());
			assert.equal(second.sessionId, forkManager.getSessionId());
			assert.ok(extendsRequest(first.payload, second.payload), "the second reopen reuses the first one's request");
		});
	}

	test("a fork stays a fork when reopened after a compaction or under another policy", async () => {
		const { runtime, parentModel, requests, parentManager, forkManager } = await parentAndFork(NATIVE);
		const child = await openFork(forkManager, runtime, parentModel);
		await child.prompt("child task");
		await child.compact();
		await child.dispose();
		const reopen = async (task: string, policy?: typeof narrow) => {
			const manager = await SessionManager.open(forkManager.getSessionStore(), forkManager.getSessionId());
			const forkedFrom = forkedParentSessionId(manager);
			assert.equal(forkedFrom, parentManager.getSessionId(), "it started as a fork");
			const reopened = await openFork(manager, runtime, parentModel, { forkedFrom, ...(policy ? { policy } : {}) });
			await reopened.prompt(task);
			await reopened.dispose();
			return requests.at(-1)!;
		};
		const afterCompaction = await reopen("follow-up");
		assert.equal(afterCompaction.sessionId, parentManager.getSessionId());
		const fanout = { ...narrow, fanoutAuthorized: true };
		const underOtherPolicy = await reopen("another follow-up", fanout);
		const again = await reopen("a third follow-up", fanout);
		assert.equal(again.sessionId, parentManager.getSessionId());
		assert.ok(extendsRequest(underOtherPolicy.payload, again.payload));
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
		await child.prompt("child task");

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
		await child.prompt("child task");

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
		await child.prompt("child task");
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
			const { keepRemoval, keepAddition } = forkToolDeclarations(inherited, support, ["read", "codemode"]);
			assert.equal(keepRemoval("bash"), support === "changes");
			assert.equal(keepRemoval("codemode"), false, "a tool the fork keeps is never removed");
			assert.equal(keepAddition(tool("read") as never), false);
		}
	});

	test("reaches a tool only the fork has through the parent's codemode where the transport cannot add it", () => {
		assert.equal(forkToolDeclarations(inherited, "none", ["read", "codemode"]).throughCodemode, true);
		assert.equal(
			forkToolDeclarations(inherited, "none", ["read", "codemode"]).keepAddition(tool("todo") as never),
			false,
		);
		assert.equal(forkToolDeclarations(inherited, "none", ["read"]).keepAddition(tool("todo") as never), true);
		assert.equal(
			forkToolDeclarations(inherited, "additions", ["read", "codemode"]).keepAddition(tool("todo") as never),
			true,
		);
		assert.equal(forkToolDeclarations([tool("read")], "none", ["read", "codemode"]).throughCodemode, false);
	});
});
