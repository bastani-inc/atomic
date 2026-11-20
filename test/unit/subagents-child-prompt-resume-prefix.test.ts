/**
 * An in-process subagent child that is reopened on another day, after an upgrade changed its prompt, sends the request
 * it sent before the exit as the unchanged start of its next one, as a child that was never closed does, and is told
 * the changes as section updates. Real AgentSession and Anthropic request serialization against a scripted reply; no
 * network is contacted.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
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
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { buildSystemPromptSections } from "../../packages/coding-agent/src/core/system-prompt.js";
import {
	createInProcessChildPromptBehavior,
	createInProcessChildSystemPromptSectionsTransform,
	createInProcessChildSystemPromptTransform,
} from "../../packages/subagents/src/runs/inprocess/prompt-behavior.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const PROVIDER = "child-prompt-cache";
const DAY_ONE = new Date("2026-11-20T12:00:00");
const DAY_TWO = new Date("2026-11-21T12:00:00");
const DAY_THREE = new Date("2026-11-22T12:00:00");

interface AnthropicPayload {
	tools?: unknown[];
	system?: unknown[];
	messages: { role: string; content: unknown }[];
}

const policy = { inheritProjectContext: false, inheritSkills: false, fanoutAuthorized: false };
const inheritingPolicy = { inheritProjectContext: true, inheritSkills: true, fanoutAuthorized: true };
const skillText = (version: number) => `<skill name="checks">\nRun the checks (skill version ${version}).\n</skill>`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function inheritedSkill(): Skill {
	return {
		name: "parent-skill",
		description: "PARENT_SKILL_SENTINEL",
		filePath: "/tmp/parent-skill/SKILL.md",
		baseDir: "/tmp/parent-skill",
		sourceInfo: createSyntheticSourceInfo("/tmp/parent-skill/SKILL.md", { source: "sdk" }),
		disableModelInvocation: false,
	};
}

function resourceLoader(projectContext = "PROJECT_CONTEXT_SENTINEL"): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [inheritedSkill()], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [{ path: "AGENTS.md", content: projectContext }] }),
		getSystemPrompt: () => "You review changes.",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: async () => {},
		reload: async () => {},
	};
}

function done(model: Model<"anthropic-messages">, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: PROVIDER,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A model that takes system messages mid-conversation; every request is serialized by the Anthropic transport. */
async function recordingRuntime(requests: AnthropicPayload[]) {
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	const model: Model<"anthropic-messages"> = {
		...base,
		provider: PROVIDER,
		compat: { ...base.compat, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider(PROVIDER, {
		api: base.api,
		baseUrl: base.baseUrl,
		apiKey: "fixture-key",
		models: [model],
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
				requests.push(payload);
				const message = done(model, `reply ${requests.length}`);
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			})();
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(PROVIDER));
	return { runtime, model };
}

/** A child session as the in-process runner opens it, with the explicit skill text of the installed version. */
async function openChild(
	sessionManager: SessionManager,
	runtime: ModelRuntime,
	model: Model<"anthropic-messages">,
	skillVersion: number,
	options: { recordsPrompt?: boolean; tools?: string[]; policy?: typeof policy; projectContext?: string } = {},
) {
	const cwd = sessionManager.getCwd();
	const childPolicy = options.policy ?? policy;
	const behavior = createInProcessChildPromptBehavior(childPolicy, skillText(skillVersion));
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager,
		resourceLoader: resourceLoader(options.projectContext),
		subagentPolicy: { ...childPolicy, managementActions: "restricted" },
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: options.tools ?? ["read"],
		...behavior,
		// A child last run by a version that did not record the prompt it sent.
		...(options.recordsPrompt === false
			? {
					systemPromptSections: undefined,
					systemPromptTransform: createInProcessChildSystemPromptTransform(childPolicy, skillText(skillVersion)),
				}
			: {}),
	});
	return session;
}

