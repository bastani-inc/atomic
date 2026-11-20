import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import {
	type QueuedDeliveryChange,
	QueuedDeliveryRelay,
	takeQueuedDeliveryChange,
	withQueuedDeliveryChange,
} from "../../src/core/queued-message-delivery.ts";
import type { SessionManager } from "../../src/core/session-manager.js";
import { serializeSessionMutation } from "../../src/core/session-mutation-queue.ts";
import { EngineCustomUiService } from "../../src/modes/interactive-engine/engine-custom-ui.ts";
import type {
	InteractiveEngineGenerationEnded,
	InteractiveEngineGenerationEndedListener,
} from "../../src/modes/interactive-engine/engine-generation.ts";
import { IsolatedInteractiveRuntime } from "../../src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
	serializeInteractiveEngineMessage,
} from "../../src/modes/interactive-engine/protocol.ts";
import type { JsonAgentSessionEvent } from "../../src/modes/json-event.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { RpcClientApi, type RpcCommandBody } from "../../src/modes/rpc/rpc-client-api.ts";
import { createRpcCommandHandler } from "../../src/modes/rpc/rpc-command-handler.ts";
import { assertRpcSuccess } from "../../src/modes/rpc/rpc-error-decoding.ts";
import { createRpcExtensionUIContext, type RpcPendingExtensionRequests } from "../../src/modes/rpc/rpc-extension-ui.ts";
import { createRpcErrorResponse } from "../../src/modes/rpc/rpc-responses.ts";
import { asAcceptedRequestFailure, rpcTransportError } from "../../src/modes/rpc/rpc-transport-error.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness, type HarnessOptions } from "../suite/harness.ts";

type EventListener = (event: JsonAgentSessionEvent) => void;

/** A line the engine's own UI writes to its output, between the responses and events written there. */
class EngineUiLine {
	constructor(readonly line: string) {}
}

type HostRecord = RpcResponse | JsonAgentSessionEvent | EngineUiLine;

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	/** The engine's handler took the request, as `engine_request_accepted` tells a real host. */
	accepted?: boolean;
}

class LaggedPipe<T> {
	private tail: Promise<void> = Promise.resolve();
	private writes = 0;
	private held: T[] | undefined;
	private holdWhen: ((item: T) => boolean) | undefined;
	get writeCount(): number {
		return this.writes;
	}
	constructor(
		private readonly deliver: (item: T) => void,
		private readonly delayMs: () => number,
	) {}

	/** Resolves once every item written so far, and any written while waiting, has been delivered. */
	async idle(): Promise<void> {
		let seen: number;
		do {
			seen = this.writes;
			await this.tail;
		} while (seen !== this.writes);
	}

	/** Keep the first item `matches` accepts, and every item after it, until `release()`. */
	holdFrom(matches: (item: T) => boolean): void {
		this.holdWhen = matches;
	}

	/**
	 * Deliver the held items in one synchronous pass, after everything written before them. A real reader handles
	 * every line of one read the same way, before any promise continuation a line resolves can run.
	 */
	async release(): Promise<void> {
		const items = this.held ?? [];
		this.held = undefined;
		this.holdWhen = undefined;
		await this.tail;
		for (const item of items) this.deliver(item);
	}

	/** Drop the held items and stop holding: a lost process's unread output never arrives. */
	discardHeld(): void {
		this.held = undefined;
		this.holdWhen = undefined;
	}

	write(item: T): void {
		this.writes += 1;
		if (this.held === undefined && this.holdWhen?.(item)) {
			this.holdWhen = undefined;
			this.held = [];
		}
		if (this.held !== undefined) {
			this.held.push(item);
			return;
		}
		const readyAt = Date.now() + this.delayMs();
		this.tail = this.tail.then(async () => {
			const wait = readyAt - Date.now();
			if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
			else await new Promise<void>((resolve) => setImmediate(resolve));
			this.deliver(item);
		});
	}
}

