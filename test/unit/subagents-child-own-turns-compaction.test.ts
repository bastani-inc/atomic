/**
 * A compaction during a child's attempt removes the turns before its boundary, and the child's launch point among
 * them, from the session the child holds in memory. The child's result is still decided by every turn it ran in that
 * attempt and by none it ran before. Children run through the real in-process runner and a real AgentSession against a
 * local provider; no network is contacted.
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
} from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/index.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AuthStorage, ModelRuntime } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { wrapForkTask } from "../../packages/subagents/src/shared/types-runtime.js";

/**
 * Structural cost, not a slow test: each case builds a real parent AgentSession and a real child AgentSession with
 * its resource loader and tool registry.
 */
const REAL_CHILD_SESSION_TIMEOUT_MS = 90_000;

const CONTEXT_WINDOW = 100_000;
/** Context the provider reports for a turn: past the automatic compaction threshold once a tool result follows. */
const NEAR_FULL_CONTEXT = CONTEXT_WINDOW - 2_000;
const FINAL_ANSWER = "FINAL_ANSWER: the child finished its task";
const PARTIAL_FINDINGS = "PARTIAL_FINDINGS: what the child found before its context was cleared";
const EARLIER_ANSWER = "EARLIER_ANSWER: the child's answer from its previous run";

/** One provider turn: text, a `read` call, an error, and the context size the provider reports for it. */
interface Turn {
	readonly text?: string;
	readonly readPath?: string;
	readonly errorMessage?: string;
	readonly contextTokens?: number;
}

type StoreKind = "jsonl" | "memory";
const STORE_KINDS: readonly StoreKind[] = ["jsonl", "memory"];

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function usage(input: number): AssistantMessage["usage"] {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function worker(cwd: string): AgentConfig {
	return {
		name: "worker",
		description: "own turns fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
	};
}

interface FixtureOptions {
	/** Text an extension compacts the context to, instead of clearing it. */
	readonly compactedText?: string;
	/** From this provider request on, the session's saved history cannot be read back (memory sessions only). */
	readonly historyUnreadableFromRequest?: number;
}

/** A store whose saved history cannot be read back once `unreadable` is set; appends still succeed. */
class UnreadableHistoryStore extends MemorySessionStore {
	unreadable = false;
	override readBranchSpan(...args: Parameters<MemorySessionStore["readBranchSpan"]>) {
		if (this.unreadable) return Promise.reject(new Error("EIO: i/o error, read"));
		return super.readBranchSpan(...args);
	}
}

async function fixture(storeKind: StoreKind, turns: readonly Turn[], options: FixtureOptions = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-child-own-turns-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const model = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		provider: "child-own-turns",
		contextWindow: CONTEXT_WINDOW,
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: Message[][] = [];
	const store = new UnreadableHistoryStore();
	runtime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture-key",
		models: [model],
		streamSimple: (requestModel, context) => {
			requests.push([...context.messages]);
			if (requests.length === options.historyUnreadableFromRequest) store.unreadable = true;
			const turn = turns[requests.length - 1] ?? { errorMessage: "fixture ran out of turns" };
			const stream = createAssistantMessageEventStream();
			const content: AssistantMessage["content"] = [];
			if (turn.text !== undefined) content.push({ type: "text", text: turn.text });
			if (turn.readPath !== undefined)
				content.push({
					type: "toolCall",
					id: `read-${requests.length}`,
					name: "read",
					arguments: { path: turn.readPath },
				});
			const stopReason =
				turn.errorMessage !== undefined ? "error" : turn.readPath !== undefined ? "toolUse" : "stop";
			const message: AssistantMessage = {
				role: "assistant",
				content,
				api: model.api,
				provider: model.provider,
				model: requestModel.id,
				usage: usage(turn.contextTokens ?? 1_000),
				stopReason,
				...(turn.errorMessage === undefined ? {} : { errorMessage: turn.errorMessage }),
				timestamp: Date.now(),
			};
			if (turn.errorMessage !== undefined) stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: stopReason === "toolUse" ? "toolUse" : "stop", message });
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(model.provider));
	const newManager = () =>
		storeKind === "jsonl"
			? SessionManager.create(cwd, join(cwd, "sessions"))
			: SessionManager.create(
					options.historyUnreadableFromRequest === undefined ? new MemorySessionStore() : store,
					cwd,
				);
	const parentManager = await newManager();
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		model,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager: parentManager,
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => {
		parent.dispose();
		clearSubagentControls();
	});
	const assistant = (text: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(1_000),
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const run = (task: string, sessionManager: SessionManager) =>
		runSingleInProcess(cwd, worker(cwd), task, {
			cwd,
			runId: "child-own-turns",
			index: 0,
			sessionDir: join(cwd, "children"),
			testSession: false,
			currentModel: `${model.provider}/${model.id}`,
			resolveCandidateModel: () => ({ model }),
			getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
			sessionManager,
			...(options.compactedText === undefined
				? {}
				: {
						resourceLoaderInheritanceSnapshot: {
							extensionFactories: [
								(pi: ExtensionAPI) => {
									pi.on("session_before_compact", () => ({ compactedText: options.compactedText }));
								},
							],
						},
					}),
		});
	/** A child forked from the parent's conversation: its session starts with the parent's history. */
	const runForked = async () => {
		await parentManager.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });
		await parentManager.appendMessage(assistant("PARENT_ANSWER: the parent's settled answer"));
		const childManager = await createForkContextResolver(parentManager, "fork").sessionManagerForIndex(0);
		assert.ok(childManager);
		return { result: await run(wrapForkTask("do the task"), childManager), childManager };
	};
	/**
	 * A child continued in the session of its previous run, which ended with `EARLIER_ANSWER`, or with an entry after it
	 * that a compaction keeps in memory: the session's name.
	 */
	const runContinued = async (endsWith: "answer" | "session name" = "answer") => {
		const childManager = await newManager();
		await childManager.appendMessage({ role: "user", content: "the previous task", timestamp: Date.now() });
		await childManager.appendMessage(assistant(EARLIER_ANSWER));
		if (endsWith === "session name") await childManager.appendSessionInfo("named child");
		return { result: await run("continue with the next step", childManager), childManager };
	};
	/** A child started in a new, empty session. */
	const runNew = async () => {
		const childManager = await newManager();
		return { result: await run("do the task", childManager), childManager };
	};
	return { requests, runForked, runContinued, runNew };
}

