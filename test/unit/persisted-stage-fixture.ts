import type { AgentSession, SessionManager, SessionStore } from "@bastani/atomic";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { StageAdapters, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { mockSession } from "./executor-shared.js";

type SessionEvent = Parameters<StageSessionRuntime["subscribe"]>[0] extends (event: infer T) => void ? T : never;
type SessionListener = (event: SessionEvent) => void;

/** What a stage session reports while it still has work. Each field maps to one SDK signal. */
export interface PersistedStageActivity {
	streaming: boolean;
	compacting: boolean;
	retrying: boolean;
	pendingMessages: number;
	queuedMessagesPaused: boolean;
}

/** One adapter-created stage session whose conversation is saved in the fixture's session store. */
export interface PersistedStageSession {
	readonly session: StageSessionRuntime;
	readonly manager: SessionManager;
	readonly prompts: string[];
	readonly activity: PersistedStageActivity;
	readonly disposals: number;
	emit(event: SessionEvent): void;
	listenerCount(): number;
}

export interface PersistedStageFixture {
	readonly store: SessionStore;
	readonly adapters: StageAdapters;
	readonly sessions: PersistedStageSession[];
	disposals(): number;
}

type StageSessionCreateOptions = Parameters<NonNullable<StageAdapters["agentSession"]>["create"]>[0];

export interface PersistedStageFixtureOptions {
	readonly store?: SessionStore;
	/** Runs as each session is created; the returned cleanup runs when that session is disposed. */
	readonly onCreate?: (createOptions: StageSessionCreateOptions) => Promise<(() => Promise<void>) | undefined>;
	/** Assistant text each prompt answers with, saved to the conversation after the user message. */
	readonly reply?: (text: string) => string;
	readonly onPrompt?: (text: string, record: PersistedStageSession) => Promise<void> | void;
	readonly onSteer?: (text: string, record: PersistedStageSession) => Promise<void> | void;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Stage adapters whose sessions persist like real SDK sessions: the stage options carry a session
 * manager over `store`, every prompt appends to it, and `resumeFromSessionId` reopens the saved
 * conversation instead of starting a new one.
 */
export function createPersistedStageFixture(options: PersistedStageFixtureOptions = {}): PersistedStageFixture {
	const store = options.store ?? new MemorySessionStore();
	const sessions: PersistedStageSession[] = [];
	const adapters: StageAdapters = {
		sessionStore: store,
		agentSession: {
			async create(createOptions) {
				const manager = createOptions.sessionManager;
				if (manager === undefined) throw new Error("persisted stage fixture requires a session manager");
				const cleanup = await options.onCreate?.(createOptions);
				const listeners = new Set<SessionListener>();
				const prompts: string[] = [];
				const activity: PersistedStageActivity = {
					streaming: false,
					compacting: false,
					retrying: false,
					pendingMessages: 0,
					queuedMessagesPaused: false,
				};
				let disposals = 0;
				const session: StageSessionRuntime & { readonly isCompacting: boolean; readonly isRetrying: boolean } = {
					...mockSession(manager),
					async prompt(text: string) {
						prompts.push(text);
						await options.onPrompt?.(text, record);
						const user: AgentSession["messages"][number] = { role: "user", content: text, timestamp: Date.now() };
						await manager.appendMessage(user);
						for (const listener of [...listeners]) listener({ type: "message_end", message: user });
						const reply = options.reply?.(text);
						if (reply === undefined) return;
						const answer = assistantMessage(reply);
						await manager.appendMessage(answer);
						for (const listener of [...listeners]) listener({ type: "message_end", message: answer });
					},
					async steer(text: string) {
						await options.onSteer?.(text, record);
					},
					subscribe(listener: SessionListener) {
						listeners.add(listener);
						return () => {
							listeners.delete(listener);
						};
					},
					get messages() {
						return manager.buildSessionContext().messages as AgentSession["messages"];
					},
					get isStreaming() {
						return activity.streaming;
					},
					get isCompacting() {
						return activity.compacting;
					},
					get isRetrying() {
						return activity.retrying;
					},
					get pendingMessageCount() {
						return activity.pendingMessages;
					},
					get queuedMessagesPaused() {
						return activity.queuedMessagesPaused;
					},
					async dispose() {
						disposals += 1;
						await cleanup?.();
					},
				};
				const record: PersistedStageSession = {
					session,
					manager,
					prompts,
					activity,
					get disposals() {
						return disposals;
					},
					emit(event) {
						for (const listener of [...listeners]) listener(event);
					},
					listenerCount: () => listeners.size,
				};
				sessions.push(record);
				return session;
			},
		},
	};
	return { store, adapters, sessions, disposals: () => sessions.reduce((sum, record) => sum + record.disposals, 0) };
}