class InProcessEngineClient extends RpcClientApi {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<EventListener>();
	private readonly queuedDeliveryListeners = new Set<
		(change: QueuedDeliveryChange, event: JsonAgentSessionEvent) => void
	>();
	private nextId = 0;
	private readonly toEngine: LaggedPipe<RpcCommand>;
	private readonly toHost: LaggedPipe<HostRecord>;
	private readonly toEngineUi: LaggedPipe<string>;
	private engineUi: ((line: string) => void) | undefined;
	private readonly failures = new Map<RpcCommand["type"], { message: string; cause?: unknown }>();
	private generation = 1;
	/** Set from a crash until the replacement starts: the lost engine's output never reaches the host. */
	private lost = false;
	private readonly generationEndedListeners = new Set<InteractiveEngineGenerationEndedListener>();
	private readonly engineMessageListeners = new Set<(message: InteractiveEngineMessage) => void>();
	private readonly extensionUiListeners = new Set<(request: RpcExtensionUIRequest) => void>();
	private answerExtensionUi: ((response: RpcExtensionUIResponse) => void) | undefined;
	readonly commandsReceived: RpcCommand[] = [];
	private handle: (command: RpcCommand) => Promise<RpcResponse | undefined> = async () => undefined;

	constructor(delays: { toEngineMs: () => number; toHostMs: () => number }) {
		super();
		this.toHost = new LaggedPipe((record) => this.receive(record), delays.toHostMs);
		this.toEngineUi = new LaggedPipe((line) => {
			if (!this.lost) this.engineUi?.(line);
		}, delays.toEngineMs);
		this.toEngine = new LaggedPipe((command) => {
			if (this.lost) return;
			this.commandsReceived.push(command);
			const request = command.id === undefined ? undefined : this.pending.get(command.id);
			if (request) request.accepted = true;
			const failure = this.failures.get(command.type);
			if (failure !== undefined) {
				this.toHost.write(createRpcErrorResponse(command.id, command.type, failure.message, failure.cause));
				return;
			}
			void this.handle(command).then((response) => {
				if (response) this.toHost.write(JSON.parse(JSON.stringify(response)));
			});
		}, delays.toEngineMs);
	}

	/**
	 * Make the engine answer every command of this type with an error, or stop doing so when no message is given. The
	 * response is built as the engine builds it for `cause`, so a typed cause keeps its error code.
	 */
	failCommand(type: RpcCommand["type"], message: string | undefined, cause?: unknown): void {
		if (message === undefined) this.failures.delete(type);
		else this.failures.set(type, { message, cause });
	}

	/** Hold the first record bound for the host that `matches` accepts, and every later one, until released. */
	holdHostTrafficFrom(matches: (record: RpcResponse | JsonAgentSessionEvent) => boolean): void {
		this.toHost.holdFrom((record) => !(record instanceof EngineUiLine) && matches(record));
	}

	/** Let the host read every held record in one pass, as it reads one chunk of the engine's output. */
	releaseHostTraffic(): Promise<void> {
		return this.toHost.release();
	}

	attachEngine(handle: (command: RpcCommand) => Promise<RpcResponse | undefined>): void {
		this.handle = handle;
	}

	engineOutput(record: RpcResponse | JsonAgentSessionEvent): void {
		this.toHost.write(JSON.parse(JSON.stringify(record)));
	}

	/** The engine draws UI: its lines reach the host in order with its responses, and the host's commands reach it. */
	attachEngineUi(handleLine: (line: string) => void): (line: string) => void {
		this.engineUi = handleLine;
		return (line) => this.toHost.write(new EngineUiLine(line));
	}

	/** The engine's extensions ask the host for UI, and the host's answers reach `answer`, as over a real engine's pipes. */
	attachExtensionUi(answer: (response: RpcExtensionUIResponse) => void): void {
		this.answerExtensionUi = answer;
	}

