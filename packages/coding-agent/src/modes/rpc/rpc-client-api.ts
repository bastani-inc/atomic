import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai/compat";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { VerbatimCompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type {
	RpcCommand,
	RpcAutocompleteItem,
	RpcContextWindowInfo,
	RpcLogoutProviderResult,
	RpcModelRefreshResult,
	RpcResponse,
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
}

export abstract class RpcClientApi {
	protected abstract request(command: RpcCommandBody): Promise<RpcResponse>;
	protected abstract data<T>(response: RpcResponse): T;

	async prompt(message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
		await this.request({ type: "prompt", message, images, streamingBehavior });
	}
	async steer(message: string, images?: ImageContent[]): Promise<void> { await this.request({ type: "steer", message, images }); }
	async followUp(message: string, images?: ImageContent[]): Promise<void> { await this.request({ type: "follow_up", message, images }); }
	async abort(): Promise<void> { await this.request({ type: "abort" }); }
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		return this.data(await this.request({ type: "new_session", parentSession }));
	}
	async getState(): Promise<RpcSessionState> { return this.data(await this.request({ type: "get_state" })); }
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		return this.data(await this.request({ type: "set_model", provider, modelId }));
	}
	async cycleModel(direction?: "forward" | "backward"): Promise<{
		model: Model<Api>; thinkingLevel: ThinkingLevel; isScoped: boolean;
	} | null> {
		return this.data(await this.request({ type: "cycle_model", direction }));
	}
	async getAvailableModels(): Promise<ModelInfo[]> {
		return this.data<{ models: ModelInfo[] }>(await this.request({ type: "get_available_models" })).models;
	}
	async logoutProvider(provider: string): Promise<RpcLogoutProviderResult> {
		return this.data(await this.request({ type: "logout_provider", provider }));
	}

	async refreshModels(options: { timeoutMs?: number; force?: boolean; allowNetwork?: boolean } = {}): Promise<RpcModelRefreshResult> {
		return this.data(await this.request({ type: "refresh_models", ...options }));
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> { await this.request({ type: "set_thinking_level", level }); }
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		return this.data(await this.request({ type: "cycle_thinking_level" }));
	}
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		return this.data<{ levels: ThinkingLevel[] }>(
			await this.request({ type: "get_available_thinking_levels" }),
		).levels;
	}
	async setContextWindow(contextWindow: number | string): Promise<void> {
		this.data(await this.request({ type: "set_context_window", contextWindow }));
	}
	async getAvailableContextWindows(): Promise<RpcContextWindowInfo> {
		return this.data(await this.request({ type: "get_available_context_windows" }));
	}
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> { await this.request({ type: "set_steering_mode", mode }); }
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> { await this.request({ type: "set_follow_up_mode", mode }); }
	async compact(): Promise<VerbatimCompactionResult> { return this.data(await this.request({ type: "compact" })); }
	async setAutoCompaction(enabled: boolean): Promise<void> { await this.request({ type: "set_auto_compaction", enabled }); }
	async setAutoRetry(enabled: boolean): Promise<void> { await this.request({ type: "set_auto_retry", enabled }); }
	async abortRetry(): Promise<void> { await this.request({ type: "abort_retry" }); }
	async bash(command: string): Promise<BashResult> { return this.data(await this.request({ type: "bash", command })); }
	async abortBash(): Promise<void> { await this.request({ type: "abort_bash" }); }
	async getSessionStats(): Promise<SessionStats> { return this.data(await this.request({ type: "get_session_stats" })); }
	async exportHtml(outputPath?: string): Promise<{ path: string }> { return this.data(await this.request({ type: "export_html", outputPath })); }
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return this.data(await this.request({ type: "switch_session", sessionPath }));
	}
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> { return this.data(await this.request({ type: "fork", entryId })); }
	async clone(): Promise<{ cancelled: boolean }> { return this.data(await this.request({ type: "clone" })); }
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		return this.data<{ messages: Array<{ entryId: string; text: string }> }>(await this.request({ type: "get_fork_messages" })).messages;
	}
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		return this.data(await this.request({ type: "get_entries", since }));
	}
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> { return this.data(await this.request({ type: "get_tree" })); }
	async getLastAssistantText(): Promise<string | null> {
		return this.data<{ text: string | null }>(await this.request({ type: "get_last_assistant_text" })).text;
	}
	async setSessionName(name: string): Promise<void> { await this.request({ type: "set_session_name", name }); }
	async getMessages(): Promise<AgentMessage[]> {
		return this.data<{ messages: AgentMessage[] }>(await this.request({ type: "get_messages" })).messages;
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
