import type { KeyId } from "@bastani/atomic-tui";
import type { BuiltinPackageDirName } from "../builtin-install-layout.ts";
import type { EventBus } from "../event-bus.js";
import type { AgentPanelSource } from "../tasks/agent-panel-source.ts";
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ExtensionHandler,
	MessageRenderer,
	RegisteredCommand,
	SessionStartEvent,
	ToolDefinition,
	ToolRendererResolver,
} from "./types.ts";

export interface LifecycleLease<TShutdown> {
	readonly id: number;
	readonly priorCleanup: Promise<void>;
	retired: boolean;
	shutdown: TShutdown | null;
	cleanupBarrier: Promise<void>;
}

export function createLifecycleLease<TShutdown>(
	id: number,
	priorCleanup: Promise<void> = Promise.resolve(),
): LifecycleLease<TShutdown> {
	return { id, priorCleanup, retired: false, shutdown: null, cleanupBarrier: priorCleanup };
}

export function retireLifecycleLease<TShutdown>(lease: LifecycleLease<TShutdown>, shutdown: TShutdown): void {
	if (lease.retired) return;
	lease.retired = true;
	lease.shutdown = shutdown;
}

export function retainSettledLifecycleCleanup<TShutdown>(
	lease: LifecycleLease<TShutdown>,
	cleanup: readonly (Promise<unknown> | null)[],
): Promise<void> {
	const previousCleanup = lease.cleanupBarrier;
	const pendingCleanup = cleanup.filter((task): task is Promise<unknown> => task !== null);
	lease.cleanupBarrier = Promise.allSettled([previousCleanup, ...pendingCleanup]).then(() => undefined);
	return lease.cleanupBarrier;
}

export function isLeaseCurrent(activeLeaseId: number, expectedLeaseId: number, retired: boolean): boolean {
	if (retired) return false;
	return activeLeaseId === expectedLeaseId;
}

export function assertCurrentLifecycleLease<TShutdown>(
	current: LifecycleLease<TShutdown>,
	expected: LifecycleLease<TShutdown>,
	message: string,
): void {
	if (!isLeaseCurrent(current.id, expected.id, expected.retired) || current !== expected) {
		throw new Error(message);
	}
}

export function shouldBlockShutdownOnAttempt(
	retiringLeaseId: number,
	attemptLeaseId: number,
	isBackgroundOnly: boolean,
): boolean {
	if (attemptLeaseId !== retiringLeaseId) return false;
	return !isBackgroundOnly;
}

export function shouldForwardRegistrationToHost(isStaticName: boolean): boolean {
	return !isStaticName;
}

export function canStartActivationAttempt(activeLeaseId: number, inFlightLeaseId: number, retired: boolean): boolean {
	if (retired) return false;
	return inFlightLeaseId !== activeLeaseId;
}

/** Rejection-safe FIFO queue for lifecycle forwarding that must not overtake replay. */
export class SerializedLifecycleForwarder {
	private tail: Promise<void> = Promise.resolve();

	get settled(): Promise<void> {
		return this.tail;
	}

	enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

type CapturedCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;
type CapturedShortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];
type CapturedFlag = Parameters<ExtensionAPI["registerFlag"]>[1];
type HandlerFn = ExtensionHandler<unknown, unknown>;
type ToolExecuteArgs = Parameters<NonNullable<ToolDefinition["execute"]>>;
type ToolExecuteResult = Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>;

export interface CapturedLazyBuiltin {
	readonly tools: Map<string, ToolDefinition>;
	readonly commands: Map<string, CapturedCommand>;
	readonly shortcuts: Map<string, CapturedShortcut>;
	readonly flags: Map<string, CapturedFlag>;
	readonly handlers: Map<string, HandlerFn[]>;
	readonly eventHandlers: Map<string, Array<(data: unknown) => unknown>>;
	readonly messageRenderers: Map<string, MessageRenderer>;
	readonly entryRenderers: Map<string, EntryRenderer>;
	readonly toolRenderers: ToolRendererResolver[];
	readonly mcpContributionListeners: Array<() => void>;
	readonly disposables: Array<() => void>;
}

export interface LazyBuiltinHandle {
	readonly captured: CapturedLazyBuiltin;
	assertCurrent(): void;
}

export type StaticSurfaceKind = "tool" | "command" | "shortcut" | "flag" | "messageRenderer" | "entryRenderer";