async function sqliteStore(dir: string) {
	const db = await openNodeSqliteDatabase(join(dir, "sessions.db"));
	const store = await SqlSessionStore.open(db);
	return {
		store,
		close: async () => {
			await store.close();
			await db.close();
		},
	};
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

/** How much of `before` the request `after` reuses: the length of their common prefix. */
function reused(before: AnthropicPayload, after: AnthropicPayload): number {
	const left = cachedPrefix(before);
	const right = cachedPrefix(after);
	let index = 0;
	while (index < left.length && index < right.length && left[index] === right[index]) index++;
	return index;
}

function systemText(payload: AnthropicPayload): string {
	return JSON.stringify(payload.system);
}

function updates(payload: AnthropicPayload): string {
	return JSON.stringify(payload.messages.filter((message) => message.role === "system"));
}

describe("a reopened subagent child keeps the prompt it sent", () => {
	test("reuses the whole previous request after the date and the installed version change, as a child never closed does", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const dir = makeTempDirectory("atomic-child-prompt-resume-");
		cleanups.push(() => removeTempDirectory(dir));

		// Control: a child that is never closed sends its second request on the same day.
		const controlRequests: AnthropicPayload[] = [];
		const control = await recordingRuntime(controlRequests);
		vi.setSystemTime(DAY_ONE);
		const controlChild = await openChild(SessionManager.inMemory(dir), control.runtime, control.model, 1);
		cleanups.push(() => controlChild.dispose());
		await controlChild.prompt("first task");
		await controlChild.prompt("second task");
		assert.equal(controlRequests.length, 2);
		const controlReuse = reused(controlRequests[0], controlRequests[1]);
		assert.equal(controlReuse, cachedPrefix(controlRequests[0]).length);

		// The same child, closed after its first request and reopened the next day by an upgraded install.
		const requests: AnthropicPayload[] = [];
		const { runtime, model } = await recordingRuntime(requests);
		const first = await sqliteStore(dir);
		const manager = await SessionManager.create(first.store, dir, { id: "child" });
		const child = await openChild(manager, runtime, model, 1);
		await child.prompt("first task");
		await child.dispose();
		await first.close();

		vi.setSystemTime(DAY_TWO);
		const second = await sqliteStore(dir);
		cleanups.push(second.close);
		const reopened = await openChild(await SessionManager.open(second.store, "child"), runtime, model, 2);
		cleanups.push(() => reopened.dispose());
		await reopened.prompt("second task");

		assert.equal(requests.length, 2);
		assert.deepEqual(cachedPrefix(requests[0]), cachedPrefix(controlRequests[0]));
		assert.equal(reused(requests[0], requests[1]), controlReuse);
		const told = updates(requests[1]);
		assert.match(told, /Updated system prompt section \\"date\\"/);
		assert.match(told, /2026-11-21/);
		assert.match(told, /skill version 2/);
		assert.doesNotMatch(told, /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
		assert.match(systemText(requests[1]), /2026-11-20/);
		assert.doesNotMatch(systemText(requests[1]), /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
	});

	test("declares a tool it gains after its first request after that request, keeping the prompt it sent", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const dir = makeTempDirectory("atomic-child-prompt-tools-");
		cleanups.push(() => removeTempDirectory(dir));
		const requests: AnthropicPayload[] = [];
		const { runtime, model } = await recordingRuntime(requests);
		vi.setSystemTime(DAY_ONE);
		const child = await openChild(SessionManager.inMemory(dir), runtime, model, 1, { tools: ["read", "bash"] });
		cleanups.push(() => child.dispose());
		child.setActiveToolsByName(["read"]);
		await child.prompt("first task");
		child.setActiveToolsByName(["read", "bash"]);
		await child.prompt("second task");

		assert.equal(requests.length, 2);
		assert.equal(reused(requests[0], requests[1]), cachedPrefix(requests[0]).length);
		assert.match(updates(requests[1]), /"name":"bash"/);
	});

	test("keeps that prompt through a compaction and tells the changes made since as one update", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const dir = makeTempDirectory("atomic-child-prompt-compaction-");
		cleanups.push(() => removeTempDirectory(dir));
		const requests: AnthropicPayload[] = [];
		const { runtime, model } = await recordingRuntime(requests);
		vi.setSystemTime(DAY_ONE);
		const first = await sqliteStore(dir);
		const child = await openChild(await SessionManager.create(first.store, dir, { id: "child" }), runtime, model, 1);
		await child.prompt("first task");
		await child.dispose();
		await first.close();

		vi.setSystemTime(DAY_TWO);
		const second = await sqliteStore(dir);
		cleanups.push(second.close);
		const reopened = await openChild(await SessionManager.open(second.store, "child"), runtime, model, 2);
		cleanups.push(() => reopened.dispose());
		await reopened.prompt("second task");
		await reopened.compact();
		await reopened.prompt("third task");

		const last = requests.at(-1)!;
		assert.equal(systemText(last), systemText(requests[0]));
		const told = updates(last);
		assert.match(told, /2026-11-21/);
		assert.match(told, /skill version 2/);
		assert.doesNotMatch(told, /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
	});

	test("a child last run by an earlier version pays at most one cold write when reopened, then keeps its prompt", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const dir = makeTempDirectory("atomic-child-prompt-legacy-");
		cleanups.push(() => removeTempDirectory(dir));
		const requests: AnthropicPayload[] = [];
		const { runtime, model } = await recordingRuntime(requests);
		vi.setSystemTime(DAY_ONE);
		const first = await sqliteStore(dir);
		const legacy = await openChild(
			await SessionManager.create(first.store, dir, { id: "child" }),
			runtime,
			model,
			1,
			{
				recordsPrompt: false,
			},
		);
		await legacy.prompt("first task");
		await legacy.dispose();
		await first.close();

		vi.setSystemTime(DAY_TWO);
		const second = await sqliteStore(dir);
		const upgraded = await openChild(await SessionManager.open(second.store, "child"), runtime, model, 2);
		await upgraded.prompt("second task");
		await upgraded.dispose();
		await second.close();

		vi.setSystemTime(DAY_THREE);
		const third = await sqliteStore(dir);
		cleanups.push(third.close);
		const reopened = await openChild(await SessionManager.open(third.store, "child"), runtime, model, 3);
		cleanups.push(() => reopened.dispose());
		await reopened.prompt("third task");

		assert.equal(requests.length, 3);
		// The first request after the upgrade is the one the earlier version sends: its prompt as of today, no update.
		assert.match(systemText(requests[1]), /2026-11-21/);
		assert.match(systemText(requests[1]), /skill version 2/);
		assert.equal(updates(requests[1]), "[]");
		assert.equal(reused(requests[1], requests[2]), cachedPrefix(requests[1]).length);
		assert.match(updates(requests[2]), /2026-11-22/);
	});

	test("a child of an earlier version whose first run after the upgrade continues its turn records the prompt it sends", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const dir = makeTempDirectory("atomic-child-prompt-continuation-");
		cleanups.push(() => removeTempDirectory(dir));
		const requests: AnthropicPayload[] = [];
		const { runtime, model } = await recordingRuntime(requests);
		vi.setSystemTime(DAY_ONE);
		const first = await sqliteStore(dir);
		const manager = await SessionManager.create(first.store, dir, { id: "child" });
		const legacy = await openChild(manager, runtime, model, 1, { recordsPrompt: false });
		await legacy.prompt("first task");
		await legacy.dispose();
		assert.ok(
			!manager.getEntries().some((entry) => entry.type === "message" && "transformedPrompt" in entry.message),
			"a session without the section transform records no prompt",
		);
		// The process stopped after the next message was saved and before the model answered it.
		await manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "next task" }],
			timestamp: Date.now(),
		});
		await first.close();

		vi.setSystemTime(DAY_TWO);
		const second = await sqliteStore(dir);
		const upgraded = await openChild(await SessionManager.open(second.store, "child"), runtime, model, 2);
		// The run a woken child starts: its turn continues without a new prompt.
		await (upgraded as unknown as AgentSessionInternalSurface)._runAgentContinuation(async () => {}, "continue");
		await upgraded.dispose();
		await second.close();

		vi.setSystemTime(DAY_THREE);
		const third = await sqliteStore(dir);
		cleanups.push(third.close);
		const reopened = await openChild(await SessionManager.open(third.store, "child"), runtime, model, 3);
		cleanups.push(() => reopened.dispose());
		await reopened.prompt("third task");

		assert.equal(requests.length, 3);
		assert.equal(reused(requests[1], requests[2]), cachedPrefix(requests[1]).length);
	});
});

