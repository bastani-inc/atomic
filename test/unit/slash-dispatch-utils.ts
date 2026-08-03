// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type {
	ExtensionAPI,
	PiArgumentCompletion,
	PiCommandContext,
	PiCommandOptions,
	PiToolOpts,
	WorkflowToolArgs,
} from "../../packages/workflows/src/extension/index.js";
import {
	makeExecuteWorkflowTool,
	parseWorkflowArgs,
	tokenizeWorkflowArgs,
	WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
	workflowPolicyFromContext,
} from "../../packages/workflows/src/extension/index.js";
import { LIFECYCLE_NOTICE_CUSTOM_TYPE } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime, type ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import type {
	PiCustomComponent,
	PiCustomOverlayFactoryTui,
	PiCustomOverlayFunction,
	PiCustomOverlayOptions,
	PiOverlayHandle,
} from "../../packages/workflows/src/extension/wiring.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { killAllRuns } from "../../packages/workflows/src/runs/background/status.js";
import {
	type StageControlHandle,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { stageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition, WorkflowPersistencePort } from "../../packages/workflows/src/shared/types.js";
import { WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE } from "../../packages/workflows/src/shared/workflow-failures.js";
import type { ChatSurfacePayload } from "../../packages/workflows/src/tui/chat-surface-message.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

export type {
	ChatSurfacePayload,
	ExtensionAPI,
	ExtensionRuntime,
	PiArgumentCompletion,
	PiCommandContext,
	PiCommandOptions,
	PiCustomComponent,
	PiCustomOverlayFactoryTui,
	PiCustomOverlayFunction,
	PiCustomOverlayOptions,
	PiOverlayHandle,
	PiToolOpts,
	SessionEntry,
	StageControlHandle,
	StageSessionRuntime,
	WorkflowDefinition,
	WorkflowPersistencePort,
	WorkflowToolArgs,
	WorkflowToolResult,
};
export {
	assert,
	buildStagePromptAdapter,
	cancellationRegistry,
	createExtensionRuntime,
	createRegistry,
	jobTracker,
	join,
	killAllRuns,
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
	makeExecuteWorkflowTool,
	mkdtemp,
	parseWorkflowArgs,
	renderResult,
	restoreOnSessionStart,
	rm,
	stageControlRegistry,
	stageUiBroker,
	store,
	Type,
	tmpdir,
	tokenizeWorkflowArgs,
	WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
	WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
	WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
	workflow,
	workflowPolicyFromContext,
	writeFile,
};

export function resetSlashDispatchTestStateBeforeEach(): void {
	delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
	setDurableBackend(new InMemoryDurableBackend());
}

export async function cleanupSlashDispatchTestStateAfterEach(): Promise<void> {
	delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
	stageControlRegistry.clear();
	killAllRuns({ store, cancellation: cancellationRegistry });
	await Promise.all(jobTracker.runIds().map((runId) => jobTracker.get(runId)?.promise));
	store.clear();
	setDurableBackend(undefined);
}

export function installSlashDispatchTestHooks(): void {
	beforeEach(resetSlashDispatchTestStateBeforeEach);
	afterEach(cleanupSlashDispatchTestStateAfterEach);
}

export async function writeWorkflowFixture(filePath: string, name: string): Promise<void> {
	const encodedName = JSON.stringify(name);
	await writeFile(
		filePath,
		`import { workflow } from "@bastani/workflows";
export default workflow({
  name: ${encodedName},
  description: "",
  inputs: {},
  outputs: {},
  run: async () => ({}),
});
`,
		"utf8",
	);
}

export interface RegisteredCommand {
	name: string;
	options: PiCommandOptions;
}

export interface SentMessage {
	customType?: string;
	content?: string;
	display?: boolean;
	details?: unknown;
}

export function buildMockPi(): {
	pi: ExtensionAPI;
	commands: RegisteredCommand[];
	sent: SentMessage[];
} {
	const commands: RegisteredCommand[] = [];
	const sent: SentMessage[] = [];
	const pi: ExtensionAPI = {
		registerCommand: (name: string, options: PiCommandOptions) => {
			commands.push({ name, options });
		},
		// Chat surfaces dispatch via `emitChatSurface` → `pi.sendMessage`.
		// Mirror the message store so tests can observe the message stream.
		sendMessage: (msg: SentMessage) => {
			sent.push(msg);
		},
	};
	return { pi, commands, sent };
}

export function buildCtx(): { ctx: PiCommandContext; messages: string[] } {
	const messages: string[] = [];
	const ctx: PiCommandContext = {
		ui: {
			notify(msg: string) {
				messages.push(msg);
			},
		},
	};
	return { ctx, messages };
}

export function addFactoryStubs(pi: ExtensionAPI): void {
	pi.registerTool = () => {};
	pi.registerMessageRenderer = () => {};
	pi.registerFlag = () => {};
	pi.on = () => {};
	pi.ui = { setWidget: () => {} };
	pi.createAgentSession = async () => ({ session: fakeAgentSession() });
	pi.disableAsyncDiscovery = true;
}

export function fakeAgentSession(): StageSessionRuntime {
	let last = "";
	return {
		async prompt(text: string): Promise<string> {
			last = `stub:${text.slice(0, 24)}`;
			return last;
		},
		async steer(text: string): Promise<void> {
			last = `steer:${text}`;
		},
		async followUp(text: string): Promise<void> {
			last = `follow:${text}`;
		},
		subscribe: () => () => {},
		sessionFile: undefined,
		sessionId: "slash-dispatch-test-session",
		async setModel(): Promise<void> {},
		setThinkingLevel(): void {},
		async cycleModel(): Promise<undefined> {
			return undefined;
		},
		cycleThinkingLevel(): undefined {
			return undefined;
		},
		agent: {} as StageSessionRuntime["agent"],
		model: undefined,
		thinkingLevel: "medium" as StageSessionRuntime["thinkingLevel"],
		messages: [],
		isStreaming: false,
		async navigateTree(): Promise<{ cancelled: boolean }> {
			return { cancelled: true };
		},
		async compact(): ReturnType<StageSessionRuntime["compact"]> {
			return undefined as unknown as Awaited<ReturnType<StageSessionRuntime["compact"]>>;
		},
		abortCompaction(): void {},
		async abort(): Promise<void> {},
		dispose(): void {},
		getLastAssistantText(): string | undefined {
			return last;
		},
	};
}

export async function runFactory(pi: ExtensionAPI): Promise<void> {
	addFactoryStubs(pi);
	const factoryModule = await import("../../packages/workflows/src/extension/index.js");
	factoryModule.default(pi);
}

// ---------------------------------------------------------------------------
// Slash dispatch: non-admin first token → workflow name run
// ---------------------------------------------------------------------------

export function makeInflightRun(id: string) {
	return {
		id,
		name: "test-wf",
		inputs: {},
		status: "running" as const,
		stages: [],
		startedAt: Date.now(),
	};
}

export async function registerWorkflowCommand() {
	const { pi, commands, sent } = buildMockPi();
	addFactoryStubs(pi);
	const factoryModule = await import("../../packages/workflows/src/extension/index.js");
	factoryModule.default(pi);
	const workflowCmd = commands.find((c) => c.name === "workflow");
	assert.notEqual(workflowCmd, undefined);
	return { pi, commands, sent, workflowCmd: workflowCmd! };
}

export function recordTerminalRun(
	id: string,
	status: "completed" | "failed" | "killed",
	overrides: { name?: string; startedAt?: number; endedAt?: number } = {},
): void {
	store.recordRunStart({
		...makeInflightRun(id),
		name: overrides.name ?? "terminal-wf",
		startedAt: overrides.startedAt ?? Date.now() - 10_000,
	});
	const completed = status === "completed";
	store.recordRunEnd(id, status, completed ? { ok: true } : undefined, completed ? undefined : status);
	if (overrides.endedAt !== undefined) {
		const run = store.runs().find((r) => r.id === id);
		if (run) {
			run.endedAt = overrides.endedAt;
			run.durationMs = run.endedAt - run.startedAt;
		}
	}
}

export function registerTestStageHandle(
	runId: string,
	stageId: string,
	status: StageControlHandle["status"] = "running",
	controls: Partial<Pick<StageControlHandle, "pause" | "resume">> = {},
): void {
	const handle: StageControlHandle = {
		runId,
		stageId,
		stageName: "worker",
		status,
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached(): Promise<void> {},
		async prompt(): Promise<void> {},
		async steer(): Promise<void> {},
		async followUp(): Promise<void> {},
		pause: controls.pause ?? (async () => {}),
		resume: controls.resume ?? (async () => {}),
		subscribe: () => () => {},
	};
	stageControlRegistry.register(handle);
}

export async function makeRegisteredWorkflowTool(): Promise<PiToolOpts<WorkflowToolArgs, WorkflowToolResult>> {
	const { pi } = buildMockPi();
	addFactoryStubs(pi);
	let registered: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> | undefined;
	pi.registerTool = (opts) => {
		registered = opts as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
	};
	const factoryModule = await import("../../packages/workflows/src/extension/index.js");
	factoryModule.default(pi);
	assert.ok(registered, "expected workflow tool registration");
	return registered;
}

export async function makeRegisteredWorkflowToolWithResource(
	fileName: string,
	source: string,
): Promise<{
	tool: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
	sent: SentMessage[];
	cleanup: () => Promise<void>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-tool-"));
	const filePath = join(dir, fileName);
	await writeFile(filePath, source, "utf8");

	const { pi, sent } = buildMockPi();
	addFactoryStubs(pi);
	pi.disableAsyncDiscovery = false;
	pi.getWorkflowResources = () => [{ path: filePath, enabled: true }];

	const events = new Map<string, Array<Parameters<NonNullable<ExtensionAPI["on"]>>[1]>>();
	pi.on = (event, handler) => {
		const handlers = events.get(event) ?? [];
		handlers.push(handler);
		events.set(event, handlers);
	};

	let registered: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> | undefined;
	pi.registerTool = (opts) => {
		registered = opts as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
	};

	const factoryModule = await import("../../packages/workflows/src/extension/index.js");
	factoryModule.default(pi);

	for (const startHandler of events.get("session_start") ?? []) {
		await startHandler({}, { hasUI: false, ui: { notify: () => undefined } });
	}

	assert.ok(registered, "expected workflow tool registration");
	return {
		tool: registered,
		sent,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

export function registerLiveStageHandle(
	runId: string,
	stageId: string,
	options?: {
		status?: StageControlHandle["status"];
		isStreaming?: boolean;
		messages?: StageControlHandle["messages"];
	},
): {
	followUps: string[];
	prompts: string[];
	steers: string[];
	dispose: () => void;
} {
	const followUps: string[] = [];
	const prompts: string[] = [];
	const steers: string[] = [];
	const handle: StageControlHandle = {
		runId,
		stageId,
		stageName: "ask",
		status: options?.status ?? "running",
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: options?.isStreaming ?? false,
		messages: options?.messages ?? [],
		async ensureAttached(): Promise<void> {},
		async sendUserMessage(text, delivery, beforeDelivery) {
			beforeDelivery?.();
			if (!(options?.isStreaming ?? false)) {
				prompts.push(text);
				return "prompt";
			}
			const action = delivery?.deliverAs ?? "followUp";
			(action === "steer" ? steers : followUps).push(text);
			return action;
		},
		async prompt(text: string): Promise<void> {
			prompts.push(text);
		},
		async steer(text: string): Promise<void> {
			steers.push(text);
		},
		async followUp(text: string): Promise<void> {
			followUps.push(text);
		},
		async pause(): Promise<void> {},
		async resume(_message, beforeResume): Promise<void> {
			beforeResume?.();
		},
		subscribe: () => () => {},
	};
	return {
		followUps,
		prompts,
		steers,
		dispose: stageControlRegistry.register(handle),
	};
}

export async function waitForToolPrompt(
	runId: string,
	timeoutMs = 1000,
): Promise<{ stageId: string; promptId: string }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const run = store.runs().find((candidate) => candidate.id === runId);
		const stage = run?.stages.find((candidate) => candidate.pendingPrompt !== undefined);
		if (stage?.pendingPrompt) return { stageId: stage.id, promptId: stage.pendingPrompt.id };
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`pending prompt did not appear for run ${runId}`);
}

export async function waitForToolRunEnded(runId: string, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const run = store.runs().find((candidate) => candidate.id === runId);
		if (run?.endedAt !== undefined) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`run ${runId} did not end`);
}