	private receive(record: HostRecord): void {
		if (this.lost) return;
		if (!(record instanceof EngineUiLine) && (record as { type: string }).type === "extension_ui_request") {
			for (const listener of [...this.extensionUiListeners]) listener(record as unknown as RpcExtensionUIRequest);
			return;
		}
		if (record instanceof EngineUiLine) {
			const parsed = parseInteractiveEngineMessage(record.line.trim());
			if (parsed !== undefined) for (const listener of [...this.engineMessageListeners]) listener(parsed);
			return;
		}
		if (record.type === "response") {
			const id = record.id;
			const request = id === undefined ? undefined : this.pending.get(id);
			if (id !== undefined && request) {
				this.pending.delete(id);
				request.resolve(record);
			}
			return;
		}
		// As the host's client reads an engine's event line: what the engine says it is delivering, then the event.
		const change = takeQueuedDeliveryChange(record);
		if (change !== undefined) for (const listener of [...this.queuedDeliveryListeners]) listener(change, record);
		for (const listener of [...this.listeners]) listener(record);
	}

	protected request(command: RpcCommandBody): Promise<RpcResponse> {
		const id = `req-${++this.nextId}`;
		if (this.lost) return Promise.reject(rpcTransportError("Agent process exited"));
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.toEngine.write({ ...command, id } as RpcCommand);
		});
	}

	/**
	 * The engine process dies: what it has not answered fails as a transport failure the engine never took, its later
	 * output is lost, and the host hears the generation end unexpectedly. `restart()` brings up its replacement, which
	 * here is the same session, as a replacement reloads the session the lost engine saved.
	 */
	crash(): void {
		this.lost = true;
		this.toHost.discardHeld();
		const pending = [...this.pending.values()];
		this.pending.clear();
		const error = rpcTransportError("Agent process exited with code 1");
		for (const request of pending) request.reject(request.accepted ? asAcceptedRequestFailure(error) : error);
		const event: InteractiveEngineGenerationEnded = {
			generation: this.generation,
			error,
			kind: "exit",
			expected: false,
		};
		for (const listener of [...this.generationEndedListeners]) listener(event);
	}

	/** The engine's generation ends without a crash, as a deliberate stop or replacement ends it. */
	endGeneration(expected: boolean): void {
		const event: InteractiveEngineGenerationEnded = {
			generation: this.generation,
			error: rpcTransportError("Agent process stopped"),
			kind: "explicit-stop",
			expected,
		};
		for (const listener of [...this.generationEndedListeners]) listener(event);
	}

	async restart(): Promise<void> {
		this.generation += 1;
		this.lost = false;
	}

	/** A message the engine's own UI sends the host, such as a subagent chat's queue. */
	engineMessage(message: InteractiveEngineMessage): void {
		const parsed = parseInteractiveEngineMessage(serializeInteractiveEngineMessage(message).trim());
		if (parsed === undefined || this.lost) return;
		for (const listener of [...this.engineMessageListeners]) listener(parsed);
	}

	protected data<T>(response: RpcResponse): T {
		assertRpcSuccess(response);
		return (response as Extract<RpcResponse, { success: true; data: unknown }>).data as T;
	}

	async requestInternal<T>(command: RpcCommandBody): Promise<T> {
		return this.data<T>(await this.request(command));
	}

	onEvent(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onQueuedDeliveryChange(listener: (change: QueuedDeliveryChange, event: JsonAgentSessionEvent) => void): () => void {
		this.queuedDeliveryListeners.add(listener);
		return () => this.queuedDeliveryListeners.delete(listener);
	}

	onGenerationEnded(listener: InteractiveEngineGenerationEndedListener): () => void {
		this.generationEndedListeners.add(listener);
		return () => this.generationEndedListeners.delete(listener);
	}

	/**
	 * Unless the pair was made with `engineUi`, this engine draws no UI of its own: the host receives only the engine
	 * messages a test sends with `engineMessage`.
	 */
	onInteractiveEngineMessage(listener: (message: InteractiveEngineMessage) => void): () => void {
		this.engineMessageListeners.add(listener);
		return () => this.engineMessageListeners.delete(listener);
	}

	onInteractiveEngineKeybindingState(): () => void {
		return () => {};
	}

	onExtensionUIRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.extensionUiListeners.add(listener);
		return () => this.extensionUiListeners.delete(listener);
	}

	async respondExtensionUI(response: RpcExtensionUIResponse): Promise<void> {
		const answer = this.answerExtensionUi;
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (!this.lost) answer?.(response);
	}

	sendInteractiveEngineCommand(command: InteractiveEngineCommand): void {
		if (this.engineUi) this.toEngineUi.write(serializeInteractiveEngineFrame(command).trim());
	}

	getGeneration(): number {
		return this.generation;
	}

	/** Resolves once nothing is in flight in either direction and every handler has run. */
	async drain(): Promise<void> {
		for (let quiet = 0; quiet < 2; ) {
			const writes = this.toEngine.writeCount + this.toHost.writeCount;
			await Promise.all([this.toEngine.idle(), this.toHost.idle()]);
			await new Promise<void>((resolve) => setImmediate(resolve));
			quiet = writes === this.toEngine.writeCount + this.toHost.writeCount ? quiet + 1 : 0;
		}
	}

	async waitForInteractiveEngineResources(): Promise<void> {}

	async waitForInteractiveEngineBound(): Promise<void> {}

	async stop(): Promise<void> {}
}

