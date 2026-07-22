
import type { ChildProcess } from "node:child_process";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { BoundedWriter } from "./bounded-writer.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { ActivityWatchdogDiagnostic } from "../interactive-engine/activity-watchdog.ts";
import { InteractiveEngineMonitor } from "../interactive-engine/engine-monitor.ts";
import { INTERACTIVE_ENGINE_MAX_FRAME_BYTES, serializeInteractiveEngineFrame, type EngineKeybindingState, type InteractiveEngineCommand, type InteractiveEngineMessage } from "../interactive-engine/protocol.ts";
import { sleep } from "../../utils/sleep.ts";
import { createInteractiveJsonlOptions, spawnRpcClientProcess, terminateRpcClientProcess } from "./rpc-client-process.ts";
import { RpcClientApi, type RpcCommandBody } from "./rpc-client-api.ts";
import { RpcEventBuffer } from "./rpc-event-buffer.ts";
import { collectRpcEvents, waitForRpcIdle } from "./rpc-client-waits.ts";
import type { RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcEvent, RpcResponse } from "./rpc-types.ts";
export type { ModelInfo, RpcCommandBody } from "./rpc-client-api.ts";
export type { RpcContextWindowInfo, RpcEvent } from "./rpc-types.ts";


function restartArgs(args: readonly string[] | undefined, sessionFile: string | undefined): string[] {
	const result: string[] = [];
	for (let index = 0; index < (args?.length ?? 0); index += 1) {
		const value = args![index]!;
		if (value === "--no-session") continue;
		if (value === "--session") { index += 1; continue; }
		result.push(value);
	}
	result.push(sessionFile ? "--session" : "--no-session");
	if (sessionFile) result.push(sessionFile);
	return result;
}
export interface RpcClientOptions {
	cliPath?: string;
	cwd?: string;
	env?: Record<string, string>;
	provider?: string;
	model?: string;
	contextWindow?: number | string;
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
	};
}

/**
 * Commands whose response is legitimately gated on human/agent interaction or a
 * turn boundary and therefore must not be subject to the generic request
 * timeout: interactive prompts and custom-UI pickers (routed through `prompt`),
 * queued turn-boundary sends (`steer`/`follow_up`), long-running shell and
 * compaction work, and session-tree navigation/mutation that can open pickers.
 *
 * Failure detection is unaffected: engine exit, transport violations, aborts,
 * generation replacement, and explicit stop all reject pending requests via
 * rejectPendingRequests/failTransport independently of any timer.
 */
const LONG_LIVED_COMMANDS: ReadonlySet<string> = new Set<string>([
	"prompt",
	"login_provider",
	"steer",
	"follow_up",
	"bash",
	"user_bash",
	"compact",
	"fork",
	"clone",
	"switch_session",
	"new_session",
	"import_session",
	"navigate_tree",
	"invoke_shortcut",
]);

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;


export type RpcEventListener = (event: RpcEvent) => void;


export class RpcClient extends RpcClientApi {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private extensionUIListeners: Array<(request: RpcExtensionUIRequest) => void> = [];
	private pendingExtensionUIRequests: RpcExtensionUIRequest[] = [];
	private engineMessageListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	private latestEngineKeybindingState: EngineKeybindingState | undefined;
	private pendingEngineMessages: InteractiveEngineMessage[] = [];
	private pendingEngineMessageBytes = 0;
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private engineMonitor: InteractiveEngineMonitor | undefined;
	private eventBuffer: RpcEventBuffer | undefined;
	private stdinWriter: BoundedWriter | undefined;
	private generation = 0;
	private readonly activeActivityIds = new Set<string>();
	private enginePid: number | undefined;

	declare private options: RpcClientOptions;

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
		if (this.options.contextWindow !== undefined) {
			args.push("--context-window", String(this.options.contextWindow));
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
			? new InteractiveEngineMonitor(
					this.options.interactiveEngine.onDiagnostic,
					(message) => this.observeInteractiveEngineMessage(message),
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
		});
		this.process = childProcess;
		this.stdinWriter = new BoundedWriter(childProcess.stdin!, {
			maxFrameBytes: INTERACTIVE_ENGINE_MAX_FRAME_BYTES,
			maxQueuedBytes: 2 * INTERACTIVE_ENGINE_MAX_FRAME_BYTES,
		});

