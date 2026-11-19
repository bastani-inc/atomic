/**
 * A launching subagent's held sends survive a retried start. Real broker child process; a launching parent with the
 * real Intercom extension that issues the child's capability and makes its starting hold; the real in-process runner
 * with real child sessions that load the real Intercom extension; a child-only extension that stalls the first start
 * past its start budget. A third party sends to the child before it registers, and again while its start is retried:
 * both reach the retry that runs, before its first turn.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/atomic-ai/compat";
import { afterAll, beforeAll, test } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { Cleanup } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { AuthStorage, ModelRuntime } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { requestSupervisorAuthorization } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { holdStartingChild } from "../../packages/subagents/src/runs/foreground/subagent-child-hold.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { subagentStartHoldMs } from "../../packages/subagents/src/runs/shared/start-progress.js";
import type { TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const fixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "start-retry-hold-")));
fixture.overrideAgentDir();
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");

/** A start budget a real child start on a loaded machine reaches its extensions' start within. */
const BUDGET_MS = 12_000;
/** How long the first start is held: past its budget, then let go so the retry may open a session. */
const STALL_MS = BUDGET_MS + 500;
/** Structural cost: a real broker and two real child starts, the first held past its budget. */
const REAL_RETRY_TEST_TIMEOUT_MS = 180_000;
const STALL_HOOK = "__subagentStartRetryHoldStall";
const globals = globalThis as typeof globalThis & {
	[STALL_HOOK]?: (point: "start" | "shutdown") => Promise<void> | undefined;
};

beforeAll(async () => {
	await fixture.startSourceBroker(20_000);
});
afterAll(async () => {
	clearSubagentControls();
	await fixture.cleanup();
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

function eventBus() {
	type Handler = (payload: unknown) => void;
	const handlers = new Map<string, Handler[]>();
	return {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
			return () => {
				handlers.set(
					eventName,
					(handlers.get(eventName) ?? []).filter((candidate) => candidate !== handler),
				);
			};
		},
		emit(eventName: string, payload: unknown) {
			for (const handler of handlers.get(eventName) ?? []) handler(payload);
		},
	};
}

/** A launching parent session with the real Intercom extension (as in the PR's own launch-hold suite). */
async function launchingParent(cwd: string) {
	type Handler = (event: object, ctx: object) => unknown;
	const sessionManager = SessionManager.inMemory(cwd);
	const events = eventBus();
	const handlers = new Map<string, Handler[]>();
	let activeTools: string[] = [];
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry: async (customType: string, data?: unknown) => {
			await sessionManager.appendCustomEntry(customType, data);
		},
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => "start-retry-parent",
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events,
	};
	intercomLightweight(pi as never);
	const ctx = {
		hasUI: false,
		mode: "print",
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		ui: { confirm: async () => true, notify() {} },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? [])
		await handler({ type: "session_start", reason: "startup" }, ctx);
	fixture.onCleanup(async () => {
		for (const handler of handlers.get("session_shutdown") ?? [])
			await handler({ type: "session_shutdown", reason: "quit" }, ctx);
	});
	return { events };
}

