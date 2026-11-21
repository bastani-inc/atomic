import type { ChildProcess } from "node:child_process";
import type { ImageContent } from "@bastani/atomic-ai/compat";
import type { BashResult } from "../../core/bash-executor.ts";
import { receiveChatReceipt } from "../../core/chat-receipts.js";
import type { SessionTrustDecisions } from "../../core/project-trust-state.ts";
import { type QueuedDeliveryChange, takeQueuedDeliveryChange } from "../../core/queued-message-delivery.ts";
import type { BashOutputChannel } from "../../core/tools/bash.js";
import { removeOwnedInteractiveEngineBootstrapAsync } from "../../utils/interactive-engine-bootstrap.ts";
import { sleep } from "../../utils/sleep.ts";
import type { ActivityWatchdogDiagnostic } from "../interactive-engine/activity-watchdog.ts";
import type {
	InteractiveEngineGenerationEnded,
	InteractiveEngineGenerationEndedListener,
	InteractiveEngineGenerationEndKind,
} from "../interactive-engine/engine-generation.ts";
import { InteractiveEngineMonitor } from "../interactive-engine/engine-monitor.ts";
import { HostListenerFailures, type HostListenerInput } from "../interactive-engine/host-listener-failures.ts";
import {
	type EngineKeybindingState,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../interactive-engine/protocol.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { QueuedWriter } from "./queued-writer.ts";
import { RpcClientApi, type RpcCommandBody } from "./rpc-client-api.ts";
import {
	appendBoundedStderr,
	createInteractiveJsonlOptions,
	createStderrReporter,
	prepareRpcClientBootstrap,
	restartCliArgs,
	spawnRpcClientProcess,
	terminateRpcClientProcess,
} from "./rpc-client-process.js";
import { collectRpcEvents, runUserBashWithUpdates, waitForRpcIdle } from "./rpc-client-waits.ts";
import { DEFAULT_REQUEST_TIMEOUT_MS, LONG_LIVED_COMMANDS, RESTART_CANCELLED_MESSAGE } from "./rpc-command-timeouts.ts";
import { assertRpcSuccess } from "./rpc-error-decoding.ts";
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
		/**
		 * Trust decisions the engine starts with, delivered through the bootstrap file. A restart replaces them with the
		 * decisions it is given.
		 */
		trustDecisions?: SessionTrustDecisions;
	};
}

export type RpcEventListener = (event: RpcEvent) => void;

/** Longest an explicit quit waits for the child to acknowledge it before stopping an unresponsive engine anyway. */
const EXPLICIT_QUIT_ACK_TIMEOUT_MS = 1000;

export class RpcClient extends RpcClientApi {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private readonly queuedDeliveryListeners = new Set<(change: QueuedDeliveryChange, event: RpcEvent) => void>();
	private extensionUIListeners: Array<(request: RpcExtensionUIRequest) => void> = [];
	private readonly pendingExtensionUIRequests = new GenerationBuffer<RpcExtensionUIRequest>();
	private engineMessageListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	private latestEngineKeybindingState: EngineKeybindingState | undefined;
	private readonly pendingEngineMessages = new GenerationBuffer<InteractiveEngineMessage>();
	private readonly pendingProjectTrustFrames = new GenerationBuffer<string>();
	private boundGeneration = 0;
	private explicitQuitAck: { generation: number; acknowledge: () => void } | undefined;
	private readonly pendingRequests = new RpcPendingRequests();
	/** Bumped by every explicit stop; a restart holds a permit across its own stop. */
	private restartRevision = 0;
	private stopPromise: Promise<void> | undefined;
	private readonly terminalDrain = new RpcTerminalDrain();
	private stdoutDrained: Promise<void> = Promise.resolve();
	private requestId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private engineMonitor: InteractiveEngineMonitor | undefined;
	private startingMonitor: Promise<InteractiveEngineMonitor | undefined> | undefined;
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
	/**
	 * The engine generation an explicit stop retired, whose child may still write while it shuts down, and
	 * whether that child said its shutdown is complete.
	 */
	private stoppedEngine: { generation: number; shutdownComplete: PromiseWithResolvers<void> } | undefined;
	/** The ready engine child an explicit stop is ending, until that stop has finished. */
	private stoppingEngine: ChildProcess | undefined;
	/** Contains and reports what the listeners of an interactive engine's host throw; a raw client has none. */
	private readonly listenerFailures: HostListenerFailures | undefined;

