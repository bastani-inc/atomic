
import type { ChildProcess } from "node:child_process";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai/compat";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { VerbatimCompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { ActivityWatchdogDiagnostic } from "../interactive-engine/activity-watchdog.ts";
import { InteractiveEngineMonitor } from "../interactive-engine/engine-monitor.ts";
import { serializeInteractiveEngineFrame, type InteractiveEngineCommand, type InteractiveEngineMessage } from "../interactive-engine/protocol.ts";
import { createInteractiveJsonlOptions, spawnRpcClientProcess, terminateRpcClientProcess } from "./rpc-client-process.ts";
import { RpcEventBuffer } from "./rpc-event-buffer.ts";
import { collectRpcEvents, waitForRpcIdle } from "./rpc-client-waits.ts";
import type {
	RpcCommand,
	RpcContextWindowInfo,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcEvent,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";
export type { RpcContextWindowInfo, RpcEvent } from "./rpc-types.ts";


type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

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
	interactiveEngine?: {
		onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => void;
		onActivityChange?: (active: boolean) => void;
	};
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEventListener = (event: RpcEvent) => void;


export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private extensionUIListeners: Array<(request: RpcExtensionUIRequest) => void> = [];
	private pendingExtensionUIRequests: RpcExtensionUIRequest[] = [];
	private engineMessageListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	private pendingEngineMessages: InteractiveEngineMessage[] = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private engineMonitor: InteractiveEngineMonitor | undefined;
	private eventBuffer: RpcEventBuffer | undefined;

	declare private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
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

		this.exitError = null;
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

		childProcess.once("exit", (code, signal) => {
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.engineMonitor?.fail(error);
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			this.exitError = error;
			this.engineMonitor?.fail(error);
			this.rejectPendingRequests(error);
		});
		childProcess.stdin?.on("error", (error) => {
			this.exitError = error;
			this.engineMonitor?.fail(error);
			this.rejectPendingRequests(error);
		});
		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		}, createInteractiveJsonlOptions(
			this.engineMonitor !== undefined,
			this.options.interactiveEngine?.onDiagnostic,
		));
		if (this.engineMonitor) await this.engineMonitor.waitUntilReady();
		else await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			throw new Error(`Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`);
		}
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		const terminateTree = this.engineMonitor !== undefined;
		this.stopReadingStdout?.();
		this.engineMonitor?.stop();
		this.engineMonitor = undefined;
		this.stopReadingStdout = null;
		await terminateRpcClientProcess(child, terminateTree);

		this.process = null;
		this.rejectPendingRequests(new Error("Agent process stopped"));
		this.eventBuffer?.dispose();
		this.eventBuffer = undefined;
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

	respondExtensionUI(response: RpcExtensionUIResponse): void {
		const stdin = this.process?.stdin;
		if (!stdin?.writable) throw new Error("Interactive engine stdin is not writable");
		stdin.write(serializeJsonLine(response));
	}

	onInteractiveEngineMessage(listener: (message: InteractiveEngineMessage) => void): () => void {
		this.engineMessageListeners.push(listener);
		for (const message of this.pendingEngineMessages.splice(0)) listener(message);
		return () => {
			const index = this.engineMessageListeners.indexOf(listener);
			if (index !== -1) this.engineMessageListeners.splice(index, 1);
		};
	}

	sendInteractiveEngineCommand(command: InteractiveEngineCommand): void {
		const stdin = this.process?.stdin;
		if (stdin?.writable) stdin.write(serializeInteractiveEngineFrame(command));
	}
	waitForInteractiveEngineBound(): Promise<void> { return this.engineMonitor?.waitUntilBound() ?? Promise.resolve(); }

	async requestInternal<T>(command: RpcCommandBody): Promise<T> {
		return this.getData<T>(await this.send(command));
	}
	getStderr(): string {
		return this.stderr;
	}


	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
		await this.send({ type: "prompt", message, images, streamingBehavior });
	}

	/** Queue a steering message to interrupt the agent mid-run. */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/** Queue a follow-up message to be processed after the agent finishes. */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/** Abort current operation. */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/** Get current session state. */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/** Set model by provider and ID. */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}
	/** Cycle to next model. */
	async cycleModel(direction?: "forward" | "backward"): Promise<{
		model: Model<Api>;
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model", direction });
		return this.getData(response);
	}

	/** Get list of available models. */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/** Set thinking level. */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/** Cycle thinking level. */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Set the active context-window token budget for the current model.
	 * This is a runtime selection and does not persist context-window defaults.
	 */
	async setContextWindow(contextWindow: number | string): Promise<void> {
		const response = await this.send({ type: "set_context_window", contextWindow });
		this.assertSuccess(response);
	}

	/** Get selectable context-window token budgets for the current model. */
	async getAvailableContextWindows(): Promise<RpcContextWindowInfo> {
		const response = await this.send({ type: "get_available_context_windows" });
		return this.getData(response);
	}

	/** Set steering mode. */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/** Set follow-up mode. */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/** Compact session context with verbatim line-range compaction. */
	async compact(): Promise<VerbatimCompactionResult> {
		const response = await this.send({ type: "compact" });
		return this.getData(response);
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/** Session entries in append order, optionally only those after the `since` entry id. */
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since });
		return this.getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	/** The session entry tree. */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
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
			const data = JSON.parse(line);
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
		}
	}
	private emitEvent(event: RpcEvent): void {
		for (const listener of this.eventListeners) listener(event);
	}
	private emitInteractiveEngineMessage(message: InteractiveEngineMessage): void {
		if (this.engineMessageListeners.length === 0 && message.type.startsWith("engine_custom_")) {
			if (this.pendingEngineMessages.length === 256) this.pendingEngineMessages.shift();
			this.pendingEngineMessages.push(message);
		}
		for (const listener of this.engineMessageListeners) listener(message);
	}
	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}
	private observeInteractiveEngineMessage(message: InteractiveEngineMessage): void {
		if (message.type === "engine_activity_started") this.options.interactiveEngine?.onActivityChange?.(true);
		else if (message.type === "engine_activity_finished") this.options.interactiveEngine?.onActivityChange?.(false);
		this.emitInteractiveEngineMessage(message);
	}
	private rejectPendingRequests(error: Error): void {
		for (const { reject } of this.pendingRequests.values()) {
			reject(error);
		}
		this.pendingRequests.clear();
	}
	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (stdin.destroyed || !stdin.writable) {
			throw new Error("Agent process stdin is not writable");
		}
		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, 30000);
			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			try {
				stdin.write(serializeJsonLine(fullCommand));
			} catch (error) {
				this.pendingRequests.delete(id);
				clearTimeout(timeout);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
	private assertSuccess(response: RpcResponse): void {
		if (!response.success) {
			throw new Error(response.error);
		}
	}
	private getData<T>(response: RpcResponse): T {
		this.assertSuccess(response);
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