describe("a recorded prompt is only sent by the child and policy that recorded it", () => {
	test("a child reopened under a policy that keeps less sends its current prompt, then keeps that one", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const dir = makeTempDirectory("atomic-child-prompt-narrowed-");
		cleanups.push(() => removeTempDirectory(dir));
		const requests: AnthropicPayload[] = [];
		const { runtime, model } = await recordingRuntime(requests);
		vi.setSystemTime(DAY_ONE);
		const first = await sqliteStore(dir);
		const wide = await openChild(await SessionManager.create(first.store, dir, { id: "child" }), runtime, model, 1, {
			policy: inheritingPolicy,
		});
		await wide.prompt("first task");
		await wide.dispose();
		await first.close();

		const second = await sqliteStore(dir);
		const narrowed = await openChild(await SessionManager.open(second.store, "child"), runtime, model, 1);
		await narrowed.prompt("second task");
		await narrowed.dispose();
		await second.close();

		vi.setSystemTime(DAY_TWO);
		const third = await sqliteStore(dir);
		cleanups.push(third.close);
		const reopened = await openChild(await SessionManager.open(third.store, "child"), runtime, model, 1);
		cleanups.push(() => reopened.dispose());
		await reopened.prompt("third task");

		assert.equal(requests.length, 3);
		assert.match(systemText(requests[0]), /PROJECT_CONTEXT_SENTINEL/);
		for (const request of requests.slice(1)) {
			assert.doesNotMatch(systemText(request), /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
			assert.doesNotMatch(updates(request), /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
		}
		assert.equal(reused(requests[1], requests[2]), cachedPrefix(requests[1]).length);
	});

	test("a child reopened under its first policy again never sends what it was told under another", async () => {
		const dir = makeTempDirectory("atomic-child-prompt-epochs-");
		cleanups.push(() => removeTempDirectory(dir));
		const requests: AnthropicPayload[] = [];
		const { runtime, model } = await recordingRuntime(requests);
		const runs = [
			{ policy },
			{ policy: inheritingPolicy },
			{ policy: inheritingPolicy, projectContext: "PROJECT_CONTEXT_SENTINEL edited" },
			{ policy },
		];
		for (const [index, options] of runs.entries()) {
			const store = await sqliteStore(dir);
			const manager =
				index === 0
					? await SessionManager.create(store.store, dir, { id: "child" })
					: await SessionManager.open(store.store, "child");
			const child = await openChild(manager, runtime, model, 1, options);
			await child.prompt(`task ${index + 1}`);
			await child.dispose();
			await store.close();
		}

		assert.equal(requests.length, 4);
		assert.match(updates(requests[2]), /PROJECT_CONTEXT_SENTINEL edited/);
		const last = requests[3];
		assert.doesNotMatch(JSON.stringify(last), /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
	});

	test("a session forked from another child's session sends its own prompt", async () => {
		const dir = makeTempDirectory("atomic-child-prompt-fork-");
		cleanups.push(() => removeTempDirectory(dir));
		const requests: AnthropicPayload[] = [];
		const { runtime, model } = await recordingRuntime(requests);
		const store = await sqliteStore(dir);
		cleanups.push(store.close);
		const parentManager = await SessionManager.create(store.store, dir, { id: "parent-child" });
		const parent = await openChild(parentManager, runtime, model, 1, { policy: inheritingPolicy });
		await parent.prompt("first task");
		const leaf = parentManager.getLeafId();
		await parent.dispose();
		const forked = await SessionManager.open(store.store, "parent-child");
		await forked.createBranchedSession(leaf!, { history: "tail" });
		assert.notEqual(forked.getSessionId(), "parent-child");
		const child = await openChild(forked, runtime, model, 1);
		cleanups.push(() => child.dispose());
		await child.prompt("second task");

		assert.equal(requests.length, 2);
		assert.match(systemText(requests[0]), /PROJECT_CONTEXT_SENTINEL/);
		assert.doesNotMatch(systemText(requests[1]), /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
		assert.doesNotMatch(updates(requests[1]), /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
	});
});

describe("the child's prompt sections", () => {
	test("hold exactly the text of its transformed prompt, without what the parent keeps", () => {
		const sections = buildSystemPromptSections({
			cwd: "/work",
			customPrompt:
				'You review changes.\n<skill name="subagent"><name>subagent</name><description>PARENT_ORCHESTRATION</description></skill>',
			contextFiles: [{ path: "AGENTS.md", content: "PROJECT_CONTEXT_SENTINEL" }],
			skills: [inheritedSkill()],
			selectedTools: ["read"],
		});
		const prompt = Object.values(sections).join("\n\n");
		for (const childPolicy of [
			policy,
			{ inheritProjectContext: true, inheritSkills: true, fanoutAuthorized: true },
		]) {
			const transformed = createInProcessChildSystemPromptTransform(childPolicy, skillText(1))(prompt);
			const child = createInProcessChildSystemPromptSectionsTransform(childPolicy, skillText(1))(sections);
			let rest = transformed;
			for (const text of Object.values(child)) {
				assert.ok(rest.includes(text), `the transformed prompt holds ${JSON.stringify(text.slice(0, 40))}`);
				rest = rest.replace(text, "");
			}
			assert.equal(rest.trim(), "");
			const joined = JSON.stringify(child);
			assert.doesNotMatch(joined, /PARENT_ORCHESTRATION/);
			if (childPolicy === policy) assert.doesNotMatch(joined, /PROJECT_CONTEXT_SENTINEL|PARENT_SKILL_SENTINEL/);
			else assert.match(joined, /PROJECT_CONTEXT_SENTINEL[\s\S]*PARENT_SKILL_SENTINEL/);
		}
	});
});