	private declare options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		super();
		this.options = options;
		this.listenerFailures = options.interactiveEngine
			? new HostListenerFailures((diagnostic) => this.options.interactiveEngine?.onDiagnostic(diagnostic))
			: undefined;
	}

	async start(restartPermit?: number): Promise<void> {
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

		const startRevision = restartPermit ?? this.restartRevision;
		const monitorReady = Promise.withResolvers<InteractiveEngineMonitor | undefined>();
		this.startingMonitor = monitorReady.promise;
		const settleStartingMonitor = (monitor: InteractiveEngineMonitor | undefined): void => {
			monitorReady.resolve(monitor);
			if (this.startingMonitor === monitorReady.promise) this.startingMonitor = undefined;
		};
		let preparedBootstrap: Awaited<ReturnType<typeof prepareRpcClientBootstrap>> | undefined;
		try {
			preparedBootstrap = this.options.interactiveEngine
				? await prepareRpcClientBootstrap(
						this.options.interactiveEngine.apiKey,
						this.options.interactiveEngine.trustDecisions,
					)
				: undefined;
			if (this.stopPromise) {
				await this.stopPromise.catch(() => {});
			}
			if (this.restartRevision !== startRevision) {
				await removeOwnedInteractiveEngineBootstrapAsync(preparedBootstrap?.bootstrap);
				throw rpcTransportError(restartPermit !== undefined ? RESTART_CANCELLED_MESSAGE : "Agent process stopped");
			}
			if (this.process) {
				await removeOwnedInteractiveEngineBootstrapAsync(preparedBootstrap?.bootstrap);
				throw new Error("Client already started");
			}
		} catch (error) {
			settleStartingMonitor(undefined);
			throw error;
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
		settleStartingMonitor(this.engineMonitor);
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
			...(preparedBootstrap ? { preparedBootstrap } : {}),
		});
		this.process = childProcess;
		this.stdinWriter = new QueuedWriter(childProcess.stdin!);

		childProcess.once("exit", (code, signal) =>
			this.failGeneration(this.createProcessExitError(code, signal), generation, "exit"),
		);
		childProcess.once("error", (rawError) => this.failGeneration(rawError, generation, "process-error"));
		childProcess.stdin?.on("error", (rawError) => this.failGeneration(rawError, generation, "stdin-error"));
		const reportStderr = createStderrReporter((message) => {
			if (generation !== this.generation) return;
			if (this.options.interactiveEngine) {
				this.options.interactiveEngine.onDiagnostic({
					activity: undefined,
					elapsedMs: 0,
					level: "blocking",
					source: "stderr",
					message,
				});
			} else console.log(message);
		});
		// Decode continuously per child, including split code points and the final incomplete sequence at EOF.
		childProcess.stderr?.setEncoding("utf8");
		childProcess.stderr?.on("data", (data: string) => {
			if (generation !== this.generation) return;
			this.stderr = appendBoundedStderr(this.stderr, data);
			reportStderr(data);
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
	 * Tell the engine child the host is quitting on purpose, and wait (bounded) for it to
	 * record that. Call it before `stop()` for a quit the user asked for: stopping closes
	 * stdin and sends SIGTERM, which is also how the child is stopped when the host itself
	 * was signalled, so only this announcement lets the child tell the two apart.
	 * Resolves true only when the child acknowledged the quit, and false without waiting when
	 * there is no live engine child, or when the child exits or misses the deadline first.
	 */
	async announceExplicitQuit(timeoutMs = EXPLICIT_QUIT_ACK_TIMEOUT_MS): Promise<boolean> {
		const writer = this.stdinWriter;
		if (!writer || !this.engineMonitor || this.generation <= this.lastEndedGeneration) return false;
		const generation = this.generation;
		const done = Promise.withResolvers<boolean>();
		this.explicitQuitAck = { generation, acknowledge: () => done.resolve(true) };
		const stopListening = this.onGenerationEnded((event) => {
			if (event.generation === generation) done.resolve(false);
		});
		const timer = setTimeout(() => done.resolve(false), timeoutMs);
		try {
			this.bestEffort(
				writer.write(serializeInteractiveEngineFrame({ type: "engine_explicit_quit" })),
				"explicit quit",
			);
			return await done.promise;
		} finally {
			clearTimeout(timer);
			stopListening();
			if (this.explicitQuitAck?.generation === generation) this.explicitQuitAck = undefined;
		}
	}

	/**
	 * Explicit stop. Voids any in-flight restart permit, so a replacement caught
	 * between its own stop and start can never spawn after this returns.
	 *
	 * With `graceful`, an interactive engine child that has reported ready runs its own
	 * shutdown, including extensions' `session_shutdown` handlers, for up to five seconds
	 * on every platform. Without it a Windows engine is ended at once, because Windows
	 * has no signal a process can handle for this.
	 *
	 * With `hostSignaled`, the engine is stopped because its host was itself signalled, lost its terminal or, on
	 * Windows, had its console closed. A ready engine then runs its own shutdown too. On Linux and macOS it is asked
	 * with SIGHUP rather than SIGTERM, and once its shutdown has run it ends its whole process group, as a host signal
	 * ending that group at once always did.
	 */
	stop(options?: { graceful?: boolean; hostSignaled?: boolean }): Promise<void> {
		this.restartRevision += 1;
		if (this.stopPromise) return this.stopPromise;
		if (!this.process) return Promise.resolve();
		const stopPromise = this.stopCurrentGeneration(
			options?.graceful === true,
			options?.hostSignaled === true,
		).finally(() => {
			if (this.stopPromise === stopPromise) this.stopPromise = undefined;
		});
		this.stopPromise = stopPromise;
		return stopPromise;
	}

	/**
	 * Tear down the current child without touching the restart permit. The reader
	 * stays attached and the generation stays current until the dead child's
	 * stdout settles, so an ownership frame it already sent still reaches its
	 * request; only then is the generation retired (see RpcTerminalDrain).
	 */
	private async stopCurrentGeneration(graceful = false, hostSignaled = false): Promise<void> {
		const child = this.process;
		if (!child) return;
		const endedGeneration = this.generation;
		// The engine reports ready once it handles the end of its input; until then a stop ends it at once.
		const engineReady = this.enginePid !== undefined;
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
		// Until the stop is over, the engine it is ending is still this client's ready engine.
		if (terminateTree && engineReady) this.stoppingEngine = child;
		// When this stop ends an engine generation, updates read before it reach the host before the host hears
		// the generation ended, and what the engine writes while it shuts down does not reach the host at all
		// (handleStoppedEngineLine). A generation that already ended on its own keeps its terminal drain.
		const shutdownComplete = Promise.withResolvers<void>();
		if (terminateTree && endedGeneration > this.lastEndedGeneration) {
			for (const event of this.eventBuffer?.drain() ?? []) this.emitEvent(event);
			this.stoppedEngine = { generation: endedGeneration, shutdownComplete };
		}
		// Publish before terminating so host controllers tear down this generation's
		// UI while the writer is detached: disposal cannot write into a replacement.
		this.publishGenerationEnded(endedGeneration, stopError, "explicit-stop", true);
		// Claim before terminating so the exit this provokes does not relabel a
		// deliberate stop; an exit that already claimed keeps its own error.
		this.terminalDrain.claim(endedGeneration, stopError);
		try {
			await terminateRpcClientProcess(
				child,
				terminateTree,
				(graceful || hostSignaled) && engineReady,
				shutdownComplete.promise,
				hostSignaled,
			);
		} finally {
			if (this.stoppingEngine === child) this.stoppingEngine = undefined;
		}
		await this.beginTerminalDrain(endedGeneration, stopError);
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.generation += 1;
		this.pendingRequests.rejectAll(stopError);
		this.eventBuffer?.dispose();
		this.eventBuffer = undefined;
		this.activeActivityIds.clear();
		this.notifyActivity(false);
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

	/**
	 * Subscribe to what an interactive engine says about the queued messages its session is delivering. Each change
	 * arrives with the event whose line carried it, before that event's listeners run.
	 */
	onQueuedDeliveryChange(listener: (change: QueuedDeliveryChange, event: RpcEvent) => void): () => void {
		this.queuedDeliveryListeners.add(listener);
		return () => this.queuedDeliveryListeners.delete(listener);
	}

	onExtensionUIRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.extensionUIListeners.push(listener);
		for (const request of this.pendingExtensionUIRequests.drain(this.generation))
			this.notify(listener, request, "extension UI request");
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
		for (const message of this.pendingEngineMessages.drain(this.generation))
			this.notify(listener, message, "message");
		return () => {
			const index = this.engineMessageListeners.indexOf(listener);
			if (index !== -1) this.engineMessageListeners.splice(index, 1);
		};
	}

	onInteractiveEngineKeybindingState(listener: (state: EngineKeybindingState) => void): () => void {
		const messageListener = (message: InteractiveEngineMessage): void =>
			message.type === "engine_keybindings_reloaded" ? listener(message.state) : undefined;
		this.engineMessageListeners.push(messageListener);
		const state = this.latestEngineKeybindingState;
		if (state) this.notify(messageListener, { type: "engine_keybindings_reloaded", state }, "message");
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
		if (retained && retained.generation === this.generation) this.notify(listener, retained, "end");
		return () => {
			const index = this.generationEndedListeners.indexOf(listener);
			if (index !== -1) this.generationEndedListeners.splice(index, 1);
		};
	}

	sendInteractiveEngineCommand(command: InteractiveEngineCommand): void {
		const writer = this.stdinWriter;
		if (command.type === "engine_project_trust_start" || command.type === "engine_project_trust_end") {
			if (this.generation <= this.lastEndedGeneration) return;
			// The terminal can open and close /trust while the engine is still binding.
			// Retain both frames, without delaying the host-owned decision.
			if (this.engineMonitor && this.boundGeneration !== this.generation) {
				this.pendingProjectTrustFrames.push(this.generation, serializeInteractiveEngineFrame(command));
				return;
			}
		}
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
		// Disposal goes through the ordered queue, ahead of coalesced renders: a render still waiting for a row
		// being disposed would reach the engine after its disposal and bring its renderer back.
		if (command.type === "engine_render_dispose" || command.type === "engine_custom_dispose")
			writer.discardLatest(`render:${command.componentId}`);
		this.bestEffort(writer.write(frame), `engine command ${command.type}`);
	}
	waitForInteractiveEngineBound(): Promise<void> {
		return this.whenEngineMonitor((monitor) => monitor.waitUntilBound());
	}
	waitForInteractiveEngineProjectTrust(): Promise<void> {
		return this.whenEngineMonitor((monitor) => monitor.waitUntilProjectTrustSettled());
	}
	waitForInteractiveEngineResources(): Promise<void> {
		return this.whenEngineMonitor((monitor) => monitor.waitUntilResourcesReady());
	}
	private whenEngineMonitor(wait: (monitor: InteractiveEngineMonitor) => Promise<void>): Promise<void> {
		const starting = this.startingMonitor;
		if (starting !== undefined)
			return starting.then((monitor) => (monitor === undefined ? undefined : wait(monitor)));
		return this.engineMonitor === undefined ? Promise.resolve() : wait(this.engineMonitor);
	}
	getEnginePid(): number | undefined {
		return this.enginePid;
	}
	/**
	 * The process ID of the engine child this client runs once it has reported ready, or of a ready one a stop is still
	 * ending, while it has not exited: the stop ends it within its bounded window.
	 */
	getReadyEngineChildPid(): number | undefined {
		const child = this.enginePid === undefined ? undefined : (this.process ?? this.stoppingEngine);
		return child && child.exitCode === null && child.signalCode === null ? child.pid : undefined;
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
	async restart(
		sessionId: string | undefined,
		options?: {
			sessionDirectory?: string;
			cwd?: string;
			/** Trust decisions of the host session, which the new engine starts with instead of asking again. */
			trustDecisions?: SessionTrustDecisions;
		},
	): Promise<void> {
		const permit = this.restartRevision;
		await this.stopCurrentGeneration();
		// Join an in-flight stop before the permit check: waiting after it would
		// reopen the window this fence exists to close.
		if (this.stopPromise) await this.stopPromise;
		if (permit !== this.restartRevision) throw rpcTransportError(RESTART_CANCELLED_MESSAGE);
		const interactiveEngine = this.options.interactiveEngine;
		this.options = {
			...this.options,
			cwd: options?.cwd ?? this.options.cwd,
			args: restartCliArgs(this.options.args, sessionId, options?.sessionDirectory),
			...(interactiveEngine && options?.trustDecisions
				? { interactiveEngine: { ...interactiveEngine, trustDecisions: options.trustDecisions } }
				: {}),
		};
		await this.start(permit);
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
		const accepted = this.prompt(message, images);
		// A prompt has no request deadline, so `timeout` must also end the wait while
		// the prompt is still unacknowledged. Whichever settles first decides; both are
		// observed so the loser's later rejection is never an unhandled rejection.
		eventsPromise.catch(() => {});
		accepted.catch(() => {});
		await Promise.race([accepted, eventsPromise]);
		return eventsPromise;
	}
	private handleLine(line: string, generation: number): void {
		// Ahead of the terminal drain, which a transport error during the stop can begin: it would swallow the
		// engine's report that its shutdown is complete.
		if (this.stoppedEngine?.generation === generation) {
			this.handleStoppedEngineLine(line, this.stoppedEngine.shutdownComplete);
			return;
		}
		if (
			this.terminalDrain.observe(
				generation,
				line,
				(id) => this.pendingRequests.markAccepted(id),
				() => this.emitInteractiveEngineMessage({ type: "engine_console_closed" }, generation),
			)
		)
			return;
		if (this.engineMonitor?.handleLine(line)) return;
		// Until the line has been read, an exception means the engine wrote something that is not a message. Once it has
		// been read, only a raw client's listener can still throw here: an interactive engine's host contains what its
		// listeners throw, and a raw client drops the rest of that line's delivery, as it always has.
		let read = false;
		try {
			const data = JSON.parse(line) as { type?: string; id?: string };
			if (data.type === "extension_ui_request") {
				read = true;
				const request = data as RpcExtensionUIRequest;
				if (this.extensionUIListeners.length === 0) this.pendingExtensionUIRequests.push(generation, request);
				for (const listener of this.extensionUIListeners) this.notify(listener, request, "extension UI request");
				return;
			}
			if (data.type === "response" && data.id && this.pendingRequests.resolve(data.id, data as RpcResponse)) return;
			if (this.engineMonitor && "atomicChatReceipt" in data) receiveChatReceipt(data);
			const queuedDeliveries = this.engineMonitor ? takeQueuedDeliveryChange(data) : undefined;
			read = true;
			const event = data as RpcEvent;
			if (queuedDeliveries !== undefined) {
				// Older tool updates the buffer still holds reach their listeners first, with the queue they were sent with.
				this.eventBuffer?.flush();
				for (const listener of [...this.queuedDeliveryListeners])
					this.notify((change: QueuedDeliveryChange) => listener(change, event), queuedDeliveries, "event", event);
			}
			if (this.eventBuffer) this.eventBuffer.enqueue(event);
			else this.emitEvent(event);
		} catch {
			if (!read && this.engineMonitor)
				this.failTransport(rpcTransportError("Interactive engine emitted malformed JSONL"));
		}
	}
	/**
	 * A line an engine writes while an explicit stop ends it. The host has already torn down that generation's UI,
	 * so its extension UI requests, engine frames and events are dropped. What settles its own requests still
	 * counts, as in its terminal drain, a failed shutdown is still reported, and the stop learns when the engine
	 * says its shutdown is complete.
	 */
	private handleStoppedEngineLine(line: string, shutdownComplete: PromiseWithResolvers<void>): void {
		const message = parseInteractiveEngineMessage(line);
		if (message) {
			if (message.type === "engine_request_accepted") this.pendingRequests.markAccepted(message.requestId);
			else if (message.type === "engine_shutdown_complete") shutdownComplete.resolve();
			return;
		}
		try {
			const data = JSON.parse(line) as { type?: string; id?: string };
			if (data.type === "response" && data.id) this.pendingRequests.resolve(data.id, data as RpcResponse);
			else if (data.type === "shutdown_error") this.emitEvent(data as RpcEvent);
		} catch {
			// A malformed line is ignored, as for any line once the engine monitor is gone.
		}
	}
	private emitEvent(event: RpcEvent): void {
		// Iterate a snapshot so listeners that unsubscribe during dispatch do not make later listeners miss this event.
		for (const listener of [...this.eventListeners]) this.notify(listener, event, "event");
	}
	/**
	 * Call one of the host's listeners with `value`, about `about` (by default the value itself): see
	 * HostListenerFailures. A raw client calls it as it always has.
	 */
	private notify<T>(listener: (value: T) => void, value: T, input: HostListenerInput, about: unknown = value): void {
		if (this.listenerFailures) this.listenerFailures.call(listener, value, input, about);
		else listener(value);
	}
	/** Tell the host whether the engine is running one of its callbacks, while handling `message` or the engine's end. */
	private notifyActivity(active: boolean, message?: InteractiveEngineMessage): void {
		const engine = this.options.interactiveEngine;
		if (engine?.onActivityChange)
			this.notify(
				(value: boolean) => engine.onActivityChange?.(value),
				active,
				message ? "message" : "end",
				message,
			);
	}
	private emitInteractiveEngineMessage(message: InteractiveEngineMessage, generation: number): void {
		if (
			this.engineMessageListeners.length === 0 &&
			(message.type.startsWith("engine_custom_") || message.type.startsWith("engine_resources_"))
		) {
			this.pendingEngineMessages.push(generation, message);
		}
		for (const listener of this.engineMessageListeners) this.notify(listener, message, "message");
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
		if (message.type === "engine_explicit_quit_ack") {
			if (this.explicitQuitAck?.generation === generation) this.explicitQuitAck.acknowledge();
			return;
		}
		if (generation !== this.generation || generation <= this.lastEndedGeneration) return;
		const engine = this.options.interactiveEngine;
		if (message.type === "engine_heartbeat" && engine?.onHeartbeat)
			this.notify(() => engine.onHeartbeat?.(), message, "message");
		if (message.type === "engine_ready") this.enginePid = message.pid;
		if (message.type === "engine_bound") {
			this.boundGeneration = generation;
			for (const frame of this.pendingProjectTrustFrames.drain(generation)) {
				if (this.stdinWriter) this.bestEffort(this.stdinWriter.write(frame), "project trust notification");
			}
		}
		if (message.type === "engine_keybindings_reloaded") this.latestEngineKeybindingState = message.state;
		if (message.type === "engine_activity_started") this.activeActivityIds.add(message.activity.id);
		else if (message.type === "engine_activity_finished") this.activeActivityIds.delete(message.activityId);
		this.notifyActivity(this.activeActivityIds.size > 0, message);
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
			this.notifyActivity(false);
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
		this.pendingProjectTrustFrames.dropGeneration(generation);
		for (const listener of [...this.generationEndedListeners]) this.notify(listener, event, "end");
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
	protected data<T>(response: RpcResponse): T {
		assertRpcSuccess(response);
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