/** The compactions the child's saved session holds, in order. */
async function savedBoundaries(childManager: SessionManager) {
	const saved = await SessionManager.open(childManager.getSessionStore(), childManager.getSessionId(), process.cwd());
	await saved.loadFullHistory();
	return saved
		.getEntries()
		.flatMap((entry) =>
			entry.type === "compaction" ? [(entry.details as { form?: string } | undefined)?.form] : [],
		);
}

for (const storeKind of STORE_KINDS) {
	test(
		`a child whose context is cleared mid-run and then finishes is reported done with its final answer (${storeKind} sessions)`,
		async () => {
			const child = await fixture(storeKind, [
				{ readPath: "missing-file.txt", contextTokens: NEAR_FULL_CONTEXT },
				{ text: FINAL_ANSWER },
			]);
			const { result, childManager } = await child.runForked();

			assert.deepEqual(await savedBoundaries(childManager), ["cleared"], "the child's context was cleared mid-run");
			assert.equal(child.requests.length, 2);
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.equal(result.error, undefined);
			assert.equal(result.finalOutput, FINAL_ANSWER);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);

	test(
		`a child whose last turn after a cleared context has no text reports what it wrote before the clear (${storeKind} sessions)`,
		async () => {
			const child = await fixture(storeKind, [
				{ text: PARTIAL_FINDINGS, readPath: "missing-file.txt", contextTokens: NEAR_FULL_CONTEXT },
				{},
			]);
			const { result, childManager } = await child.runForked();

			assert.deepEqual(await savedBoundaries(childManager), ["cleared"]);
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.equal(result.finalOutput, PARTIAL_FINDINGS);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);

	test(
		`a continued child whose context is cleared counts none of its previous run's turns (${storeKind} sessions)`,
		async () => {
			const child = await fixture(storeKind, [
				{ readPath: "missing-file.txt", contextTokens: NEAR_FULL_CONTEXT },
				{},
			]);
			const { result, childManager } = await child.runContinued();

			assert.deepEqual(await savedBoundaries(childManager), ["cleared"]);
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.doesNotMatch(JSON.stringify(result), /EARLIER_ANSWER/);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);

	test(
		`a continued child whose session ends with an entry the clear keeps reports text from earlier in its run (${storeKind} sessions)`,
		async () => {
			const child = await fixture(storeKind, [
				{ text: PARTIAL_FINDINGS, readPath: "missing-file.txt" },
				{ readPath: "missing-file.txt", contextTokens: NEAR_FULL_CONTEXT },
				{},
			]);
			const { result, childManager } = await child.runContinued("session name");

			assert.deepEqual(await savedBoundaries(childManager), ["cleared"]);
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.equal(result.finalOutput, PARTIAL_FINDINGS);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);

	test(
		`a new child whose context is cleared reports text from earlier in its run (${storeKind} sessions)`,
		async () => {
			const child = await fixture(storeKind, [
				{ text: PARTIAL_FINDINGS, readPath: "missing-file.txt" },
				{ readPath: "missing-file.txt", contextTokens: NEAR_FULL_CONTEXT },
				{},
			]);
			const { result, childManager } = await child.runNew();

			assert.deepEqual(await savedBoundaries(childManager), ["cleared"]);
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.equal(result.finalOutput, PARTIAL_FINDINGS);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);

	test(
		`a child reports a long answer it wrote before its context was cleared (${storeKind} sessions)`,
		async () => {
			// Longer than one page of saved history, so it is read back in parts.
			const longFindings = `${PARTIAL_FINDINGS} ${"x".repeat(1_200_000)}`;
			const child = await fixture(storeKind, [
				{ text: longFindings, readPath: "missing-file.txt", contextTokens: NEAR_FULL_CONTEXT },
				{},
			]);
			const { result, childManager } = await child.runForked();

			assert.deepEqual(await savedBoundaries(childManager), ["cleared"]);
			assert.equal(result.status, "ok", result.error);
			// The answer is shown truncated, as any answer this long is.
			assert.match(result.finalOutput ?? "", new RegExp(`\\[TRUNCATED: .* of 1\\.1MB\\]\n${PARTIAL_FINDINGS} x`));
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);

	test(
		`a child whose context is compacted rather than cleared reports text from before the compaction (${storeKind} sessions)`,
		async () => {
			const child = await fixture(
				storeKind,
				[{ text: PARTIAL_FINDINGS, readPath: "missing-file.txt", contextTokens: NEAR_FULL_CONTEXT }, {}],
				{ compactedText: "The child read a file that does not exist." },
			);
			const { result, childManager } = await child.runForked();

			assert.deepEqual(await savedBoundaries(childManager), ["compacted"]);
			assert.equal(result.status, "ok", JSON.stringify(result));
			assert.equal(result.finalOutput, PARTIAL_FINDINGS);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);

	test(
		`a continued child whose turns after a cleared context all fail is reported failed, not by its previous run's answer (${storeKind} sessions)`,
		async () => {
			const child = await fixture(storeKind, [
				{ readPath: "missing-file.txt", contextTokens: NEAR_FULL_CONTEXT },
				{ errorMessage: "503 fixture provider unavailable" },
			]);
			const { result } = await child.runContinued();

			assert.equal(result.status, "error", JSON.stringify(result));
			assert.match(result.error ?? "", /503 fixture provider unavailable/);
			assert.doesNotMatch(JSON.stringify(result), /EARLIER_ANSWER/);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);
}

test(
	"a new child whose saved history cannot be read back after a clear still reports the text it holds",
	async () => {
		const child = await fixture(
			"memory",
			[{ text: PARTIAL_FINDINGS, readPath: "missing-file.txt", contextTokens: NEAR_FULL_CONTEXT }, {}],
			{ historyUnreadableFromRequest: 2 },
		);
		const { result } = await child.runNew();

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(result.finalOutput, PARTIAL_FINDINGS);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);