for (const { stallAt, resume } of [
	{ stallAt: "before_agent_start", resume: false },
	{ stallAt: "session_start", resume: false },
	{ stallAt: "session_start", resume: true },
] as const)
	test(
		`held sends and cleanup belong to the ${resume ? "resumed child" : "launch"} retry when the first start stalls in ${stallAt} (#5341)`,
		async () => {
			const cwd = mkdtempSync(join(tmpdir(), "start-retry-hold-cwd-"));
			fixture.onCleanup(() => rmSync(cwd, { recursive: true, force: true }));
			const agentDir = join(cwd, "agent");
			const model: Model<"anthropic-messages"> = {
				...getModel("anthropic", "claude-sonnet-4-5")!,
				provider: "start-retry-fixture",
				reasoning: true,
			};
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const contexts: string[] = [];
			runtime.registerProvider(model.provider, {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "fixture-key",
				models: [model],
				streamSimple: (requestModel, context) => {
					contexts.push(JSON.stringify(context.messages));
					const stream = createAssistantMessageEventStream();
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "child done" }],
						api: model.api,
						provider: model.provider,
						model: requestModel.id,
						usage: usage(),
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				},
			});
			fixture.onCleanup(() => runtime.unregisterProvider(model.provider));
			// The session the child's options come from: its children load the real Intercom extension as a builtin.
			const { session: optionsSource } = await createAgentSession({
				cwd,
				agentDir,
				modelRuntime: runtime,
				model,
				thinkingLevel: "medium",
				settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, defaultThinkingLevel: "medium" }),
				sessionManager: await SessionManager.create(cwd, join(cwd, "parent-sessions")),
				builtins: { subagents: false, intercom: true, mcp: false, "web-access": false },
				tools: ["read", "intercom", "contact_supervisor"],
			});
			fixture.onCleanup(() => optionsSource.dispose());

			// A child-only extension: the first start stalls in session_start past its budget, then lets go.
			let starts = 0;
			const retryDisposing = Promise.withResolvers<void>();
			const releaseRetry = Promise.withResolvers<void>();
			globals[STALL_HOOK] = (point) => {
				if (point === "start") return ++starts === 1 ? sleep(STALL_MS) : undefined;
				if (starts !== 2) return undefined;
				retryDisposing.resolve();
				return releaseRetry.promise;
			};
			fixture.onCleanup(() => {
				releaseRetry.resolve();
				delete globals[STALL_HOOK];
			});
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(
				join(agentDir, "extensions", "stall.ts"),
				[
					"export default function (pi) {",
					`\tpi.on(${JSON.stringify(stallAt)}, async () => { await globalThis.${STALL_HOOK}?.("start"); });`,
					`\tpi.on("session_shutdown", async () => { await globalThis.${STALL_HOOK}?.("shutdown"); });`,
					"}",
				].join("\n"),
			);

			const parent = await launchingParent(cwd);
			const runId = `sr${randomUUID().slice(0, 6)}`;
			const childName = `subagent-worker-${runId}-1`;
			const authorization = await requestSupervisorAuthorization(parent.events, childName);
			assert.ok(authorization, "the launch has its capability");
			const startHold = await holdStartingChild({
				events: parent.events,
				intercomTarget: childName,
				authorization,
				group: "default",
				holdMs: subagentStartHoldMs(BUDGET_MS),
			});

			const peer = new IntercomClient(randomUUID());
			await peer.connect({
				name: "start-retry-third-party",
				model: "test-model",
				cwd,
				pid: process.pid,
				status: "idle",
				startedAt: Date.now(),
				lastActivity: Date.now(),
				group: "default",
				groups: ["default"],
			});
			fixture.onCleanup(() => peer.disconnect().catch(() => undefined));
			const heldSend = peer.send(childName, { text: "HELD-1 before the child registered" });
			const resumedSession = resume ? await SessionManager.create(cwd, join(cwd, "resumed-child")) : undefined;
			if (resumedSession) {
				await resumedSession.appendMessage({ role: "user", content: "previous task", timestamp: Date.now() });
				await resumedSession.appendCustomMessageEntry(
					"intercom_message",
					"PRIOR-1 saved before the child was resumed",
					true,
				);
				await resumedSession.appendCustomMessageEntry(
					"intercom_message",
					"PRIOR-2 saved before the child was resumed",
					true,
				);
			}

			const reports: string[] = [];
			let executions = 0;
			let executionCleanup: Promise<Cleanup> | undefined;
			let cleanupSettled = false;
			let gapSend: Promise<unknown> | undefined;
			const taskExecution: TaskExecutionHooks = {
				signal: new AbortController().signal,
				reportActivity() {},
				reportStart: (progress) => {
					if (progress === undefined) return;
					reports.push(`attempt ${progress.attempt}: ${progress.step}`);
					if (progress.attempt === 2 && gapSend === undefined)
						gapSend = peer.send(childName, { text: "GAP-2 while the first start stalled" });
				},
				onExecution(execution) {
					executions += 1;
					executionCleanup = execution.cleanup;
					void execution.cleanup.then(() => {
						cleanupSettled = true;
					});
				},
			};
			const agent: AgentConfig = {
				name: "worker",
				description: "retry fixture",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user",
				filePath: join(cwd, "worker.md"),
				tools: ["read", "intercom", "contact_supervisor"],
			};
			const result = await runSingleInProcess(cwd, agent, "reply done", {
				cwd,
				sessionStartTimeoutMs: BUDGET_MS,
				runId,
				index: 0,
				sessionDir: join(cwd, "children"),
				testSession: false,
				modelOverride: `${model.provider}/${model.id}`,
				knownModelProviders: [model.provider],
				currentModel: `${model.provider}/${model.id}`,
				currentThinkingLevel: "medium",
				availableModels: [{ provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}` }],
				getChildSessionOptions: optionsSource.extensionRunner.createContext().getChildSessionOptions,
				intercomSessionName: childName,
				supervisorAuthorization: authorization,
				orchestratorIntercomTarget: authorization.supervisorSessionId,
				intercomGroup: "default",
				intercomEvents: parent.events as never,
				...(resumedSession ? { sessionManager: resumedSession, resumeSession: true } : {}),
				onStartRetry: () => startHold.renew(),
				taskExecution,
			});
			startHold.settle(result);
			try {
				assert.equal(starts, 2, "the first start stalled and was retried once");
				assert.equal(result.status, "ok", JSON.stringify(result));
				await retryDisposing.promise;
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(cleanupSettled, false, "the task still owns the retry while its session is disposing");
				assert.ok(executionCleanup);
			} finally {
				releaseRetry.resolve();
			}
			assert.deepEqual(await executionCleanup, { kind: "reaped" });
			const held = (await heldSend) as { delivered?: boolean; reason?: string };
			const gap = (await gapSend) as { delivered?: boolean; reason?: string } | undefined;
			const seen = (text: string) => contexts.some((context) => context.includes(text));

			assert.equal(held.delivered, true, held.reason);
			assert.ok(seen("HELD-1"), "a send held before the first start registered reaches the retry's first turn");
			assert.ok(gap, "a send was made while the start was retried");
			assert.equal(gap.delivered, true, gap.reason);
			assert.ok(seen("GAP-2"), "a send made while the start was retried reaches the retry's first turn");
			const first = contexts[0] ?? "";
			const expectedMarkers = [...(resume ? ["PRIOR-1", "PRIOR-2"] : []), "HELD-1", "GAP-2"];
			for (const marker of expectedMarkers) {
				assert.ok(
					first.includes(marker),
					`the child's first model request includes ${marker}: ${contexts.length} requests`,
				);
				assert.equal(first.split(marker).length - 1, 1, `${marker} appears once in the retry's first-turn context`);
			}
			if (resumedSession) assert.equal(result.sessionFile, resumedSession.getSessionFile());
			assert.equal(executions, 1, "the task has one execution, its retried start included");
			assert.ok(
				reports.some((report) => report.startsWith("attempt 2")),
				"the retry reported its start",
			);
		},
		REAL_RETRY_TEST_TIMEOUT_MS,
	);
