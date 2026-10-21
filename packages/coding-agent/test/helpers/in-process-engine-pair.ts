import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { IsolatedInteractiveRuntime } from "../../src/modes/interactive-engine/isolated-runtime.ts";
import type { JsonAgentSessionEvent } from "../../src/modes/json-event.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { RpcClientApi, type RpcCommandBody } from "../../src/modes/rpc/rpc-client-api.ts";
import { createRpcCommandHandler } from "../../src/modes/rpc/rpc-command-handler.ts";
import type { RpcCommand, RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness, type HarnessOptions } from "../suite/harness.ts";

type EventListener = (event: JsonAgentSessionEvent) => void;

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
}

class LaggedPipe<T> {
	private tail: Promise<void> = Promise.resolve();
	constructor(
		private readonly deliver: (item: T) => void,
		private readonly delayMs: () => number,
	) {}

	write(item: T): void {
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
	private handle: (command: RpcCommand) => Promise<RpcResponse | undefined> = async () => undefined;

	constructor(delays: { toEngineMs: () => number; toHostMs: () => number }) {
		super();
		this.toHost = new LaggedPipe((record) => this.receive(record), delays.toHostMs);
		this.toEngine = new LaggedPipe((command) => {
			void this.handle(command).then((response) => {
				if (response) this.toHost.write(JSON.parse(JSON.stringify(response)));
			});
		}, delays.toEngineMs);
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
		if (!response.success) throw new Error(response.error);
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

	async waitForInteractiveEngineResources(): Promise<void> {}

	async waitForInteractiveEngineBound(): Promise<void> {}

	async stop(): Promise<void> {}
}

export interface EngineHostPair {
	engine: Harness;
	hostHarness: Harness;
	runtime: IsolatedInteractiveRuntime;
	setLag: (lag: { toEngineMs?: number; toHostMs?: number }) => void;
	cleanup: () => Promise<void>;
}

export async function createEngineHostPair(
	options: HarnessOptions & {
		engineExtensions?: ExtensionFactory[];
	},
): Promise<EngineHostPair> {
	const lag = { toEngineMs: 0, toHostMs: 0 };
	const engine = await createHarness({ ...options, extensionFactories: options.engineExtensions });
	const hostHarness = await createHarness();
	const client = new InProcessEngineClient({ toEngineMs: () => lag.toEngineMs, toHostMs: () => lag.toHostMs });
	const handle = createRpcCommandHandler({
		runtimeHost: { session: engine.session, services: { agentDir: engine.tempDir } } as AgentSessionRuntime,
		getSession: () => engine.session,
		rebindSession: async () => {},
		output: (record) => client.engineOutput(record as RpcResponse),
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
