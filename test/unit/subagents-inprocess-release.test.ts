import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetachedToolCall, DetachedToolResult, ToolDefinition } from "@bastani/atomic";
import { getEnvNames } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { releasedEnvelope } from "../../packages/subagents/src/runs/inprocess/runner.ts";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.ts";

/** A live child loads its real resources; that load is the structural cost of these tests. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "waiter",
	description: "waits on CI",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/waiter.md",
};

async function liveChildEnvironment() {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-release-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const names = getEnvNames(ENV_AGENT_DIR);
	const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	for (const name of names) process.env[name] = agentDir;
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(root, "models.json") });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const aborts: string[] = [];
	const waitTool: ToolDefinition = {
		name: "wait_for_ci",
		label: "Wait for CI",
		description: "Waits for CI",
		parameters: Type.Object({ run: Type.String() }),
		detachable: true,
		execute: (_id, _params, signal) =>
			new Promise(() => {
				signal?.addEventListener("abort", () => aborts.push(String(signal.reason)), { once: true });
			}),
	};
	let blockStarted = false;
	const blockTool: ToolDefinition = {
		name: "block",
		label: "Block",
		description: "Runs until stopped",
		parameters: Type.Object({}),
		execute: (_id, _params, signal) =>
			new Promise((_resolve, reject) => {
				blockStarted = true;
				signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
			}),
	};
	cleanups.push(() => {
		faux.unregister();
		for (const name of names) {
			if (previous[name] === undefined) delete process.env[name];
			else process.env[name] = previous[name];
		}
		rmSync(root, { recursive: true, force: true });
	});
	const options = (runId: string, extra: Partial<RunSyncOptions> = {}): RunSyncOptions => ({
		cwd: root,
		runId,
		sessionDir: join(root, "sessions", runId),
		testSession: false,
		getChildSessionOptions: (childOptions) => ({
			...childOptions,
			model,
			modelRuntime,
			customTools: [waitTool, blockTool],
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
		}),
		...extra,
	});
	return { root, faux, options, aborts, blockStarted: () => blockStarted };
}

const waitCall = () =>
	fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" });

test(
	"a live child whose detachable call outlasts the policy is released, its calls handed over, and a wake finishes its turn (#4326)",
	async () => {
		const env = await liveChildEnvironment();
		const released: DetachedToolCall[][] = [];
		const store = new MemorySessionStore();
		const childSession = await SessionManager.create(store, env.root);
		env.faux.setResponses([waitCall()]);

		const result = await runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("release-live", {
				sessionManager: childSession,
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0, onReleased: (calls) => released.push([...calls]) },
			}),
		});

		assert.equal(result.status, "interrupted");
		assert.equal(result.interrupted, true);
		assert.deepEqual(result.released, { waitingOn: [{ toolCallId: "ci-1", toolName: "wait_for_ci" }] });
		assert.equal(result.envelope, releasedEnvelope([{ toolCallId: "ci-1", toolName: "wait_for_ci" }]));
		assert.deepEqual(
			released.map((calls) => calls.map((call) => [call.toolCallId, call.toolName])),
			[[["ci-1", "wait_for_ci"]]],
		);
		assert.deepEqual(env.aborts, [], "a released child's waits keep running");

		const ciResult: DetachedToolResult = {
			toolCallId: "ci-1",
			toolName: "wait_for_ci",
			result: { content: [{ type: "text", text: "green" }], details: undefined },
			isError: false,
		};
		env.faux.setResponses([fauxAssistantMessage("CI is green; done.")]);
		const sessionManager = await SessionManager.open(store, childSession.getSessionId());
		assert.deepEqual(
			sessionManager
				.buildSessionProjection()
				.messages.map((message) => message.role)
				.filter((role) => role !== "system"),
			["user", "assistant"],
			"the released child's transcript ends on its pending call",
		);
		const woken = await runSingleInProcess(env.root, agent, "", {
			...env.options("release-live", {
				sessionManager,
				resumeSession: true,
				resumeToolResults: [ciResult],
				skipTaskPrompt: true,
			}),
		});
		assert.equal(woken.status, "ok");
		assert.equal(woken.finalOutput, "CI is green; done.");
		assert.equal(env.faux.getPendingResponseCount(), 0);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a child stopped while a call it detached still runs aborts that call and is not released (#4326)",
	async () => {
		const env = await liveChildEnvironment();
		env.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }), fauxToolCall("block", {}, { id: "block-1" })],
				{ stopReason: "toolUse" },
			),
		]);
		const controller = new AbortController();
		const released: DetachedToolCall[][] = [];
		const run = runSingleInProcess(env.root, agent, "watch CI", {
			...env.options("release-stopped", {
				signal: controller.signal,
				releaseWhenWaiting: { afterMs: 0, onReleased: (calls) => released.push([...calls]) },
			}),
		});
		while (!env.blockStarted()) await new Promise((resolve) => setTimeout(resolve, 5));
		// A timer scheduled now fires after the 0 ms detachment timer scheduled when the wait call started.
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort("user");
		const stopped = await run;
		assert.notEqual(stopped.status, "ok");
		assert.equal(stopped.released, undefined);
		assert.deepEqual(released, [], "a stopped child hands nothing over to wake it");
		assert.deepEqual(env.aborts, ["abort"], "the detached call ends with the child");
	},
	LIVE_CHILD_TIMEOUT_MS,
);