		childProcess.once("exit", (code, signal) => {
			if (generation !== this.generation) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.stdinWriter?.close(error);
			this.engineMonitor?.fail(error);
			this.activeActivityIds.clear();
			this.options.interactiveEngine?.onActivityChange?.(false);
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			if (generation !== this.generation) return;
			this.exitError = error;
			this.stdinWriter?.close(error);
			this.engineMonitor?.fail(error);
			this.rejectPendingRequests(error);
		});
		childProcess.stdin?.on("error", (error) => {
			if (generation !== this.generation) return;
			this.exitError = error;
			this.stdinWriter?.close(error);
			this.engineMonitor?.fail(error);
			this.rejectPendingRequests(error);
		});
		childProcess.stderr?.on("data", (data) => {
			if (generation !== this.generation) return;
			const next = this.stderr + data.toString();
			this.stderr = Buffer.byteLength(next, "utf8") <= 256 * 1024
				? next
				: `${Buffer.from(next).subarray(-256 * 1024).toString("utf8")}\n[stderr truncated]`;
			process.stderr.write(data);
		});
		const readerOptions = createInteractiveJsonlOptions(
			this.engineMonitor !== undefined,
			this.options.interactiveEngine?.onDiagnostic,
		);
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			if (generation === this.generation) this.handleLine(line);
		}, {
			...readerOptions,
			onOversizedLine: () => {
				readerOptions.onOversizedLine?.();
				if (generation === this.generation) this.failTransport(new Error("Interactive engine emitted an oversized RPC frame"));
			},
		});
		if (this.engineMonitor) await this.engineMonitor.waitUntilReady();
		else await sleep(100);

		if (generation !== this.generation || this.process?.exitCode !== null) {
			throw new Error(`Agent process exited immediately. Stderr: ${this.stderr}`);
		}
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.invalidateEngineShortcuts();
		const terminateTree = this.engineMonitor !== undefined;
		this.stopReadingStdout?.();
		this.engineMonitor?.stop();
		this.stdinWriter?.close(new Error("Agent process stopped"));
		this.engineMonitor = undefined;
		this.stopReadingStdout = null;
		this.stdinWriter = undefined;
		this.process = null;
		this.generation += 1;
		await terminateRpcClientProcess(child, terminateTree);
		this.rejectPendingRequests(new Error("Agent process stopped"));
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
		for (const request of this.pendingExtensionUIRequests.splice(0)) listener(request);
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
		for (const message of this.pendingEngineMessages.splice(0)) listener(message);
		this.pendingEngineMessageBytes = 0;
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

	sendInteractiveEngineCommand(command: InteractiveEngineCommand): void {
		const writer = this.stdinWriter;
		if (!writer) return;
		const frame = serializeInteractiveEngineFrame(command);
		if (command.type === "engine_custom_render" || command.type === "engine_tool_render" || command.type === "engine_message_render") {
			writer.offerLatest(`render:${command.componentId}`, frame);
			return;
		}
		this.bestEffort(writer.write(frame), `engine command ${command.type}`);
	}
	waitForInteractiveEngineBound(): Promise<void> { return this.engineMonitor?.waitUntilBound() ?? Promise.resolve(); }
	getEnginePid(): number | undefined { return this.enginePid; }
	getGeneration(): number { return this.generation; }

	async restart(sessionFile: string | undefined): Promise<void> {
		await this.stop();
		this.options = { ...this.options, args: restartArgs(this.options.args, sessionFile) };
		await this.start();
		await this.waitForInteractiveEngineBound();
	}

	async requestInternal<T>(command: RpcCommandBody): Promise<T> {
		return this.data<T>(await this.request(command));
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
	private handleLine(line: string): void {
		if (this.engineMonitor?.handleLine(line)) return;
		try {
			const data = JSON.parse(line) as { type?: string; id?: string };
			if (data.type === "extension_ui_request") {
				const request = data as RpcExtensionUIRequest;
				if (this.extensionUIListeners.length === 0) this.pendingExtensionUIRequests.push(request);
				for (const listener of this.extensionUIListeners) listener(request);
				return;
			}
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}
			const event = data as RpcEvent;
			if (this.eventBuffer) this.eventBuffer.enqueue(event);
			else this.emitEvent(event);
		} catch {
			if (this.engineMonitor) this.failTransport(new Error("Interactive engine emitted malformed JSONL"));
		}
	}
	private emitEvent(event: RpcEvent): void {
		for (const listener of this.eventListeners) listener(event);
	}
	private emitInteractiveEngineMessage(message: InteractiveEngineMessage): void {
		if (this.engineMessageListeners.length === 0 && message.type.startsWith("engine_custom_")) {
			const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
			while (this.pendingEngineMessages.length > 0 && this.pendingEngineMessageBytes + bytes > INTERACTIVE_ENGINE_MAX_FRAME_BYTES) {
				const removed = this.pendingEngineMessages.shift()!;
				this.pendingEngineMessageBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
			}
			if (bytes <= INTERACTIVE_ENGINE_MAX_FRAME_BYTES) {
				this.pendingEngineMessages.push(message);
				this.pendingEngineMessageBytes += bytes;
			}
		}
		for (const listener of this.engineMessageListeners) listener(message);
	}
	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}
	private invalidateEngineShortcuts(): void {
		if (!this.latestEngineKeybindingState || this.latestEngineKeybindingState.shortcuts.length === 0) return;
		const state: EngineKeybindingState = { ...this.latestEngineKeybindingState, shortcuts: [] };
		this.latestEngineKeybindingState = state;
		this.emitInteractiveEngineMessage({ type: "engine_keybindings_reloaded", state });
	}
	private observeInteractiveEngineMessage(message: InteractiveEngineMessage): void {
		if (message.type === "engine_ready") this.enginePid = message.pid;
		if (message.type === "engine_keybindings_reloaded") this.latestEngineKeybindingState = message.state;
		if (message.type === "engine_activity_started") this.activeActivityIds.add(message.activity.id);
		else if (message.type === "engine_activity_finished") this.activeActivityIds.delete(message.activityId);
		this.options.interactiveEngine?.onActivityChange?.(this.activeActivityIds.size > 0);
		this.emitInteractiveEngineMessage(message);
	}
	private rejectPendingRequests(error: Error): void {
		for (const { reject } of this.pendingRequests.values()) reject(error);
		this.pendingRequests.clear();
	}
	private failTransport(error: Error): void {
		this.exitError = error;
		this.stdinWriter?.close(error);
		this.engineMonitor?.fail(error);
		this.rejectPendingRequests(error);
		this.options.interactiveEngine?.onDiagnostic({
			activity: undefined, elapsedMs: 0, level: "unresponsive", message: error.message,
		});
	}
	private requireWriter(): BoundedWriter {
		if (!this.stdinWriter) throw new Error("Agent process stdin is not writable");
		return this.stdinWriter;
	}
	private bestEffort(operation: Promise<void>, label: string): void {
		void operation.catch((error: Error) => {
			if (!this.process || this.exitError) return;
			this.options.interactiveEngine?.onDiagnostic({
				activity: undefined, elapsedMs: 0, level: "unresponsive",
				message: `Interactive engine ${label} failed: ${error.message}`,
			});
		});
	}
	protected async request(command: RpcCommandBody): Promise<RpcResponse> {
		const childProcess = this.process;
		if (!childProcess) throw new Error("Client not started");
		if (this.exitError) throw this.exitError;
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let rejectResponse!: (error: Error) => void;
		const response = new Promise<RpcResponse>((resolve, reject) => {
			rejectResponse = reject;
			this.pendingRequests.set(id, {
				resolve: (value) => { if (timeout) clearTimeout(timeout); resolve(value); },
				reject: (error) => { if (timeout) clearTimeout(timeout); reject(error); },
			});
		});
		try {
			await this.requireWriter().write(serializeJsonLine(fullCommand));
		} catch (error) {
			this.pendingRequests.delete(id);
			rejectResponse(error instanceof Error ? error : new Error(String(error)));
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
