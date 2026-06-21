import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionMode,
	ExtensionUIContext,
	InputSource,
	OrchestrationContext,
	SessionStartEvent,
	ShutdownHandler,
	ToolDefinition,
} from "./extensions/index.ts";
import type { CustomMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SourceInfo } from "./source-info.ts";
import type { BashCommandPolicy } from "./tools/bash-policy.ts";
import type { ContextCompactionResult } from "./compaction/index.ts";

export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "context_compaction_start"; reason: "manual" }
	| { type: "session_info_changed"; name: string | undefined }
	| {
			type: "model_changed";
			model: Model<Api>;
			previousModel: Model<Api> | undefined;
			source: "set" | "cycle" | "restore";
	  }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "context_window_changed"; contextWindow: number }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: ContextCompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "context_compaction_end";
			reason: "manual";
			result: ContextCompactionResult | undefined;
			aborted: boolean;
			willRetry: false;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export type ContextWindowReplaySource = "session" | "model-settings" | "global-settings";

export interface ContextWindowReplayRequest {
	contextWindow: number;
	source: ContextWindowReplaySource;
}

export const COPILOT_CONTEXT_WINDOW_SELECTION_OPTIONS = {
	allowCopilotLongContextFallback: true,
} as const;

export interface PendingAgentMessageQueue {
	hasItems(): boolean;
	drain(): AgentMessage[];
}

export interface AgentQueueAccess {
	readonly steeringQueue?: PendingAgentMessageQueue;
	readonly followUpQueue?: PendingAgentMessageQueue;
}

export interface DrainedAgentQueues {
	readonly steering: AgentMessage[];
	readonly followUp: AgentMessage[];
}

export interface InterruptQueueHold {
	readonly steering: AgentMessage[];
	readonly followUp: AgentMessage[];
}

export function drainAgentMessageQueue(queue: PendingAgentMessageQueue | undefined): AgentMessage[] {
	if (!queue) return [];
	const drained: AgentMessage[] = [];
	while (queue.hasItems()) {
		drained.push(...queue.drain());
	}
	return drained;
}

export function normalizeInterruptAbortMessage(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function isGenericAbortText(value: string): boolean {
	const normalized = value.trim().toLowerCase().replace(/[.!]+$/, "");
	return (
		normalized === "operation aborted" ||
		normalized === "the operation was aborted" ||
		normalized === "request was aborted" ||
		normalized === "this operation was aborted" ||
		normalized === "extension custom ui aborted"
	);
}

export function isSingleGenericAbortTextContent(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.length === 1 &&
		typeof content[0] === "object" &&
		content[0] !== null &&
		(content[0] as { type?: unknown }).type === "text" &&
		typeof (content[0] as { text?: unknown }).text === "string" &&
		isGenericAbortText((content[0] as { text: string }).text)
	);
}

export function replacementAbortContent(text: string): TextContent[] {
	return [{ type: "text", text }];
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	resourceLoader: ResourceLoader;
	customTools?: ToolDefinition[];
	bashPolicy?: BashCommandPolicy;
	modelRegistry: ModelRegistry;
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	baseToolsOverride?: Record<string, AgentTool>;
	extensionRunnerRef?: { current?: import("./extensions/index.ts").ExtensionRunner };
	sessionStartEvent?: SessionStartEvent;
	orchestrationContext?: OrchestrationContext;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface PromptOptions {
	expandPromptTemplates?: boolean;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	source?: InputSource;
	preflightResult?: (success: boolean) => void;
}

export interface ModelCycleResult {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	isScoped: boolean;
}

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

export interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export function customMessageExcludesContext(message: CustomMessage): boolean {
	return (message as CustomMessage & { excludeFromContext?: boolean }).excludeFromContext === true;
}

export type AssistantMessageWithError = AssistantMessage;