export interface LazyBuiltinController {
	/** Loaded implementation handle on the current active lease, or null while dormant/activating. */
	readonly active: LazyBuiltinHandle | null;
	/** Whether the current lease is active and not retired. */
	isCurrentLease(): boolean;
	/** Activate (or join in-flight activation) for the current lease. `background: true` will not block shutdown. */
	activate(ctx?: ExtensionContext, options?: { background?: boolean }): Promise<LazyBuiltinHandle>;
	/** Execute a statically registered tool by activating lazily, respecting caller AbortSignal and lease fence. */
	executeTool(name: string, args: ToolExecuteArgs): Promise<ToolExecuteResult>;
	/** Run a statically registered command by activating lazily, enforcing the lease fence. */
	runCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<void>;
	/** Run a statically registered shortcut by activating lazily, enforcing the lease fence. */
	runShortcut(shortcut: string, ctx: ExtensionContext): Promise<void>;
	/** Dispatch an event to the loaded implementation's captured `pi.on` handlers. */
	dispatchHandlers(eventName: string, event: unknown, ctx: ExtensionContext): Promise<unknown>;
	/** Dispatch an event to the loaded implementation's captured `pi.events.on` handlers. */
	dispatchBusEvent(channel: string, payload: unknown): Promise<void>;
	/** Most recent lifecycle context observed in this session generation. */
	latestContext(): ExtensionContext | undefined;
	/** Register a cleanup callback invoked on session_shutdown (including dormant rollback). */
	onDormantShutdown(cleanup: () => void): void;
	/** Register a hook invoked during session_start after lifecycle snapshot update. */
	onSessionStart(
		hook: (
			event: SessionStartEvent,
			ctx: ExtensionContext,
			controller: LazyBuiltinController,
		) => void | Promise<void>,
	): void;
	/** Register a hook invoked during session_tree after lifecycle snapshot update. */
	onSessionTree(
		hook: (event: unknown, ctx: ExtensionContext, controller: LazyBuiltinController) => void | Promise<void>,
	): void;
	/** Register a hook invoked during agent_start. */
	onAgentStart(
		hook: (event: unknown, ctx: ExtensionContext, controller: LazyBuiltinController) => void | Promise<void>,
	): void;
	/** Register a hook invoked after activation replays lifecycle events, before callers resume. */
	onActivated(hook: (handle: LazyBuiltinHandle, ctx: ExtensionContext | undefined) => void | Promise<void>): void;
	/** Record an additional static surface name so captureProxy does not overwrite it on activation. */
	markStaticSurface(kind: StaticSurfaceKind, name: string): void;
}

export interface LazyBuiltinSpec {
	readonly label: string;
	/** Additional `pi.on` events managed by the lazy wrapper (captured instead of re-subscribed on `pi`). */
	readonly managedEvents?: readonly string[];
	/** `pi.events` channels intercepted by the lazy wrapper (captured instead of re-subscribed on `pi.events`). */
	readonly interceptedBusEvents?: readonly string[];
	/** Whether the lazy wrapper owns `pi.onMcpServerContributionsChanged`. */
	readonly interceptsMcpContributions?: boolean;
	/** Optional callback when an activation attempt fails. */
	readonly onActivationError?: (error: unknown, ctx: ExtensionContext | undefined) => void;
	/** Register static tools, commands, shortcuts, flags, renderers, and fast-path event handlers on `pi`. */
	register(pi: ExtensionAPI, controller: LazyBuiltinController): void | Promise<void>;
}

const DEFAULT_MANAGED_EVENTS: readonly string[] = [
	"session_start",
	"session_tree",
	"session_shutdown",
	"turn_start",
	"turn_end",
	"agent_start",
	"agent_end",
	"message_start",
	"tool_execution_start",
	"tool_execution_end",
	"model_select",
];

type ShutdownSnapshot = {
	event: unknown;
	ctx: ExtensionContext;
	generation: number;
};
type LazyLease = LifecycleLease<ShutdownSnapshot>;
type SessionSnapshot = {
	eventName: "session_start" | "session_tree";
	event: unknown;
	ctx: ExtensionContext;
	generation: number;
	lease: LazyLease;
};
type LifecycleEventSnapshot = {
	event: unknown;
	ctx: ExtensionContext;
};
type ActiveLifecycleState = {
	turnStart: LifecycleEventSnapshot | null;
	agentStart: LifecycleEventSnapshot | null;
	pendingMessages: LifecycleEventSnapshot[];
	activeTools: Map<string, LifecycleEventSnapshot>;
	modelSelect: LifecycleEventSnapshot | null;
};
type InFlightAttempt = {
	lease: LazyLease;
	promise: Promise<LazyBuiltinHandle>;
	background: boolean;
};
type ActiveReplay = {
	lease: LazyLease;
	captured: CapturedLazyBuiltin;
	promise: Promise<void>;
};
type LoadedEntry = {
	lease: LazyLease;
	handle: LazyBuiltinHandle;
};

interface StaticSurfaceSets {
	readonly tools: Set<string>;
	readonly commands: Set<string>;
	readonly shortcuts: Set<string>;
	readonly flags: Set<string>;
	readonly messageRenderers: Set<string>;
	readonly entryRenderers: Set<string>;
}

function createEmptyCaptured(): CapturedLazyBuiltin {
	return {
		tools: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		handlers: new Map(),
		eventHandlers: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		toolRenderers: [],
		mcpContributionListeners: [],
		disposables: [],
	};
}

