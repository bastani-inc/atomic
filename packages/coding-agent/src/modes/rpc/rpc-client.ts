import type { ChildProcess } from "node:child_process";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { BashResult } from "../../core/bash-executor.ts";
import type { BashOutputChannel } from "../../core/tools/bash.ts";
import { sleep } from "../../utils/sleep.ts";
import type { ActivityWatchdogDiagnostic } from "../interactive-engine/activity-watchdog.ts";
import type {
	InteractiveEngineGenerationEnded,
	InteractiveEngineGenerationEndedListener,
	InteractiveEngineGenerationEndKind,
} from "../interactive-engine/engine-generation.ts";
import { InteractiveEngineMonitor } from "../interactive-engine/engine-monitor.ts";
import {
	type EngineKeybindingState,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../interactive-engine/protocol.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { QueuedWriter } from "./queued-writer.ts";
import { RpcClientApi, type RpcCommandBody } from "./rpc-client-api.ts";
import {
	appendBoundedStderr,
	createInteractiveJsonlOptions,
	restartCliArgs,
	spawnRpcClientProcess,
	terminateRpcClientProcess,
} from "./rpc-client-process.ts";
import { collectRpcEvents, runUserBashWithUpdates, waitForRpcIdle } from "./rpc-client-waits.ts";
import { DEFAULT_REQUEST_TIMEOUT_MS, LONG_LIVED_COMMANDS, RESTART_CANCELLED_MESSAGE } from "./rpc-command-timeouts.ts";
import { RpcEventBuffer } from "./rpc-event-buffer.ts";
import { GenerationBuffer } from "./rpc-generation-buffer.ts";
import { RpcPendingRequests } from "./rpc-pending-requests.ts";
import { RpcTerminalDrain } from "./rpc-terminal-drain.ts";
import { markRpcTransportFailure, rpcTransportError } from "./rpc-transport-error.ts";
import type { RpcCommand, RpcEvent, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "./rpc-types.ts";

export type { ModelInfo, RpcCommandBody } from "./rpc-client-api.ts";
export type { RpcEvent } from "./rpc-types.ts";

export interface RpcClientOptions {
	cliPath?: string;
	cwd?: string;
	env?: Record<string, string>;
	provider?: string;
	model?: string;
	args?: string[];
	runtimeExecutable?: string;
	runtimeArgs?: string[];
	/**
	 * Bounded deadline (ms) applied to short metadata/control requests. Long-lived
	 * commands (see LONG_LIVED_COMMANDS) never use this timer. Defaults to 30s.
	 */
	requestTimeoutMs?: number;
	interactiveEngine?: {
		onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => void;
		onActivityChange?: (active: boolean) => void;
		/**
		 * Heartbeat observer. Deliberately NOT a generic engine-message listener:
		 * subscribing there drains the buffered startup custom-UI messages into the
		 * first subscriber and stops buffering for the real controllers.
		 */
		onHeartbeat?: () => void;
		/**
		 * Credential for the engine child. Delivered through the protected
		 * bootstrap file, never through the child's environment or argv.
		 */
		apiKey?: string;
	};
}

export type RpcEventListener = (event: RpcEvent) => void;

export class RpcClient extends RpcClientApi {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private extensionUIListeners: Array<(request: RpcExtensionUIRequest) => void> = [];
	private readonly pendingExtensionUIRequests = new GenerationBuffer<RpcExtensionUIRequest>();
	private engineMessageListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	private latestEngineKeybindingState: EngineKeybindingState | undefined;
	private readonly pendingEngineMessages = new GenerationBuffer<InteractiveEngineMessage>();
	private readonly pendingRequests = new RpcPendingRequests();
	/** Bumped by every explicit stop; a restart holds a permit across its own stop. */
	private restartRevision = 0;
	private readonly terminalDrain = new RpcTerminalDrain();
	private stdoutDrained: Promise<void> = Promise.resolve();
	private requestId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private engineMonitor: InteractiveEngineMonitor | undefined;
	private eventBuffer: RpcEventBuffer | undefined;
	private stdinWriter: QueuedWriter | undefined;
	private generation = 0;
	private lastEndedGeneration = 0;
	private generationEndedListeners: InteractiveEngineGenerationEndedListener[] = [];
	/**
	 * The latest generation-end event, retained so a subscriber that attaches
	 * after the child died still observes it. A child can exit between
	 * `start()` returning and the runtime constructing its listeners.
	 */
	private retainedGenerationEnd: InteractiveEngineGenerationEnded | undefined;
	private readonly activeActivityIds = new Set<string>();
	private enginePid: number | undefined;

	private declare options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		super();
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const generation = ++this.generation;
		this.exitError = null;
		this.stderr = "";
		this.activeActivityIds.clear();
		this.enginePid = undefined;
		this.engineMonitor = this.options.interactiveEngine
			? new InteractiveEngineMonitor(this.options.interactiveEngine.onDiagnostic, (message) =>
					this.observeInteractiveEngineMessage(message, generation),
				)
			: undefined;
		this.eventBuffer = this.engineMonitor ? new RpcEventBuffer((event) => this.emitEvent(event)) : undefined;
		const childProcess = spawnRpcClientProcess({
			cliPath,
			cliArgs: args,
			cwd: this.options.cwd,
			env: this.options.env,
			runtimeExecutable: this.options.runtimeExecutable,
			runtimeArgs: this.options.runtimeArgs,
			interactiveEngine: this.engineMonitor !== undefined,
			...(this.options.interactiveEngine?.apiKey
				? { interactiveEngineApiKey: this.options.interactiveEngine.apiKey }
				: {}),
		});
		this.process = childProcess;
		this.stdinWriter = new QueuedWriter(childProcess.stdin!);

		childProcess.once("exit", (code, signal) =>
			this.failGeneration(this.createProcessExitError(code, signal), generation, "exit"),
		);
		childProcess.once("error", (rawError) => this.failGeneration(rawError, generation, "process-error"));
		childProcess.stdin?.on("error", (rawError) => this.failGeneration(rawError, generation, "stdin-error"));
		childProcess.stderr?.on("data", (data) => {
			if (generation !== this.generation) return;
			this.stderr = appendBoundedStderr(this.stderr, data.toString());
			process.stderr.write(data);
		});
		const readerOptions = createInteractiveJsonlOptions(this.engineMonitor !== undefined);
		let markStdoutDrained!: () => void;
		this.stdoutDrained = new Promise<void>((resolve) => {
			markStdoutDrained = resolve;
		});
		this.stopReadingStdout = attachJsonlLineReader(
			childProcess.stdout!,
			(line) => {
				if (generation === this.generation) this.handleLine(line, generation);
			},
			{ ...readerOptions, onDrained: () => markStdoutDrained() },
		);
		if (this.engineMonitor) await this.engineMonitor.waitUntilReady();
		else await sleep(100);

		if (generation !== this.generation || this.process?.exitCode !== null) {
			throw rpcTransportError(`Agent process exited immediately. Stderr: ${this.stderr}`);
		}
	}

	/**
	 * Explicit stop. Voids any in-flight restart permit, so a replacement caught
	 * between its own stop and start can never spawn after this returns.
	 */
	async stop(): Promise<void> {
		this.restartRevision += 1;
		await this.stopCurrentGeneration();
	}

	/**
	 * Tear down the current child without touching the restart permit. The reader
	 * stays attached and the generation stays current until the dead child's
	 * stdout settles, so an ownership frame it already sent still reaches its
	 * request; only then is the generation retired (see RpcTerminalDrain).
	 */
	private async stopCurrentGeneration(): Promise<void> {
		const child = this.process;
		if (!child) return;
		const endedGeneration = this.generation;
		const stopError = rpcTransportError("Agent process stopped");
		this.invalidateEngineShortcuts();
		const terminateTree = this.engineMonitor !== undefined;
		this.engineMonitor?.stop();
		this.stdinWriter?.close(stopError);
		// Unblock an in-flight start()/waitUntilBound() for the generation being
		// replaced. Readiness has no deadline by design, so without this an
		// explicit stop of a hung replacement child could never be observed.
		this.engineMonitor?.fail(stopError);
		this.engineMonitor = undefined;
		this.stdinWriter = undefined;
		this.process = null;
		// Publish before terminating so host controllers tear down this generation's
		// UI while the writer is detached: disposal cannot write into a replacement.
		this.publishGenerationEnded(endedGeneration, stopError, "explicit-stop", true);
		// Claim before terminating so the exit this provokes does not relabel a
		// deliberate stop; an exit that already claimed keeps its own error.
		this.terminalDrain.claim(endedGeneration, stopError);
		await terminateRpcClientProcess(child, terminateTree);
		await this.beginTerminalDrain(endedGeneration, stopError);
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.generation += 1;
		this.pendingRequests.rejectAll(stopError);
		this.eventBuffer?.dispose();
		this.eventBuffer = undefined;
		this.activeActivityIds.clear();
		this.options.interactiveEngine?.onActivityChange?.(false);
	}

	/** Subscribe to agent events. */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	onExtensionUIRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.extensionUIListeners.push(listener);
		for (const request of this.pendingExtensionUIRequests.drain(this.generation)) listener(request);
		return () => {
			const index = this.extensionUIListeners.indexOf(listener);
			if (index !== -1) this.extensionUIListeners.splice(index, 1);
		};
	}

	async respondExtensionUI(response: RpcExtensionUIResponse): Promise<void> {
		await this.requireWriter().write(serializeJsonLine(response));
	}

	onInteractiveEngineMessage(listener: (message: InteractiveEngineMessage) => void): () => void {
		this.engineMessageListeners.push(listener);
		for (const message of this.pendingEngineMessages.drain(this.generation)) listener(message);
		return () => {
			const index = this.engineMessageListeners.indexOf(listener);
			if (index !== -1) this.engineMessageListeners.splice(index, 1);
		};
	}

	onInteractiveEngineKeybindingState(listener: (state: EngineKeybindingState) => void): () => void {
		const messageListener = (message: InteractiveEngineMessage): void => {
			if (message.type === "engine_keybindings_reloaded") listener(message.state);
		};
		this.engineMessageListeners.push(messageListener);
		if (this.latestEngineKeybindingState) listener(this.latestEngineKeybindingState);
		return () => {
			const index = this.engineMessageListeners.indexOf(messageListener);
			if (index !== -1) this.engineMessageListeners.splice(index, 1);
		};
	}

	/**
	 * Subscribe to host-local generation death. Fires at most once per
	 * generation, synchronously, before any restart work. A death that has
	 * already happened for the current generation replays immediately, so a
	 * listener attached after an exit still sees it.
	 */
	onGenerationEnded(listener: InteractiveEngineGenerationEndedListener): () => void {
		this.generationEndedListeners.push(listener);
		const retained = this.retainedGenerationEnd;
		// Only while it still describes the live generation: once stop()/start()
		// has moved on, that death belongs to a replaced child.
		if (retained && retained.generation === this.generation) listener(retained);
		return () => {
			const index = this.generationEndedListeners.indexOf(listener);
			if (index !== -1) this.generationEndedListeners.splice(index, 1);
		};
	}

	sendInteractiveEngineCommand(command: InteractiveEngineCommand): void {
		const writer = this.stdinWriter;
		if (!writer) return;
		const frame = serializeInteractiveEngineFrame(command);
		if (
			command.type === "engine_custom_render" ||
			command.type === "engine_tool_render" ||
			command.type === "engine_message_render"
		) {
			writer.offerLatest(`render:${command.componentId}`, frame);
			return;
		}
		this.bestEffort(writer.write(frame), `engine command ${command.type}`);
	}
	waitForInteractiveEngineBound(): Promise<void> {
		return this.engineMonitor?.waitUntilBound() ?? Promise.resolve();
	}
	getEnginePid(): number | undefined {
		return this.enginePid;
	}
	getGeneration(): number {
		return this.generation;
	}

	/**
	 * Replace the engine child, unless an explicit stop supersedes this attempt.
	 * The permit is checked immediately before spawning, so a `stop()` in that
	 * window is always observed; cancellation throws rather than returning
	 * quietly, because callers go on to initialize against the new child.
	 */
	async restart(sessionFile: string | undefined): Promise<void> {
		const permit = this.restartRevision;
		await this.stopCurrentGeneration();
		if (permit !== this.restartRevision) throw rpcTransportError(RESTART_CANCELLED_MESSAGE);
		this.options = { ...this.options, args: restartCliArgs(this.options.args, sessionFile) };
		await this.start();
		await this.waitForInteractiveEngineBound();
	}

	async requestInternal<T>(command: RpcCommandBody): Promise<T> {
		return this.data<T>(await this.request(command));
	}
	userBashWithUpdates(
		command: string,
		onUpdate: (delta: string, channel: BashOutputChannel) => void,
		options?: { excludeFromContext?: boolean; onRequestId?: (id: string) => void },
	): Promise<BashResult> {
		return runUserBashWithUpdates(this, command, onUpdate, options, (body, onId) => this.request(body, onId));
	}
	getStderr(): string {
		return this.stderr;
	}

	waitForIdle(timeout = 60000): Promise<void> {
		return waitForRpcIdle(this, timeout);
	}
	collectEvents(timeout = 60000): Promise<RpcEvent[]> {
		return collectRpcEvents(this, timeout);
	}
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<RpcEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}
	private handleLine(line: string, generation: number): void {
		if (this.terminalDrain.observe(generation, line, (id) => this.pendingRequests.markAccepted(id))) return;
		if (this.engineMonitor?.handleLine(line)) return;
		try {
			const data = JSON.parse(line) as { type?: string; id?: string };
			if (data.type === "extension_ui_request") {
				const request = data as RpcExtensionUIRequest;
				if (this.extensionUIListeners.length === 0) this.pendingExtensionUIRequests.push(generation, request);
				for (const listener of this.extensionUIListeners) listener(request);
				return;
			}
			if (data.type === "response" && data.id && this.pendingRequests.resolve(data.id, data as RpcResponse)) return;
			const event = data as RpcEvent;
			if (this.eventBuffer) this.eventBuffer.enqueue(event);
			else this.emitEvent(event);
		} catch {
			if (this.engineMonitor) this.failTransport(rpcTransportError("Interactive engine emitted malformed JSONL"));
		}
	}
	private emitEvent(event: RpcEvent): void {
		for (const listener of this.eventListeners) listener(event);
	}
	private emitInteractiveEngineMessage(message: InteractiveEngineMessage, generation: number): void {
		if (this.engineMessageListeners.length === 0 && message.type.startsWith("engine_custom_")) {
			this.pendingEngineMessages.push(generation, message);
		}
		for (const listener of this.engineMessageListeners) listener(message);
	}
	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return rpcTransportError(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}
	private invalidateEngineShortcuts(): void {
		if (!this.latestEngineKeybindingState || this.latestEngineKeybindingState.shortcuts.length === 0) return;
		const state: EngineKeybindingState = { ...this.latestEngineKeybindingState, shortcuts: [] };
		this.latestEngineKeybindingState = state;
		this.emitInteractiveEngineMessage({ type: "engine_keybindings_reloaded", state }, this.generation);
	}
	private observeInteractiveEngineMessage(message: InteractiveEngineMessage, generation: number): void {
		// Ownership is the one thing a dead generation may still report: request
		// ids never repeat, and the alternative is classifying work it already
		// started as never sent. Nothing else from it may touch host state — a
		// stale frame would revive a PID, an activity, or a mount that is gone.
		if (message.type === "engine_request_accepted") {
			if (generation === this.generation) this.pendingRequests.markAccepted(message.requestId);
			return;
		}
		if (generation !== this.generation || generation <= this.lastEndedGeneration) return;
		if (message.type === "engine_heartbeat") this.options.interactiveEngine?.onHeartbeat?.();
		if (message.type === "engine_ready") this.enginePid = message.pid;
		if (message.type === "engine_keybindings_reloaded") this.latestEngineKeybindingState = message.state;
		if (message.type === "engine_activity_started") this.activeActivityIds.add(message.activity.id);
		else if (message.type === "engine_activity_finished") this.activeActivityIds.delete(message.activityId);
		this.options.interactiveEngine?.onActivityChange?.(this.activeActivityIds.size > 0);
		this.emitInteractiveEngineMessage(message, generation);
	}
	/**
	 * Shared teardown for every unexpected end of `generation`. Death publishes
	 * at once for the host UI; its requests wait for stdout (RpcTerminalDrain).
	 */
	private failGeneration(rawError: Error, generation: number, kind: InteractiveEngineGenerationEndKind): void {
		if (generation !== this.generation) return;
		const error = markRpcTransportFailure(rawError);
		this.exitError = error;
		this.stdinWriter?.close(error);
		this.engineMonitor?.fail(error);
		if (kind === "exit") {
			this.activeActivityIds.clear();
			this.options.interactiveEngine?.onActivityChange?.(false);
		}
		this.beginTerminalDrain(generation, error);
		this.publishGenerationEnded(generation, error, kind, false);
	}
	/** Hold this generation's requests until its stdout drains (RpcTerminalDrain). */
	private beginTerminalDrain(generation: number, error: Error): Promise<void> {
		return this.terminalDrain.begin(generation, this.stdoutDrained, error, (settled) => {
			if (generation === this.generation) this.pendingRequests.rejectAll(settled);
		});
	}
	private publishGenerationEnded(
		generation: number,
		error: Error,
		kind: InteractiveEngineGenerationEndKind,
		expected: boolean,
	): void {
		if (generation <= this.lastEndedGeneration) return;
		this.lastEndedGeneration = generation;
		const event: InteractiveEngineGenerationEnded = { generation, error, kind, expected };
		this.retainedGenerationEnd = event;
		// Death is a strict boundary: drop this generation's buffered frames
		// BEFORE teardown runs, so no listener can drain a stale mount frame
		// while it is closing that very generation's components.
		this.pendingEngineMessages.dropGeneration(generation);
		this.pendingExtensionUIRequests.dropGeneration(generation);
		for (const listener of [...this.generationEndedListeners]) listener(event);
	}
	private failTransport(rawError: Error): void {
		this.options.interactiveEngine?.onDiagnostic({
			activity: undefined,
			elapsedMs: 0,
			level: "unresponsive",
			message: rawError.message,
		});
		this.failGeneration(rawError, this.generation, "transport-error");
	}
	private requireWriter(): QueuedWriter {
		if (!this.stdinWriter) throw rpcTransportError("Agent process stdin is not writable");
		return this.stdinWriter;
	}
	private bestEffort(operation: Promise<void>, label: string): void {
		void operation.catch((error: Error) => {
			if (!this.process || this.exitError) return;
			this.options.interactiveEngine?.onDiagnostic({
				activity: undefined,
				elapsedMs: 0,
				level: "unresponsive",
				message: `Interactive engine ${label} failed: ${error.message}`,
			});
		});
	}
	protected async request(command: RpcCommandBody, onRequestId?: (id: string) => void): Promise<RpcResponse> {
		const childProcess = this.process;
		if (!childProcess) throw rpcTransportError("Client not started");
		if (this.exitError) throw this.exitError;
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		const id = `req_${++this.requestId}`;
		onRequestId?.(id);
		const fullCommand = { ...command, id } as RpcCommand;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let rejectResponse!: (error: Error) => void;
		const response = new Promise<RpcResponse>((resolve, reject) => {
			rejectResponse = reject;
			this.pendingRequests.add(id, {
				resolve: (value) => {
					if (timeout) clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					if (timeout) clearTimeout(timeout);
					reject(error);
				},
			});
		});
		try {
			await this.requireWriter().write(serializeJsonLine(fullCommand));
		} catch (error) {
			this.pendingRequests.delete(id);
			// Idempotent: the writer already classified this, but a caller-supplied
			// stream can reject with anything, and a send that never left the host
			// is a transport failure whatever it threw.
			rejectResponse(markRpcTransportFailure(error));
			return response;
		}
		if (this.pendingRequests.has(id) && !LONG_LIVED_COMMANDS.has(command.type)) {
			timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				rejectResponse(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
		}
		return response;
	}
	private assertSuccess(response: RpcResponse): void {
		if (!response.success) throw new Error(response.error);
	}
	protected data<T>(response: RpcResponse): T {
		this.assertSuccess(response);
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
