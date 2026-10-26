/**
 * #3987: forked-context children run through the real in-process runner and a real
 * AgentSession, against a local provider. No network is contacted.
 *
 * The parent session is captured the way the `subagent` tool sees it while it runs:
 * its newest entry is the parent's own assistant turn carrying the in-flight
 * `subagent` tool call.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Message,
} from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, test } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { AuthStorage, ModelRuntime } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { wrapForkTask } from "../../packages/subagents/src/shared/types-runtime.js";

/**
 * Structural cost, not a slow test: each case builds a real parent AgentSession and
 * two real child AgentSessions with their resource loaders and tool registries.
 */
const REAL_CHILD_SESSION_TIMEOUT_MS = 90_000;

const PARENT_LAST_MESSAGE = "PARENT_LAST_MESSAGE: the parent's settled answer";
const CHILD_OUTPUT = "child complete";

type Reply = (context: readonly Message[]) => { text?: string; errorMessage?: string; readPath?: string };

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
		description: "fork fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
	};
}

async function forkFixture(reply: Reply) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-fork-own-output-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, provider: "fork-own-output" };
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: Message[][] = [];
	runtime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture-key",
		models: [model],
		streamSimple: (requestModel, context) => {
			requests.push([...context.messages]);
			const { text, errorMessage, readPath } = reply(context.messages);
			const stream = createAssistantMessageEventStream();
			const toolUse = readPath !== undefined;
			const message: AssistantMessage = {
				role: "assistant",
				content: toolUse
					? [{ type: "toolCall", id: `read-${requests.length}`, name: "read", arguments: { path: readPath } }]
					: text === undefined
						? []
						: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: requestModel.id,
				usage: usage(),
				stopReason: errorMessage !== undefined ? "error" : toolUse ? "toolUse" : "stop",
				...(errorMessage === undefined ? {} : { errorMessage }),
				timestamp: Date.now(),
			};
			if (errorMessage !== undefined) {
				stream.push({ type: "error", reason: "error", error: message });
			} else {
				stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
			}
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(model.provider));
	const parentManager = await SessionManager.create(cwd, join(cwd, "parent-sessions"));
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		model,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager: parentManager,
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => {
		parent.dispose();
		clearSubagentControls();
	});
	const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) =>
		({
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(),
			stopReason,
			timestamp: Date.now(),
		}) satisfies AssistantMessage;
	const settledAnswer = assistant([{ type: "text", text: PARENT_LAST_MESSAGE }], "stop");
	// The parent's turn that is executing the `subagent` call right now.
	const inFlightTurn = assistant(
		[
			{ type: "thinking", thinking: "Two independent tasks; fork both.", thinkingSignature: "sig-parent-turn" },
			{ type: "text", text: "Forking two workers." },
			{ type: "toolCall", id: "call_subagent", name: "subagent", arguments: { tasks: [] } },
		],
		"toolUse",
	);
	await parentManager.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });
	await parentManager.appendMessage(settledAnswer);
	await parentManager.appendMessage({ role: "user", content: "fork two workers", timestamp: Date.now() });
	await parentManager.appendMessage(inFlightTurn);
	const persistedAssistantTurns = [settledAnswer, inFlightTurn];

	const runForkedChildren = async () => {
		const resolver = createForkContextResolver(parentManager, "fork");
		return Promise.all(
			[0, 1].map(async (index) =>
				runSingleInProcess(cwd, worker(cwd), wrapForkTask(`task ${index}`), {
					cwd,
					runId: `fork-own-output-${index}`,
					index,
					sessionDir: join(cwd, "children"),
					testSession: false,
					currentModel: `${model.provider}/${model.id}`,
					resolveCandidateModel: () => ({ model }),
					getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
					sessionManager: await resolver.sessionManagerForIndex(index),
				}),
			),
		);
	};
	return { requests, persistedAssistantTurns, runForkedChildren };
}

function latestAssistant(messages: readonly Message[]): AssistantMessage | undefined {
	return messages.findLast((message): message is AssistantMessage => message.role === "assistant");
}

function sameContent(left: AgentMessage, right: AgentMessage): boolean {
	return JSON.stringify((left as Message).content) === JSON.stringify((right as Message).content);
}

test(
	"a forked child whose only turn fails reports an error, not the parent's last message (#3987)",
	async () => {
		const fixture = await forkFixture(() => ({ errorMessage: "400 fixture provider rejection" }));
		const results = await fixture.runForkedChildren();

		assert.equal(fixture.requests.length, 2, "each forked child must reach the provider once");
		for (const result of results) {
			assert.equal(result.status, "error", JSON.stringify(result));
			assert.doesNotMatch(result.finalOutput ?? "", /PARENT_LAST_MESSAGE/);
			assert.doesNotMatch(JSON.stringify(result), /PARENT_LAST_MESSAGE/);
			assert.match(result.error ?? "", /400 fixture provider rejection/);
		}
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a forked child whose successful turns were tool-only stays ok with no output (#3987)",
	async () => {
		// Each child reads a file, then ends its turn with an empty final message.
		const fixture = await forkFixture((context) =>
			context.at(-1)?.role === "toolResult" ? {} : { readPath: "missing-file.txt" },
		);
		const results = await fixture.runForkedChildren();

		assert.equal(fixture.requests.length, 4, "each child runs a tool turn and a final empty turn");
		for (const result of results) {
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.equal(result.error, undefined);
			assert.doesNotMatch(JSON.stringify(result), /PARENT_LAST_MESSAGE/);
		}
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a forked child never replays the parent's in-flight turn in modified form, so its own turn runs (#3987)",
	async () => {
		// The provider applies the Anthropic rule for signed thinking: the latest assistant
		// message must come back exactly as the provider produced it, or the request is a 400.
		const fixture = await forkFixture((context) => {
			const latest = latestAssistant(context);
			const signed = latest?.content.some((block) => block.type === "thinking" && block.thinkingSignature);
			if (latest && signed && !fixture.persistedAssistantTurns.some((turn) => sameContent(turn, latest)))
				return { errorMessage: "400 thinking blocks in the latest assistant message cannot be modified" };
			return { text: CHILD_OUTPUT };
		});
		const results = await fixture.runForkedChildren();

		assert.equal(fixture.requests.length, 2);
		for (const request of fixture.requests) {
			const callIds = request.flatMap((message) =>
				message.role === "assistant"
					? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
					: [],
			);
			assert.deepEqual(callIds, [], "the parent's in-flight subagent call is not the child's history");
		}
		for (const result of results) {
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.equal(result.finalOutput, CHILD_OUTPUT);
		}
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);