async function dispatchCapturedHandlers(
	captured: CapturedLazyBuiltin,
	eventName: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<unknown> {
	let lastResult: unknown;
	for (const handler of [...(captured.handlers.get(eventName) ?? [])]) {
		const result = await handler(event, ctx);
		if (result !== undefined) lastResult = result;
	}
	return lastResult;
}

async function dispatchCapturedBusEvent(
	captured: CapturedLazyBuiltin,
	channel: string,
	payload: unknown,
): Promise<void> {
	for (const handler of [...(captured.eventHandlers.get(channel) ?? [])]) {
		await handler(payload);
	}
}

function disposeCapturedResources(captured: CapturedLazyBuiltin): void {
	for (const dispose of captured.disposables.splice(0).reverse()) {
		try {
			dispose();
		} catch {
			// Release every remaining subscription even if one cleanup fails.
		}
	}
	captured.mcpContributionListeners.length = 0;
}

function waitWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => reject(signal.reason));
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
		if (signal.aborted) onAbort();
	});
}

function createStaticRecordingApi(pi: ExtensionAPI, surface: StaticSurfaceSets): ExtensionAPI {
	return new Proxy(pi, {
		get(target, prop) {
			if (prop === "registerTool") {
				return (tool: ToolDefinition) => {
					surface.tools.add(tool.name);
					target.registerTool(tool);
				};
			}
			if (prop === "registerCommand") {
				return (name: string, options: CapturedCommand) => {
					surface.commands.add(name);
					target.registerCommand(name, options);
				};
			}
			if (prop === "registerShortcut") {
				return (shortcut: KeyId, options: CapturedShortcut) => {
					surface.shortcuts.add(shortcut);
					target.registerShortcut(shortcut, options);
				};
			}
			if (prop === "registerFlag") {
				return (name: string, options: CapturedFlag) => {
					surface.flags.add(name);
					target.registerFlag(name, options);
				};
			}
			if (prop === "registerMessageRenderer") {
				return <T>(customType: string, renderer: MessageRenderer<T>) => {
					surface.messageRenderers.add(customType);
					target.registerMessageRenderer(customType, renderer);
				};
			}
			if (prop === "registerEntryRenderer") {
				return <T>(customType: string, renderer: EntryRenderer<T>) => {
					surface.entryRenderers.add(customType);
					target.registerEntryRenderer(customType, renderer);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

const dispatchedShutdowns = new WeakSet<CapturedLazyBuiltin>();

async function dispatchCapturedShutdownOnce(
	captured: CapturedLazyBuiltin,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	if (dispatchedShutdowns.has(captured)) return;
	dispatchedShutdowns.add(captured);
	try {
		await dispatchCapturedHandlers(captured, "session_shutdown", event, ctx);
	} finally {
		disposeCapturedResources(captured);
	}
}

const FENCED_ACTION_PROPS: ReadonlySet<string | symbol> = new Set([
	"sendMessage",
	"sendMessages",
	"sendUserMessage",
	"appendEntry",
	"setSessionName",
	"setLabel",
	"setActiveTools",
	"setModel",
	"setThinkingLevel",
	"registerProvider",
	"registerProviderAlias",
	"unregisterProvider",
]);

function createCaptureProxy(
	pi: ExtensionAPI,
	captured: CapturedLazyBuiltin,
	surface: StaticSurfaceSets,
	managedEvents: ReadonlySet<string>,
	interceptedBusEvents: ReadonlySet<string>,
	interceptsMcpContributions: boolean,
	assertLease: () => void,
): ExtensionAPI {
	const eventsProxy: EventBus = {
		emit(channel, data) {
			assertLease();
			pi.events.emit(channel, data);
		},
		on(channel, handler) {
			assertLease();
			const list = captured.eventHandlers.get(channel) ?? [];
			list.push(handler);
			captured.eventHandlers.set(channel, list);
			let hostUnsub: (() => void) | undefined;
			if (!interceptedBusEvents.has(channel)) {
				hostUnsub = pi.events.on(channel, handler);
				captured.disposables.push(hostUnsub);
			}
			return () => {
				const current = captured.eventHandlers.get(channel);
				if (current) {
					const idx = current.indexOf(handler);
					if (idx !== -1) current.splice(idx, 1);
					if (current.length === 0) captured.eventHandlers.delete(channel);
				}
				hostUnsub?.();
			};
		},
	};

	return new Proxy(pi, {
		get(target, prop) {
			if (prop === "events") return eventsProxy;
			if (prop === "registerTool") {
				return (tool: ToolDefinition) => {
					assertLease();
					captured.tools.set(tool.name, tool);
					if (shouldForwardRegistrationToHost(surface.tools.has(tool.name))) {
						target.registerTool(tool);
					}
				};
			}
			if (prop === "registerCommand") {
				return (name: string, options: CapturedCommand) => {
					assertLease();
					captured.commands.set(name, options);
					if (shouldForwardRegistrationToHost(surface.commands.has(name))) {
						target.registerCommand(name, options);
					}
				};
			}
			if (prop === "registerShortcut") {
				return (shortcut: KeyId, options: CapturedShortcut) => {
					assertLease();
					captured.shortcuts.set(shortcut, options);
					if (shouldForwardRegistrationToHost(surface.shortcuts.has(shortcut))) {
						target.registerShortcut(shortcut, options);
					}
				};
			}
			if (prop === "registerFlag") {
				return (name: string, options: CapturedFlag) => {
					assertLease();
					captured.flags.set(name, options);
					if (shouldForwardRegistrationToHost(surface.flags.has(name))) {
						target.registerFlag(name, options);
					}
				};
			}
			if (prop === "registerMessageRenderer") {
				return <T>(customType: string, renderer: MessageRenderer<T>) => {
					assertLease();
					captured.messageRenderers.set(customType, renderer as MessageRenderer);
					if (shouldForwardRegistrationToHost(surface.messageRenderers.has(customType))) {
						target.registerMessageRenderer(customType, renderer);
					}
				};
			}
			if (prop === "registerEntryRenderer") {
				return <T>(customType: string, renderer: EntryRenderer<T>) => {
					assertLease();
					captured.entryRenderers.set(customType, renderer as EntryRenderer);
					if (shouldForwardRegistrationToHost(surface.entryRenderers.has(customType))) {
						target.registerEntryRenderer(customType, renderer);
					}
				};
			}
			if (prop === "registerToolRenderer") {
				return (resolver: ToolRendererResolver) => {
					assertLease();
					// Captured on the active lease only; the lazy wrapper's single delegating
					// toolRenderer routes to active.captured.toolRenderers without leaking failed attempts.
					captured.toolRenderers.push(resolver);
				};
			}
			if (prop === "registerAgentPanelSource") {
				return (source: AgentPanelSource) => {
					assertLease();
					const reg = target.registerAgentPanelSource(source);
					captured.disposables.push(() => reg.dispose());
					return reg;
				};
			}
			if (prop === "onMcpServerContributionsChanged" && target.onMcpServerContributionsChanged) {
				return (listener: () => void) => {
					assertLease();
					if (interceptsMcpContributions) {
						captured.mcpContributionListeners.push(listener);
						return () => {
							const idx = captured.mcpContributionListeners.indexOf(listener);
							if (idx !== -1) captured.mcpContributionListeners.splice(idx, 1);
						};
					}
					const unsub = target.onMcpServerContributionsChanged!(listener);
					captured.disposables.push(unsub);
					return unsub;
				};
			}
			if (prop === "on") {
				return (event: string, handler: HandlerFn) => {
					assertLease();
					const list = captured.handlers.get(event) ?? [];
					list.push(handler);
					captured.handlers.set(event, list);
					let hostUnsub: (() => void) | undefined;
					if (!managedEvents.has(event)) {
						hostUnsub = (target.on as (event: string, handler: HandlerFn) => () => void)(event, handler);
						captured.disposables.push(hostUnsub);
					}
					return () => {
						const current = captured.handlers.get(event);
						if (current) {
							const idx = current.indexOf(handler);
							if (idx !== -1) current.splice(idx, 1);
							if (current.length === 0) captured.handlers.delete(event);
						}
						hostUnsub?.();
					};
				};
			}
			const value = Reflect.get(target, prop, target);
			if (typeof value === "function") {
				if (FENCED_ACTION_PROPS.has(prop)) {
					return (...args: unknown[]) => {
						assertLease();
						return Reflect.apply(value, target, args);
					};
				}
				return value.bind(target);
			}
			return value;
		},
	});
}

/**
 * Create a lightweight ExtensionFactory that registers a builtin's static surface at startup and loads
 * its heavy implementation on first use, preserving lifecycle order, generational lease fences,
 * single-flight coalescing, caller abort isolation, rollback safety, and per-session isolation.
 */
export function createLazyBuiltinFactory(
	spec: LazyBuiltinSpec,
	loadImplementation: () => Promise<ExtensionFactory | undefined>,
): ExtensionFactory {
	const managedEvents = new Set([...DEFAULT_MANAGED_EVENTS, ...(spec.managedEvents ?? [])]);
	const interceptedBusEvents = new Set(spec.interceptedBusEvents ?? []);
	const invalidatedMessage = `${spec.label} initialization was invalidated by session shutdown`;

	return async (pi: ExtensionAPI): Promise<void> => {
		let nextLeaseId = 1;
		let activeLease: LazyLease = createLifecycleLease<ShutdownSnapshot>(nextLeaseId++);
		let lifecycleGeneration = 0;
		let replayedGeneration = 0;
		let loaded: LoadedEntry | null = null;
		let inFlight: InFlightAttempt | null = null;
		let activeReplay: ActiveReplay | null = null;
		let sessionSnapshot: SessionSnapshot | null = null;
		const activeLifecycle: ActiveLifecycleState = {
			turnStart: null,
			agentStart: null,
			pendingMessages: [],
			activeTools: new Map(),
			modelSelect: null,
		};
		const lifecycleForward = new SerializedLifecycleForwarder();
		const dormantShutdownCleanups: Array<() => void> = [];
		const sessionStartHooks: Array<
			(event: SessionStartEvent, ctx: ExtensionContext, controller: LazyBuiltinController) => void | Promise<void>
		> = [];
		const sessionTreeHooks: Array<
			(event: unknown, ctx: ExtensionContext, controller: LazyBuiltinController) => void | Promise<void>
		> = [];
		const agentStartHooks: Array<
			(event: unknown, ctx: ExtensionContext, controller: LazyBuiltinController) => void | Promise<void>
		> = [];
		const activatedHooks: Array<
			(handle: LazyBuiltinHandle, ctx: ExtensionContext | undefined) => void | Promise<void>
		> = [];
		const staticSurface: StaticSurfaceSets = {
			tools: new Set(),
			commands: new Set(),
			shortcuts: new Set(),
			flags: new Set(),
			messageRenderers: new Set(),
			entryRenderers: new Set(),
		};

		const assertLease = (lease: LazyLease): void => {
			assertCurrentLifecycleLease(activeLease, lease, invalidatedMessage);
		};

		const createHandle = (captured: CapturedLazyBuiltin, lease: LazyLease): LazyBuiltinHandle => ({
			captured,
			assertCurrent: () => assertLease(lease),
		});

		const waitForPriorCleanup = async (lease: LazyLease): Promise<void> => {
			await lease.priorCleanup;
			assertLease(lease);
		};

		const isSnapshotCurrent = (snapshot: SessionSnapshot, lease: LazyLease): boolean => {
			assertLease(lease);
			return sessionSnapshot === snapshot;
		};

		const resetActiveLifecycle = (): void => {
			activeLifecycle.turnStart = null;
			activeLifecycle.agentStart = null;
			activeLifecycle.pendingMessages.length = 0;
			activeLifecycle.activeTools.clear();
			activeLifecycle.modelSelect = null;
		};

		const replayCurrentSession = async (
			captured: CapturedLazyBuiltin,
			lease: LazyLease,
			onReplay?: (ctx: ExtensionContext) => void,
			publishOnComplete?: LazyBuiltinHandle,
			runPostReplayHooks?: () => Promise<void>,
		): Promise<void> => {
			for (;;) {
				assertLease(lease);
				const snapshot = sessionSnapshot;
				if (!snapshot || snapshot.lease !== lease || replayedGeneration === snapshot.generation) {
					if (runPostReplayHooks) {
						await runPostReplayHooks();
						assertLease(lease);
					}
					if (publishOnComplete) loaded = { lease, handle: publishOnComplete };
					return;
				}
				const active = {
					turnStart: activeLifecycle.turnStart,
					modelSelect: activeLifecycle.modelSelect,
					agentStart: activeLifecycle.agentStart,
					pendingMessages: activeLifecycle.pendingMessages.splice(0),
					activeTools: [...activeLifecycle.activeTools.values()],
				};
				onReplay?.(snapshot.ctx);
				await dispatchCapturedHandlers(captured, snapshot.eventName, snapshot.event, snapshot.ctx);
				if (!isSnapshotCurrent(snapshot, lease)) continue;
				if (active.turnStart) {
					await dispatchCapturedHandlers(captured, "turn_start", active.turnStart.event, active.turnStart.ctx);
				}
				if (!isSnapshotCurrent(snapshot, lease)) continue;
				if (active.modelSelect) {
					await dispatchCapturedHandlers(
						captured,
						"model_select",
						active.modelSelect.event,
						active.modelSelect.ctx,
					);
				}
				if (!isSnapshotCurrent(snapshot, lease)) continue;
				if (active.agentStart) {
					await dispatchCapturedHandlers(captured, "agent_start", active.agentStart.event, active.agentStart.ctx);
				}
				if (!isSnapshotCurrent(snapshot, lease)) continue;
				for (const pendingMessage of active.pendingMessages) {
					await dispatchCapturedHandlers(captured, "message_start", pendingMessage.event, pendingMessage.ctx);
					if (!isSnapshotCurrent(snapshot, lease)) break;
				}
				if (!isSnapshotCurrent(snapshot, lease)) continue;
				for (const activeTool of active.activeTools) {
					await dispatchCapturedHandlers(captured, "tool_execution_start", activeTool.event, activeTool.ctx);
					if (!isSnapshotCurrent(snapshot, lease)) break;
				}
				if (!isSnapshotCurrent(snapshot, lease)) continue;
				replayedGeneration = snapshot.generation;
				if (runPostReplayHooks) {
					await runPostReplayHooks();
					assertLease(lease);
				}
				if (publishOnComplete) loaded = { lease, handle: publishOnComplete };
				return;
			}
		};

		const ensureCurrentSessionReplayed = async (
			captured: CapturedLazyBuiltin,
			lease: LazyLease,
			onReplay?: (ctx: ExtensionContext) => void,
			publishOnComplete?: LazyBuiltinHandle,
			runPostReplayHooks?: () => Promise<void>,
		): Promise<void> => {
			await waitForPriorCleanup(lease);
			const snapshot = sessionSnapshot;
			if (!snapshot || snapshot.lease !== lease || replayedGeneration === snapshot.generation) {
				if (runPostReplayHooks) {
					await runPostReplayHooks();
					assertLease(lease);
				}
				if (publishOnComplete) loaded = { lease, handle: publishOnComplete };
				return;
			}
			const existing = activeReplay;
			if (existing?.lease === lease && existing.captured === captured) {
				await existing.promise;
				if (publishOnComplete) {
					assertLease(lease);
					loaded = { lease, handle: publishOnComplete };
				}
				return;
			}
			let promise: Promise<void>;
			promise = lifecycleForward
				.enqueue(() => replayCurrentSession(captured, lease, onReplay, publishOnComplete, runPostReplayHooks))
				.finally(() => {
					if (activeReplay?.promise === promise) activeReplay = null;
				});
			activeReplay = { lease, captured, promise };
			await promise;
		};

		const activate = (ctx?: ExtensionContext, options: { background?: boolean } = {}): Promise<LazyBuiltinHandle> => {
			const background = options.background === true;
			const lease = activeLease;
			if (!isLeaseCurrent(activeLease.id, lease.id, lease.retired)) {
				return Promise.reject(new Error(`${spec.label} initialization unavailable: no active session`));
			}

			if (!canStartActivationAttempt(lease.id, inFlight?.lease.id ?? 0, lease.retired) && inFlight) {
				const existing = inFlight;
				if (!background) existing.background = false;
				return (async (): Promise<LazyBuiltinHandle> => {
					await waitForPriorCleanup(lease);
					const handle = await existing.promise;
					assertLease(lease);
					if (!sessionSnapshot && ctx) {
						sessionSnapshot = {
							eventName: "session_start",
							event: { type: "session_start", reason: "startup" } satisfies SessionStartEvent,
							ctx,
							generation: ++lifecycleGeneration,
							lease,
						};
					}
					await ensureCurrentSessionReplayed(handle.captured, lease);
					assertLease(lease);
					return handle;
				})();
			}

			if (loaded?.lease === lease) {
				const currentLoaded = loaded;
				return (async (): Promise<LazyBuiltinHandle> => {
					await waitForPriorCleanup(lease);
					assertLease(lease);
					await ensureCurrentSessionReplayed(currentLoaded.handle.captured, lease);
					assertLease(lease);
					return currentLoaded.handle;
				})();
			}

			let promise: Promise<LazyBuiltinHandle>;
			promise = (async (): Promise<LazyBuiltinHandle> => {
				const captured = createEmptyCaptured();
				let replayCtx: ExtensionContext | null = null;
				let cleaned = false;
				const cleanupCandidate = async (): Promise<void> => {
					if (cleaned) return;
					cleaned = true;
					const shutdown = lease.shutdown;
					const cleanupCtx = shutdown?.ctx ?? replayCtx;
					if (!cleanupCtx) {
						disposeCapturedResources(captured);
						return;
					}
					const shutdownEvent = shutdown?.event ?? { type: "session_shutdown", reason: "quit" };
					try {
						await dispatchCapturedShutdownOnce(captured, shutdownEvent, cleanupCtx);
					} catch {
						// Rejected lazy candidate cleanup must not mask the original error or lease retirement.
					}
				};
				try {
					await waitForPriorCleanup(lease);
					const factory = await loadImplementation();
					if (typeof factory !== "function") {
						throw new Error(`Lazy builtin "${spec.label}" did not export a valid factory function`);
					}
					assertLease(lease);
					const proxy = createCaptureProxy(
						pi,
						captured,
						staticSurface,
						managedEvents,
						interceptedBusEvents,
						spec.interceptsMcpContributions === true,
						() => assertLease(lease),
					);
					await factory(proxy);
					assertLease(lease);
					if (!sessionSnapshot && ctx) {
						sessionSnapshot = {
							eventName: "session_start",
							event: { type: "session_start", reason: "startup" } satisfies SessionStartEvent,
							ctx,
							generation: ++lifecycleGeneration,
							lease,
						};
					}
					const handle = createHandle(captured, lease);
					const runActivatedHooks =
						activatedHooks.length > 0
							? async () => {
									for (const hook of activatedHooks) {
										await hook(handle, ctx ?? replayCtx ?? undefined);
										assertLease(lease);
									}
								}
							: undefined;
					await ensureCurrentSessionReplayed(
						captured,
						lease,
						(replayContext) => {
							replayCtx = replayContext;
						},
						handle,
						runActivatedHooks,
					);
					assertLease(lease);
					return handle;
				} catch (error) {
					if (loaded?.lease === lease && loaded.handle.captured === captured) loaded = null;
					await cleanupCandidate();
					throw error;
				}
			})();
			inFlight = { lease, promise, background };
			void promise.then(
				() => {
					if (inFlight?.promise === promise) inFlight = null;
				},
				(error: unknown) => {
					if (inFlight?.promise === promise) inFlight = null;
					spec.onActivationError?.(error, ctx);
				},
			);
			return promise;
		};

		const forwardLiveEvent = async (eventName: string, event: unknown, ctx: ExtensionContext): Promise<void> => {
			const lease = activeLease;
			if (lease.retired) return;
			const targetLoaded = loaded?.lease === lease ? loaded.handle.captured : null;
			const targetReplay = activeReplay?.lease === lease ? activeReplay.captured : null;
			const target = targetLoaded ?? targetReplay;
			if (!target) return;
			const expectedGeneration = sessionSnapshot?.generation;
			await lifecycleForward.enqueue(async () => {
				if (activeLease !== lease || lease.retired) return;
				if (loaded?.lease !== lease || loaded.handle.captured !== target) return;
				if (expectedGeneration !== undefined && sessionSnapshot?.generation !== expectedGeneration) return;
				await dispatchCapturedHandlers(target, eventName, event, ctx);
			});
		};

		const controller: LazyBuiltinController = {
			get active() {
				return loaded && loaded.lease === activeLease && !activeLease.retired ? loaded.handle : null;
			},
			isCurrentLease() {
				return !activeLease.retired;
			},
			activate,
			async executeTool(name, args) {
				const invocationLease = activeLease;
				const signal = args[2];
				const ctx = args[4];
				signal?.throwIfAborted();
				const handle = await waitWithAbortSignal(
					(async () => {
						assertLease(invocationLease);
						return activate(ctx);
					})(),
					signal,
				);
				signal?.throwIfAborted();
				handle.assertCurrent();
				const tool = handle.captured.tools.get(name);
				if (!tool?.execute) throw new Error(`${spec.label} tool implementation not found: ${name}`);
				let result: ToolExecuteResult;
				try {
					result = await tool.execute(...args);
				} catch (error) {
					signal?.throwIfAborted();
					throw error;
				}
				signal?.throwIfAborted();
				handle.assertCurrent();
				return result;
			},
			async runCommand(name, args, ctx) {
				const invocationLease = activeLease;
				assertLease(invocationLease);
				const handle = await activate(ctx);
				handle.assertCurrent();
				const command = handle.captured.commands.get(name);
				if (!command) throw new Error(`${spec.label} command implementation not found: ${name}`);
				await command.handler(args, ctx);
				handle.assertCurrent();
			},
			async runShortcut(shortcut, ctx) {
				const invocationLease = activeLease;
				assertLease(invocationLease);
				const handle = await activate(ctx);
				handle.assertCurrent();
				const registered = handle.captured.shortcuts.get(shortcut);
				if (!registered?.handler) throw new Error(`${spec.label} shortcut implementation not found: ${shortcut}`);
				await registered.handler(ctx);
				handle.assertCurrent();
			},
			async dispatchHandlers(eventName, event, ctx) {
				const active = controller.active;
				if (!active) return undefined;
				return dispatchCapturedHandlers(active.captured, eventName, event, ctx);
			},
			async dispatchBusEvent(channel, payload) {
				const active = controller.active;
				if (!active) return;
				await dispatchCapturedBusEvent(active.captured, channel, payload);
			},
			latestContext() {
				return (
					sessionSnapshot?.ctx ??
					activeLifecycle.turnStart?.ctx ??
					activeLifecycle.agentStart?.ctx ??
					[...activeLifecycle.activeTools.values()].at(-1)?.ctx ??
					activeLifecycle.modelSelect?.ctx
				);
			},
			onDormantShutdown(cleanup) {
				dormantShutdownCleanups.push(cleanup);
			},
			onSessionStart(hook) {
				sessionStartHooks.push(hook);
			},
			onSessionTree(hook) {
				sessionTreeHooks.push(hook);
			},
			onAgentStart(hook) {
				agentStartHooks.push(hook);
			},
			onActivated(hook) {
				activatedHooks.push(hook);
			},
			markStaticSurface(kind, name) {
				if (kind === "tool") staticSurface.tools.add(name);
				else if (kind === "command") staticSurface.commands.add(name);
				else if (kind === "shortcut") staticSurface.shortcuts.add(name);
				else if (kind === "flag") staticSurface.flags.add(name);
				else if (kind === "messageRenderer") staticSurface.messageRenderers.add(name);
				else if (kind === "entryRenderer") staticSurface.entryRenderers.add(name);
			},
		};

		// Register managed lifecycle handlers first so startupRegistrationTokens stay deterministic.
		pi.on("session_start", async (event, ctx) => {
			if (activeLease.retired) {
				activeLease = createLifecycleLease<ShutdownSnapshot>(nextLeaseId++, activeLease.cleanupBarrier);
			}
			const lease = activeLease;
			await waitForPriorCleanup(lease);
			if (sessionSnapshot) resetActiveLifecycle();
			const generation = ++lifecycleGeneration;
			sessionSnapshot = { eventName: "session_start", event, ctx, generation, lease };
			if (loaded?.lease === lease) {
				await ensureCurrentSessionReplayed(loaded.handle.captured, lease);
			}
			for (const hook of sessionStartHooks) {
				await hook(event, ctx, controller);
			}
		});

		pi.on("session_tree", async (event, ctx) => {
			const lease = activeLease;
			if (lease.retired) return;
			await lease.priorCleanup;
			if (activeLease !== lease || lease.retired) return;
			const generation = ++lifecycleGeneration;
			sessionSnapshot = { eventName: "session_tree", event, ctx, generation, lease };
			if (loaded?.lease === lease) {
				await ensureCurrentSessionReplayed(loaded.handle.captured, lease);
			}
			for (const hook of sessionTreeHooks) {
				await hook(event, ctx, controller);
			}
		});

		pi.on("session_shutdown", async (event, ctx) => {
			for (const cleanup of dormantShutdownCleanups) {
				try {
					cleanup();
				} catch {
					// Keep releasing remaining dormant resources.
				}
			}
			const lease = activeLease;
			const generation = ++lifecycleGeneration;
			retireLifecycleLease(lease, { event, ctx, generation });
			const retiredLoaded = loaded?.lease === lease ? loaded.handle.captured : null;
			const retiredAttempt =
				inFlight && shouldBlockShutdownOnAttempt(lease.id, inFlight.lease.id, inFlight.background)
					? inFlight.promise
					: null;
			const retiredReplay = activeReplay?.lease === lease ? activeReplay.promise : null;
			sessionSnapshot = null;
			inFlight = null;
			loaded = null;
			activeReplay = null;
			replayedGeneration = generation;
			resetActiveLifecycle();
			const publishedCleanup = retiredLoaded
				? lifecycleForward.enqueue(() => dispatchCapturedShutdownOnce(retiredLoaded, event, ctx))
				: Promise.resolve();
			const retainedCleanup = retainSettledLifecycleCleanup(lease, [
				publishedCleanup,
				retiredAttempt,
				retiredReplay,
				lifecycleForward.settled,
			]);
			try {
				await publishedCleanup;
			} finally {
				await retainedCleanup;
			}
		});

		pi.on("turn_start", async (event, ctx) => {
			if (activeLease.retired) return;
			activeLifecycle.turnStart = { event, ctx };
			await forwardLiveEvent("turn_start", event, ctx);
		});

		pi.on("turn_end", async (event, ctx) => {
			if (activeLease.retired) return;
			activeLifecycle.turnStart = null;
			activeLifecycle.agentStart = null;
			activeLifecycle.pendingMessages.length = 0;
			activeLifecycle.activeTools.clear();
			await forwardLiveEvent("turn_end", event, ctx);
		});

		pi.on("agent_start", async (event, ctx) => {
			if (activeLease.retired) return;
			activeLifecycle.agentStart = { event, ctx };
			activeLifecycle.activeTools.clear();
			for (const hook of agentStartHooks) {
				await hook(event, ctx, controller);
			}
			await forwardLiveEvent("agent_start", event, ctx);
		});

		pi.on("agent_end", async (event, ctx) => {
			if (activeLease.retired) return;
			activeLifecycle.agentStart = null;
			activeLifecycle.pendingMessages.length = 0;
			activeLifecycle.activeTools.clear();
			await forwardLiveEvent("agent_end", event, ctx);
		});

		pi.on("message_start", async (event, ctx) => {
			if (activeLease.retired) return;
			const lease = activeLease;
			if (loaded?.lease === lease || activeReplay?.lease === lease) {
				await forwardLiveEvent("message_start", event, ctx);
				return;
			}
			if (inFlight?.lease === lease) {
				activeLifecycle.pendingMessages.push({ event, ctx });
			}
		});

		pi.on("tool_execution_start", async (event, ctx) => {
			if (activeLease.retired) return;
			activeLifecycle.activeTools.set(event.toolCallId, { event, ctx });
			await forwardLiveEvent("tool_execution_start", event, ctx);
		});

		pi.on("tool_execution_end", async (event, ctx) => {
			if (activeLease.retired) return;
			activeLifecycle.activeTools.delete(event.toolCallId);
			await forwardLiveEvent("tool_execution_end", event, ctx);
		});

		pi.on("model_select", async (event, ctx) => {
			if (activeLease.retired) return;
			activeLifecycle.modelSelect = { event, ctx };
			await forwardLiveEvent("model_select", event, ctx);
		});

		pi.registerToolRenderer?.((toolName, next) => {
			const resolvers = controller.active?.captured.toolRenderers;
			if (!resolvers || resolvers.length === 0) return next();
			const resolve = (index: number): ReturnType<ToolRendererResolver> =>
				index < resolvers.length ? resolvers[index]!(toolName, () => resolve(index + 1)) : next();
			return resolve(0);
		});

		const recordingApi = createStaticRecordingApi(pi, staticSurface);
		await spec.register(recordingApi, controller);
	};
}

const lazyBuiltinRegistry = new Map<BuiltinPackageDirName, LazyBuiltinSpec>();

/** Register a static lazy-activation spec for an identity-verified Atomic builtin package. */
export function registerLazyBuiltin(label: BuiltinPackageDirName, spec: LazyBuiltinSpec): void {
	lazyBuiltinRegistry.set(label, spec);
}

/** Look up the registered lazy-activation spec for an Atomic builtin package, if any. */
export function getLazyBuiltinSpec(label: BuiltinPackageDirName): LazyBuiltinSpec | undefined {
	return lazyBuiltinRegistry.get(label);
}

/** Whether `label` currently has a lazy-activation spec registered. */
export function hasLazyBuiltinSpec(label: BuiltinPackageDirName): boolean {
	return lazyBuiltinRegistry.has(label);
}

/** Remove a test-registered lazy builtin spec. */
export function unregisterLazyBuiltinForTest(label: BuiltinPackageDirName): void {
	lazyBuiltinRegistry.delete(label);
}
