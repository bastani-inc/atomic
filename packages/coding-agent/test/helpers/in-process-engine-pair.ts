import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { IsolatedInteractiveRuntime } from "../../src/modes/interactive-engine/isolated-runtime.ts";
import type { JsonAgentSessionEvent } from "../../src/modes/json-event.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { RpcClientApi, type RpcCommandBody } from "../../src/modes/rpc/rpc-client-api.ts";
import { createRpcCommandHandler } from "../../src/modes/rpc/rpc-command-handler.ts";
import { assertRpcSuccess } from "../../src/modes/rpc/rpc-error-decoding.ts";
import { createRpcErrorResponse } from "../../src/modes/rpc/rpc-responses.ts";
import type { RpcCommand, RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness, type HarnessOptions } from "../suite/harness.ts";

type EventListener = (event: JsonAgentSessionEvent) => void;

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
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
	private nextId = 0;
	private readonly toEngine: LaggedPipe<RpcCommand>;
	private readonly toHost: LaggedPipe<RpcResponse | JsonAgentSessionEvent>;
	private readonly failures = new Map<RpcCommand["type"], { message: string; cause?: unknown }>();
	readonly commandsReceived: RpcCommand[] = [];
	private handle: (command: RpcCommand) => Promise<RpcResponse | undefined> = async () => undefined;

	constructor(delays: { toEngineMs: () => number; toHostMs: () => number }) {
		super();
		this.toHost = new LaggedPipe((record) => this.receive(record), delays.toHostMs);
		this.toEngine = new LaggedPipe((command) => {
			this.commandsReceived.push(command);
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
		this.toHost.holdFrom(matches);
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

	private receive(record: RpcResponse | JsonAgentSessionEvent): void {
		if (record.type === "response") {
			const id = record.id;
			const request = id === undefined ? undefined : this.pending.get(id);
			if (id !== undefined && request) {
				this.pending.delete(id);
				request.resolve(record);
			}
			return;
		}
		for (const listener of [...this.listeners]) listener(record);
	}

	protected request(command: RpcCommandBody): Promise<RpcResponse> {
		const id = `req-${++this.nextId}`;
		return new Promise<RpcResponse>((resolve) => {
			this.pending.set(id, { resolve });
			this.toEngine.write({ ...command, id } as RpcCommand);
		});
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

	onGenerationEnded(): () => void {
		return () => {};
	}

	getGeneration(): number {
		return 1;
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
	},
): Promise<EngineHostPair> {
	const lag = { toEngineMs: 0, toHostMs: 0 };
	const engine = await createHarness({ ...options, extensionFactories: options.engineExtensions });
	const hostHarness = await createHarness({ sessionManager: options.hostSessionManager });
	const client = new InProcessEngineClient({ toEngineMs: () => lag.toEngineMs, toHostMs: () => lag.toHostMs });
	const handle = createRpcCommandHandler({
		runtimeHost: {
			session: engine.session,
			services: { agentDir: engine.tempDir },
			takeResumeNotices: () => [],
			...options.engineRuntimeHost,
		} as unknown as AgentSessionRuntime,
		getSession: () => engine.session,
		rebindSession: async () => {},
		output: (record) => client.engineOutput(record as RpcResponse),
		detachCompaction: true,
	});
	client.attachEngine(handle);
	const unsubscribe = engine.session.subscribe((event) => client.engineOutput(toJsonEvent(event)));
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
		commandsReceived: client.commandsReceived,
		holdHostTrafficFrom: (matches) => client.holdHostTrafficFrom(matches),
		releaseHostTraffic: () => client.releaseHostTraffic(),
		setLag: (next) => {
			if (next.toEngineMs !== undefined) lag.toEngineMs = next.toEngineMs;
			if (next.toHostMs !== undefined) lag.toHostMs = next.toHostMs;
		},
		cleanup: async () => {
			unsubscribe();
			await hostHarness.cleanup().catch(() => {});
			await engine.cleanup().catch(() => {});
		},
	};
}