export interface EngineHostPair {
	engine: Harness;
	hostHarness: Harness;
	runtime: IsolatedInteractiveRuntime;
	/** Write a record to the host as the engine's stdout would. */
	engineOutput: (record: object) => void;
	setLag: (lag: { toEngineMs?: number; toHostMs?: number }) => void;
	/** Wait until nothing is in flight between host and engine and both sides have handled it. */
	drain: () => Promise<void>;
	/** Make the engine answer every command of this type with an error, or stop doing so when no message is given. */
	failCommand: (type: RpcCommand["type"], message: string | undefined, cause?: unknown) => void;
	/**
	 * The engine process dies mid-work: its queue and the turn it was running go with it, nothing it had not sent reaches
	 * the host, and the host replaces it. The replacement serves the same session.
	 */
	crash: () => void;
	/** A message the engine's own UI sends the host. */
	engineMessage: (message: InteractiveEngineMessage) => void;
	/** The engine's generation ends as a deliberate stop or replacement ends it. */
	endGeneration: (options: { expected: boolean }) => void;
	/** The commands the engine received from the host, in order. */
	commandsReceived: readonly RpcCommand[];
	/**
	 * Hold the first record bound for the host that `matches` accepts, and every later one, so the host lags the engine
	 * from that record on. `releaseHostTraffic()` then hands them over in one pass, as one read of the engine's output.
	 */
	holdHostTrafficFrom: (matches: (record: RpcResponse | JsonAgentSessionEvent) => boolean) => void;
	releaseHostTraffic: () => Promise<void>;
	cleanup: () => Promise<void>;
}

