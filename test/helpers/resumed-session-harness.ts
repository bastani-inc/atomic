import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import type { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import type { SubagentChildRestoreDeps } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: unknown) => void;

export type Supervisor = { capability: string; supervisorSessionId: string };

export const SUPERVISOR_AUTHORIZATION_EVENT = "subagent:supervisor-authorization";

export const worker: AgentConfig = {
	name: "worker",
	description: "worker",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

/** The event bus the extensions of one Atomic session share. */
export function eventBus() {
	const handlers = new Map<string, EventHandler[]>();
	return {
		on(eventName: string, handler: EventHandler) {
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

export interface ResumedSessionOptions {
	readonly name: string;
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly host: AgentTaskHost;
	/** The lightweight Intercom extension, loaded last as in the host's bundled-extension order. */
	readonly intercom: (pi: never) => unknown;
	/** Extensions loaded before Intercom (workflows, subagents), in order, on the same event bus. */
	readonly extensions?: ReadonlyArray<
		(pi: never, session: { readonly events: ReturnType<typeof eventBus> }) => unknown
	>;
	readonly orchestrationContext?: object;
}

/**
 * A resumed Atomic session with its real Intercom extension, and any other real extensions, sharing one event bus
 * and firing lifecycle events in load order. Nothing here is Intercom's or the subagents' own logic.
 */
export function resumedSession(options: ResumedSessionOptions) {
	const { name, cwd, sessionManager, host } = options;
	const events = eventBus();
	const handlers = new Map<string, Handler[]>();
	let activeTools: string[] = [];
	const appendEntry = async (customType: string, data?: unknown) => {
		await sessionManager.appendCustomEntry(customType, data);
	};
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry,
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => name,
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events,
	};
	for (const extension of options.extensions ?? []) extension(pi as never, { events });
	options.intercom(pi as never);
	const ctx = {
		hasUI: false,
		cwd,
		isIdle: () => true,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager,
		getAgentTaskHost: () => host,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		ui: { confirm: async () => true, notify() {} },
		...(options.orchestrationContext ? { orchestrationContext: options.orchestrationContext } : {}),
	} as unknown as ExtensionContext;
	/** Every handler of the event in load order, awaited; their results, as a host that merges them would see them. */
	const fire = async (eventName: string, event: object): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const handler of handlers.get(eventName) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	return {
		ctx,
		events,
		/** The host starts the session: every extension sees `session_start`, and nothing recovers yet. */
		start: async (): Promise<void> => {
			await fire("session_start", { type: "session_start", reason: "resume" });
		},
		fire,
		/** A broker capability for another child of this session, as a fresh launch would get. */
		authorize(childName: string): Promise<Supervisor> {
			const request: { childName: string; completion?: Promise<Supervisor> } = { childName };
			events.emit(SUPERVISOR_AUTHORIZATION_EVENT, request);
			assert.ok(request.completion, "Intercom must answer the supervisor authorization request");
			return request.completion;
		},
		/** Restoration that relaunches the child in-process; the relaunched child keeps running until its host closes. */
		restoreDeps(launched: RunSyncOptions[]): SubagentChildRestoreDeps {
			return {
				pi: { events, appendEntry, getSessionName: () => name } as never,
				config: {},
				discoverAgents: () => ({ agents: [worker] }),
				runtime: {
					runSync: (...args) => {
						launched.push(args[4]);
						return runSync(args[0], args[1], args[2], args[3], {
							...args[4],
							testSession: { output: "never", promptGate: new Promise(() => {}), abortResolvesPrompt: true },
						});
					},
				},
			};
		},
		shutdown: async (): Promise<void> => {
			await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		},
	};
}
