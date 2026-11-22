import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@bastani/atomic-agent-core";
import type { Credential } from "@bastani/atomic-ai";
import type { Api, ImageContent, Model } from "@bastani/atomic-ai/compat";
import type {
	ClearedQueue,
	PromptDisposition,
	QueuedInputDisposition,
	SessionRecoveryReport,
	SessionStats,
} from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.ts";
import type { VerbatimCompactionResult } from "../../core/compaction/index.ts";
import type { SessionRecoveryReason } from "../../core/extensions/index.js";
import type { AtomicProviderCompat } from "../../core/model-capabilities.ts";
import type { SaveCredentialOptions } from "../../core/model-runtime.js";
import type { SessionEntry, SessionSummaryEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { OversizedSessionEntry } from "../../core/storage/session/types.js";
import type { ToolStatusReport } from "../../core/tool-status.js";
import type {
	RpcAutocompleteItem,
	RpcCommand,
	RpcContextWindow,
	RpcHistoryChunk,
	RpcHistoryPage,
	RpcLoginProviderResult,
	RpcLogoutProviderResult,
	RpcMirrorPosition,
	RpcModelCatalog,
	RpcModelRefreshResult,
	RpcPersistedModelDefaults,
	RpcResponse,
	RpcResumeNotice,
	RpcSessionInfo,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
	/** Provider/model capability metadata used to gate constrained sampling. */
	compat?: AtomicProviderCompat;
}

export abstract class RpcClientApi {
	protected abstract request(command: RpcCommandBody): Promise<RpcResponse>;
	protected abstract data<T>(response: RpcResponse): T;

	/**
	 * Send a prompt and return its disposition once accepted.
	 * If the disposition is "handled", no run started for this prompt, so don't wait for agent_settled.
	 */
	async prompt(
		message: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
		queuedMessageId?: string,
		originSendId?: string,
	): Promise<PromptDisposition> {
		const response = await this.request({
			type: "prompt",
			message,
			images,
			streamingBehavior,
			...(queuedMessageId === undefined ? {} : { queuedMessageId }),
			...(originSendId === undefined ? {} : { originSendId }),
		});
		return this.data<{ disposition: PromptDisposition }>(response).disposition;
	}
	async steer(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		const response = await this.request({ type: "steer", message, images });
		return this.data<{ disposition: QueuedInputDisposition }>(response).disposition;
	}
	async followUp(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		const response = await this.request({ type: "follow_up", message, images });
		return this.data<{ disposition: QueuedInputDisposition }>(response).disposition;
	}
	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}
	async clearQueue(): Promise<ClearedQueue> {
		return this.data(await this.request({ type: "clear_queue" }));
	}
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		return this.data(await this.request({ type: "new_session", parentSession }));
	}
	async deleteSession(sessionId: string): Promise<void> {
		this.data<void>(await this.request({ type: "delete_session", sessionId }));
	}
	async getState(): Promise<RpcSessionState> {
		return this.data(await this.request({ type: "get_state" }));
	}
	async getSessionSummary(): Promise<SessionSummaryEntry | null> {
		return this.data<{ summary: SessionSummaryEntry | null }>(await this.request({ type: "get_session_summary" }))
			.summary;
	}
	async listSessions(): Promise<RpcSessionInfo[]> {
		return this.data<{ sessions: RpcSessionInfo[] }>(await this.request({ type: "list_sessions" })).sessions;
	}
	async setModel(
		provider: string,
		modelId: string,
		options?: { persist?: boolean; thinkingLevel?: ThinkingLevel },
	): Promise<{ provider: string; id: string; persistedDefaults?: RpcPersistedModelDefaults }> {
		return this.data(
			await this.request({
				type: "set_model",
				provider,
				modelId,
				...(options?.persist === true ? { persist: true } : {}),
				...(options?.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
			}),
		);
	}
	async cycleModel(
		direction?: "forward" | "backward",
		options?: { persist?: boolean },
	): Promise<{
		model: Model<Api>;
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
		persistedDefaults?: RpcPersistedModelDefaults;
	} | null> {
		return this.data(
			await this.request({
				type: "cycle_model",
				direction,
				...(options?.persist === true ? { persist: true } : {}),
			}),
		);
	}
	async getAvailableModels(): Promise<ModelInfo[]> {
		return this.data<{ models: ModelInfo[] }>(await this.request({ type: "get_available_models" })).models;
	}
	async loginProvider(provider: string, signal?: AbortSignal): Promise<RpcLoginProviderResult> {
		const loginId = randomUUID();
		if (signal?.aborted) return { provider, cancelled: true };
		const cancel = () => {
			void this.cancelLoginProvider(provider, loginId).catch(() => {});
		};
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			return this.data(await this.request({ type: "login_provider", provider, loginId }));
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
	}
	async saveProviderCredential(
		provider: string,
		credential: Credential,
		options: SaveCredentialOptions = {},
	): Promise<RpcModelCatalog> {
		return this.data(
			await this.request({
				type: "save_provider_credential",
				provider,
				credential,
				refreshCatalog: options.refreshCatalog,
			}),
		);
	}
	async cancelLoginProvider(provider: string, loginId?: string): Promise<void> {
		await this.request({ type: "cancel_login_provider", provider, loginId });
	}
	async logoutProvider(provider: string): Promise<RpcLogoutProviderResult> {
		return this.data(await this.request({ type: "logout_provider", provider }));
	}

	async refreshModels(
		options: { timeoutMs?: number; force?: boolean; allowNetwork?: boolean } = {},
	): Promise<RpcModelRefreshResult> {
		return this.data(await this.request({ type: "refresh_models", ...options }));
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.request({ type: "set_thinking_level", level });
	}
	/**
	 * Isolated persist path: forwards `persist` and returns the engine's effective
	 * level plus the provider/model the engine persisted against. Public callers
	 * must keep using one-argument {@link setThinkingLevel}.
	 */
	async setThinkingLevelAck(
		level: ThinkingLevel,
		options?: { persist?: boolean },
	): Promise<{ level: ThinkingLevel; provider?: string; modelId?: string }> {
		const response = await this.request({
			type: "set_thinking_level",
			level,
			...(options?.persist === true ? { persist: true } : {}),
		});
		if (!response.success) {
			return this.data(response);
		}
		if (response.command === "set_thinking_level" && "data" in response && response.data) {
			return response.data;
		}
		return { level };
	}
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		return this.data(await this.request({ type: "cycle_thinking_level" }));
	}
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		return this.data<{ levels: ThinkingLevel[] }>(await this.request({ type: "get_available_thinking_levels" }))
			.levels;
	}
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.request({ type: "set_steering_mode", mode });
	}
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.request({ type: "set_follow_up_mode", mode });
	}
	/** Compact the session; `instructions` say what to recover first and focus a compactor model. */
	async compact(instructions?: string): Promise<VerbatimCompactionResult> {
		return this.data(await this.request({ type: "compact", ...(instructions ? { instructions } : {}) }));
	}
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.request({ type: "set_auto_compaction", enabled });
	}
	/**
	 * Say what extension UI this client can show. With `questionnaire`, `ask_user_question` arrives as one
	 * `extension_ui_request` with method `questionnaire` instead of failing for lack of a terminal.
	 */
	async setExtensionUiCapabilities(capabilities: { questionnaire?: boolean }): Promise<void> {
		await this.request({ type: "set_extension_ui_capabilities", ...capabilities });
	}
	/** Set the engine's `debug` setting; later work and child processes it starts follow it. */
	async setDebug(enabled: boolean): Promise<void> {
		this.data<void>(await this.request({ type: "set_debug", enabled }));
	}
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.request({ type: "set_auto_retry", enabled });
	}
	async abortRetry(): Promise<void> {
		await this.request({ type: "abort_retry" });
	}
	async bash(command: string): Promise<BashResult> {
		return this.data(await this.request({ type: "bash", command }));
	}
	async abortBash(requestId?: string): Promise<void> {
		await this.request({ type: "abort_bash", requestId });
	}
	/** Recover work an earlier process left unfinished; call once the transcript is shown. */
	async startPendingRecovery(reason?: SessionRecoveryReason): Promise<SessionRecoveryReport> {
		return this.data(await this.request({ type: "start_pending_recovery", reason }));
	}
	/** Restore background subagents after an isolated-engine crash without replaying deliveries or prompting. */
	async startPendingRecoveryRestore(reason?: SessionRecoveryReason): Promise<SessionRecoveryReport> {
		return this.data(await this.request({ type: "start_pending_recovery_restore", reason }));
	}
	async getSessionStats(): Promise<SessionStats> {
		return this.data(await this.request({ type: "get_session_stats" }));
	}
	/** Which tools are active, which are not (and why), and which selected names nothing registered. */
	async getTools(): Promise<ToolStatusReport> {
		return this.data(await this.request({ type: "get_tools" }));
	}
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		return this.data(await this.request({ type: "export_html", outputPath }));
	}
	async switchSession(
		sessionId: string,
		cwdOverride?: string,
		sessionDirectory?: string,
	): Promise<{ cancelled: boolean; notices?: readonly RpcResumeNotice[] }> {
		return this.data(await this.request({ type: "switch_session", sessionId, cwdOverride, sessionDirectory }));
	}
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		return this.data(await this.request({ type: "fork", entryId }));
	}
	async clone(): Promise<{ cancelled: boolean }> {
		return this.data(await this.request({ type: "clone" }));
	}
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		return this.data<{ messages: Array<{ entryId: string; text: string }> }>(
			await this.request({ type: "get_fork_messages" }),
		).messages;
	}
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }>;
	async getEntries(options: {
		readonly windowOnly: true;
		readonly mirror?: RpcMirrorPosition;
	}): Promise<RpcContextWindow>;
	async getEntries(
		options?: string | { readonly windowOnly: true; readonly mirror?: RpcMirrorPosition },
	): Promise<RpcContextWindow> {
		return this.data(
			await this.request(
				typeof options === "object"
					? { type: "get_context_window", ...(options.mirror && { mirror: options.mirror }) }
					: { type: "get_entries", since: options },
			),
		);
	}
	async getHistoryPage(
		options: {
			readonly cursor?: string;
			readonly fromSeq?: number;
			readonly toSeq?: number;
			readonly pageEntries?: number;
			readonly privateCut?: import("../../core/storage/session/memory-session-store.js").PrivateMirrorCut;
		} = {},
	): Promise<RpcHistoryPage> {
		return this.data(await this.request({ type: "get_history_page", ...options }));
	}
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		return this.data(await this.request({ type: "get_tree" }));
	}
	async getHistoryChunk(reference: OversizedSessionEntry, offset = 0): Promise<RpcHistoryChunk> {
		return this.data(await this.request({ type: "get_history_chunk", reference, offset }));
	}
	async getLastAssistantText(): Promise<string | null> {
		return this.data<{ text: string | null }>(await this.request({ type: "get_last_assistant_text" })).text;
	}
	async setSessionName(name: string): Promise<void> {
		await this.request({ type: "set_session_name", name });
	}
	async getMessages(): Promise<AgentMessage[]> {
		return this.data<{ messages: AgentMessage[] }>(await this.request({ type: "get_messages" })).messages;
	}

	/** Which queued messages the session's store holds (see the `find_queued_messages` command). */
	async findQueuedMessages(query: {
		readonly ids: readonly string[];
		readonly after: number;
		readonly epoch?: string;
		readonly sessionId?: string;
		readonly sessionFile?: string;
	}): Promise<{ saved: string[]; absent: string[] }> {
		return this.data<{ saved: string[]; absent: string[] }>(
			await this.request({
				type: "find_queued_messages",
				ids: [...query.ids],
				after: query.after,
				...(query.epoch === undefined ? {} : { epoch: query.epoch }),
				...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
				...(query.sessionFile === undefined ? {} : { sessionFile: query.sessionFile }),
			}),
		);
	}
	async getCommands(): Promise<RpcSlashCommand[]> {
		return this.data<{ commands: RpcSlashCommand[] }>(await this.request({ type: "get_commands" })).commands;
	}
	async getCommandCompletions(commandName: string, argumentPrefix: string): Promise<RpcAutocompleteItem[] | null> {
		return this.data<{ completions: RpcAutocompleteItem[] | null }>(
			await this.request({ type: "get_command_completions", commandName, argumentPrefix }),
		).completions;
	}
}