export async function createEngineHostPair(
	options: HarnessOptions & {
		engineExtensions?: ExtensionFactory[];
		/** Runtime methods the engine's command handler can call beyond the stub's session, services and notices. */
		engineRuntimeHost?: Partial<Pick<AgentSessionRuntime, "switchSession" | "importFromJsonl">>;
		/** The host's own view of the session. Default: a private in-memory session, as with `--no-session`. */
		hostSessionManager?: SessionManager;
		hostSettingsManager?: HarnessOptions["settingsManager"];
		serializeEngineCommands?: boolean;
		/** The engine draws its own UI, such as `/tasks`, which the host shows as an interactive engine's. */
		engineUi?: boolean;
		/** The engine's extensions show their UI on the host, as a real engine's do: dialogs, notices, custom views. */
		extensionUi?: boolean;
		/**
		 * Whether the engine tells the host which queued messages it is delivering, as it does for a host that asks.
		 * Default true; false is an engine of an earlier version, or a host that did not ask.
		 */
		queuedDeliveries?: boolean;
	},
): Promise<EngineHostPair> {
	const lag = { toEngineMs: 0, toHostMs: 0 };
	const engine = await createHarness({ ...options, extensionFactories: options.engineExtensions });
	const hostHarness = await createHarness({
		sessionManager: options.hostSessionManager,
		settingsManager: options.hostSettingsManager,
	});
	const client = new InProcessEngineClient({ toEngineMs: () => lag.toEngineMs, toHostMs: () => lag.toHostMs });
	const engineRuntimeHost = new AgentSessionRuntime(
		engine.session,
		{ cwd: engine.tempDir, agentDir: engine.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	if (options.engineRuntimeHost) {
		Object.assign(engineRuntimeHost, options.engineRuntimeHost);
	}
	let customUi: EngineCustomUiService | undefined;
	let keybindings: KeybindingsManager | undefined;
	if (options.engineUi) {
		keybindings = KeybindingsManager.create(engine.tempDir);
		let write: (line: string) => void = () => {};
		const ui = new EngineCustomUiService((line) => write(line), keybindings);
		write = client.attachEngineUi((line) => ui.handleLine(line));
		customUi = ui;
	}
	const handle = createRpcCommandHandler({
		runtimeHost: engineRuntimeHost,
		getSession: () => engine.session,
		rebindSession: async () => {},
		output: (record) => client.engineOutput(record as RpcResponse),
		detachCompaction: true,
		...(customUi === undefined
			? {}
			: {
					keybindings,
					taskInspectorUi: {
						custom: customUi.custom.bind(customUi),
						getHostRenderSettings: () => customUi.getHostRenderSettings(),
					},
				}),
	});
	client.attachEngine(
		options.serializeEngineCommands
			? (command) => serializeSessionMutation(engineRuntimeHost, () => handle(command))
			: handle,
	);
	if (options.extensionUi) {
		const pendingExtensionRequests: RpcPendingExtensionRequests = new Map();
		await engine.session.bindExtensions({
			uiContext: createRpcExtensionUIContext({
				output: (record) => client.engineOutput(record as RpcResponse),
				pendingExtensionRequests,
				customUi,
			}),
			mode: customUi ? "tui" : "rpc",
		});
		client.attachExtensionUi((response) => {
			const pending = pendingExtensionRequests.get(response.id);
			if (pending === undefined) return;
			pendingExtensionRequests.delete(response.id);
			pending.resolve(response);
		});
	}
	// A replacement engine starts telling the host afresh.
	const newRelay = () => (options.queuedDeliveries === false ? undefined : new QueuedDeliveryRelay());
	let relay = newRelay();
	const unsubscribe = engine.session.subscribe((event) =>
		client.engineOutput(
			withQueuedDeliveryChange(toJsonEvent(event), relay?.note(engine.session, event)) as JsonAgentSessionEvent,
		),
	);
	const local = new AgentSessionRuntime(
		hostHarness.session,
		{ cwd: hostHarness.tempDir, agentDir: hostHarness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const runtime = new IsolatedInteractiveRuntime(
		local,
		async () => {
			throw new Error("unused runtime factory");
		},
		client as never,
	);
	return {
		engine,
		hostHarness,
		runtime,
		engineOutput: (record) => client.engineOutput(record as RpcResponse),
		drain: () => client.drain(),
		failCommand: (type, message, cause) => client.failCommand(type, message, cause),
		crash: () => {
			client.crash();
			// What the lost process held in memory is gone: its queue, and the turn it was running.
			engine.session.clearQueue();
			void engine.session.abort();
			// Its replacement tells the host afresh.
			relay = newRelay();
		},
		engineMessage: (message) => client.engineMessage(message),
		endGeneration: ({ expected }) => {
			client.endGeneration(expected);
			relay = newRelay();
		},
		commandsReceived: client.commandsReceived,
		holdHostTrafficFrom: (matches) => client.holdHostTrafficFrom(matches),
		releaseHostTraffic: () => client.releaseHostTraffic(),
		setLag: (next) => {
			if (next.toEngineMs !== undefined) lag.toEngineMs = next.toEngineMs;
			if (next.toHostMs !== undefined) lag.toHostMs = next.toHostMs;
		},
		cleanup: async () => {
			unsubscribe();
			customUi?.dispose();
			// The host runtime listens to process-wide settings until it is disposed; left undisposed, it keeps both
			// harnesses alive for the rest of the file.
			await runtime.dispose().catch(() => {});
			await hostHarness.cleanup().catch(() => {});
			await engine.cleanup().catch(() => {});
		},
	};
}
