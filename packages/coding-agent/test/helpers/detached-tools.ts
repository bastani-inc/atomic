/**
 * Fixtures for the detached tool call suites (#4309): tools whose calls end only when a test says so, harnesses over a
 * shared session store, and the few assertions about transcripts those suites repeat.
 */
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { DetachedToolResult } from "../../src/core/agent-session-detached-tools.js";
import type { ExtensionFactory, ToolDefinition } from "../../src/core/extensions/index.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";
import { createHarness, type Harness } from "../suite/harness.js";

export interface WaitTool {
	readonly definition: ToolDefinition;
	readonly calls: { readonly id: string; readonly args: Readonly<Record<string, string>> }[];
	finish(index: number, text: string): void;
	finishWith(index: number, result: AgentToolResult): void;
	fail(index: number, reason: Error | string): void;
	readonly aborts: string[];
}

/** A detachable tool whose calls end only when the test finishes them. */
export function waitTool(
	options: { readonly detachable?: boolean; readonly name?: string; readonly rejectOnAbort?: boolean } = {},
): WaitTool {
	const calls: { id: string; args: Readonly<Record<string, string>> }[] = [];
	const pending: PromiseWithResolvers<AgentToolResult>[] = [];
	const aborts: string[] = [];
	return {
		calls,
		aborts,
		finish(index, text) {
			pending[index]?.resolve({ content: [{ type: "text", text }], details: undefined });
		},
		finishWith(index, result) {
			pending[index]?.resolve(result);
		},
		fail(index, reason) {
			pending[index]?.reject(reason);
		},
		definition: {
			name: options.name ?? "wait_for_ci",
			label: "Wait for CI",
			description: "Waits for a CI run",
			parameters: Type.Object({ run: Type.String() }),
			...(options.detachable === false ? {} : { detachable: true }),
			execute: async (toolCallId, params, signal) => {
				calls.push({ id: toolCallId, args: params as Readonly<Record<string, string>> });
				const deferred = Promise.withResolvers<AgentToolResult>();
				pending.push(deferred);
				const aborted = (): void => {
					aborts.push(String(signal?.reason));
					if (options.rejectOnAbort === true) deferred.reject(signal?.reason);
				};
				if (signal?.aborted) aborted();
				else signal?.addEventListener("abort", aborted, { once: true });
				return deferred.promise;
			},
		},
	};
}

export function fastTool(): ToolDefinition {
	return {
		name: "read_status",
		label: "Read status",
		description: "Reads a status",
		parameters: Type.Object({}),
		detachable: true,
		execute: async () => ({ content: [{ type: "text", text: "green" }], details: undefined }),
	};
}

/** The wrapped tool the session registered under `name`, as the agent loop runs it. */
export function registeredTool(harness: Harness, name: string): AgentTool {
	const tool = harness.session.agent.state.tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`tool ${name} is not registered`);
	return tool;
}

export interface HarnessPool {
	harnessWith(
		customTools: ToolDefinition[],
		sessionManager?: SessionManager,
		extensionFactories?: ExtensionFactory[],
	): Promise<Harness>;
	cleanup(): Promise<void>;
}

/** Harnesses created through the pool are cleaned up together. */
export function harnessPool(): HarnessPool {
	const harnesses: Harness[] = [];
	return {
		async harnessWith(customTools, sessionManager, extensionFactories) {
			const harness = await createHarness({
				customTools,
				...(sessionManager === undefined ? {} : { sessionManager }),
				...(extensionFactories === undefined ? {} : { extensionFactories }),
			});
			harnesses.push(harness);
			return harness;
		},
		async cleanup() {
			while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		},
	};
}

export async function persistedManager(): Promise<{
	readonly store: MemorySessionStore;
	readonly manager: SessionManager;
}> {
	const store = new MemorySessionStore();
	return { store, manager: await SessionManager.create(store, process.cwd()) };
}

export function transcriptRoles(manager: SessionManager): string[] {
	return manager
		.buildSessionProjection()
		.messages.filter((message) => message.role !== "system")
		.map((message) => message.role);
}

export function toolResultIds(manager: SessionManager): string[] {
	return manager
		.buildSessionProjection()
		.messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
}

/** A tool-use assistant message calling `wait_for_ci` once, with `id`. */
export function waitForCiTurn(id: string, run = "7") {
	return fauxAssistantMessage([fauxToolCall("wait_for_ci", { run }, { id })], { stopReason: "toolUse" });
}

/** The result a host hands back for `toolCallId`. */
export function detachedResult(
	toolCallId: string,
	text: string,
	extra: Partial<Pick<AgentToolResult, "usage" | "details">> & {
		readonly toolName?: string;
		readonly isError?: boolean;
	} = {},
): DetachedToolResult {
	const { toolName, isError, ...result } = extra;
	return {
		toolCallId,
		toolName: toolName ?? "wait_for_ci",
		result: { content: [{ type: "text", text }], details: undefined, ...result },
		isError: isError === true,
	};
}

/** Fails instead of hanging the suite when `promise` never settles. */
export async function settlesWithin<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Resolves once the tool has started `count` calls. */
export async function untilStarted(tool: WaitTool, count = 1): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (tool.calls.length < count) {
		if (Date.now() > deadline) throw new Error(`the tool started ${tool.calls.length} of ${count} calls`);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/** A session that detached `ci-1` (and whatever else `turns` call), reopened from its store. */
export async function reopenedAfterDetaching(
	pool: HarnessPool,
	tools: ToolDefinition[],
	turns: Parameters<Harness["setResponses"]>[0],
	extensionFactories?: ExtensionFactory[],
): Promise<{ readonly reopened: Harness; readonly store: MemorySessionStore; readonly sessionId: string }> {
	const { manager, store } = await persistedManager();
	const first = await pool.harnessWith(tools, manager);
	first.session.setToolDetachment({ afterMs: 0 });
	first.setResponses(turns);
	await first.session.prompt("watch ci");
	first.session.takeDetachedToolCalls();
	const sessionId = manager.getSessionId();
	const reopened = await pool.harnessWith(tools, await SessionManager.open(store, sessionId), extensionFactories);
	return { reopened, store, sessionId };
}
