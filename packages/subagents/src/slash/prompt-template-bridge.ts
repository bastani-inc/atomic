import {
	type BridgeRequestSettlement,
	emitBridgeEvent,
	readBridgeRequestSettlement,
	registerBridgeRequestSettlement,
	rejectStoppedBridgeRequest,
} from "./bridge-settlement.ts";
export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";

/**
 * Register the rejection path for an out-of-tree prompt-template requester.
 * The requester must unregister this hook when its response or cancellation
 * path settles; the hook is used only when a stale bridge drops an emit.
 */
export function registerPromptTemplateBridgeRequestSettlement(
	requestId: string,
	reject: (error: unknown) => void,
): () => void {
	return registerBridgeRequestSettlement("prompt-template", requestId, { reject });
}

interface PromptTemplateDelegationTask {
	agent: string;
	task: string;
	model?: string;
	cwd?: string;
}

interface PromptTemplateDelegationParallelResult {
	agent: string;
	messages: unknown[];
	isError: boolean;
	errorText?: string;
}

interface PromptTemplateDelegationRequest {
	requestId: string;
	agent: string;
	task: string;
	tasks?: PromptTemplateDelegationTask[];
	context: "fresh" | "fork";
	model: string;
	cwd: string;
	worktree?: boolean;
}

interface PromptTemplateDelegationResponse extends PromptTemplateDelegationRequest {
	messages: unknown[];
	parallelResults?: PromptTemplateDelegationParallelResult[];
	contentText?: string;
	isError: boolean;
	errorText?: string;
}

interface PromptTemplateDelegationTaskProgress {
	index?: number;
	agent: string;
	status?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

interface PromptTemplateDelegationUpdate {
	requestId: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	taskProgress?: PromptTemplateDelegationTaskProgress[];
}

export interface PromptTemplateBridgeEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | undefined;
	emit(event: string, data: unknown): void;
}

interface PromptTemplateBridgeResult {
	isError?: boolean;
	content?: unknown;
	details?: {
		results?: Array<{
			agent?: string;
			status?: "ok" | "error" | "skipped" | "interrupted" | "continued";
			messages?: unknown[];
			finalOutput?: string;
			error?: string;
			model?: string;
			toolCalls?: Array<{ text?: string; expandedText?: string }>;
		}>;
		progress?: Array<{
			index?: number;
			agent?: string;
			status?: string;
			currentTool?: string;
			currentToolArgs?: string;
			recentOutput?: string[];
			recentTools?: Array<{ tool?: string; args?: string }>;
			toolCount?: number;
			durationMs?: number;
			tokens?: number;
		}>;
	};
}

interface PromptTemplateBridgeOptions<Ctx extends { cwd?: string }> {
	events: PromptTemplateBridgeEvents;
	getContext: () => Ctx | null;
	execute: (
		requestId: string,
		request: PromptTemplateDelegationRequest,
		signal: AbortSignal,
		ctx: Ctx,
		onUpdate: (result: PromptTemplateBridgeResult) => void,
	) => Promise<PromptTemplateBridgeResult>;
}

function parseDelegationTasks(tasks: unknown): PromptTemplateDelegationTask[] {
	if (!Array.isArray(tasks)) return [];
	const parsed: PromptTemplateDelegationTask[] = [];
	for (const item of tasks) {
		if (!item || typeof item !== "object") return [];
		const value = item as Partial<PromptTemplateDelegationTask>;
		if (typeof value.agent !== "string" || !value.agent.trim()) return [];
		if (typeof value.task !== "string" || !value.task.trim()) return [];
		const model = typeof value.model === "string" && value.model.trim().length > 0 ? value.model : undefined;
		const cwd = typeof value.cwd === "string" && value.cwd.trim().length > 0 ? value.cwd : undefined;
		parsed.push({
			agent: value.agent,
			task: value.task,
			...(model ? { model } : {}),
			...(cwd ? { cwd } : {}),
		});
	}
	return parsed;
}

function parsePromptTemplateRequest(data: unknown): PromptTemplateDelegationRequest | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = data as Partial<PromptTemplateDelegationRequest> & { tasks?: unknown };
	if (typeof value.requestId !== "string" || !value.requestId) return undefined;
	if (typeof value.model !== "string" || !value.model) return undefined;
	if (typeof value.cwd !== "string" || !value.cwd) return undefined;
	if (value.context !== "fresh" && value.context !== "fork") return undefined;
	const tasks = parseDelegationTasks(value.tasks);
	const worktree = value.worktree === true ? true : undefined;
	const hasSingle =
		typeof value.agent === "string" &&
		value.agent.length > 0 &&
		typeof value.task === "string" &&
		value.task.length > 0;
	if (!hasSingle && tasks.length === 0) return undefined;

	const fallbackTask = tasks[0];
	const agent = hasSingle ? value.agent : fallbackTask?.agent;
	const task = hasSingle ? value.task : fallbackTask?.task;
	if (!agent || !task) return undefined;
	return {
		requestId: value.requestId,
		agent,
		task,
		...(tasks.length > 0 ? { tasks } : {}),
		context: value.context,
		model: value.model,
		cwd: value.cwd,
		...(worktree ? { worktree } : {}),
	};
}

function firstTextContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ((part as { type?: string }).type !== "text") continue;
		const text = (part as { text?: unknown }).text;
		if (typeof text === "string" && text.trim()) return text.trim();
	}
	return undefined;
}

function filterRecentOutput(lines: string[] | undefined): string[] | undefined {
	if (!lines || lines.length === 0) return undefined;
	const filtered = lines.filter((line) => typeof line === "string" && line.trim() && line.trim() !== "(running...)");
	if (filtered.length === 0) return undefined;
	return filtered;
}

function sanitizeRecentTools(
	tools: Array<{ tool?: string; args?: string }> | undefined,
): Array<{ tool: string; args: string }> | undefined {
	if (!tools || tools.length === 0) return undefined;
	const sanitized = tools.flatMap((entry) => {
		if (typeof entry.tool !== "string" || entry.tool.trim().length === 0) return [];
		return [
			{
				tool: entry.tool,
				args: typeof entry.args === "string" ? entry.args : String(entry.args ?? ""),
			},
		];
	});
	return sanitized.length > 0 ? sanitized : undefined;
}

function resolveProgressModel(
	update: PromptTemplateBridgeResult,
	entry: { index?: number; agent?: string },
): string | undefined {
	const results = update.details?.results;
	if (!results || results.length === 0) return undefined;
	if (typeof entry.index === "number" && entry.index >= 0) {
		const byIndex = results[entry.index];
		if (typeof byIndex?.model === "string") return byIndex.model;
	}
	if (entry.agent) {
		const byAgent = results.find((result) => result.agent === entry.agent && typeof result.model === "string");
		if (byAgent?.model) return byAgent.model;
	}
	const firstWithModel = results.find((result) => typeof result.model === "string");
	return firstWithModel?.model;
}

function toolCallSummaryText(summary: { text?: string; expandedText?: string }): string | undefined {
	const text =
		typeof summary.expandedText === "string" && summary.expandedText.trim().length > 0
			? summary.expandedText.trim()
			: typeof summary.text === "string"
				? summary.text.trim()
				: "";
	return text || undefined;
}

function buildDelegationMessages(
	result: { messages?: unknown[]; finalOutput?: string; toolCalls?: Array<{ text?: string; expandedText?: string }> },
	fallbackText?: string,
): unknown[] {
	if (Array.isArray(result.messages) && result.messages.length > 0) return result.messages;
	const toolCallSummaries = (result.toolCalls ?? []).flatMap((summary) => {
		const text = toolCallSummaryText(summary);
		return text ? [`- ${text}`] : [];
	});
	const toolCallText = toolCallSummaries.length > 0 ? `Tool calls:\n${toolCallSummaries.join("\n")}` : undefined;
	const text =
		typeof result.finalOutput === "string" && result.finalOutput.trim().length > 0
			? result.finalOutput.trim()
			: fallbackText;
	const contentText = [toolCallText, text].filter((part): part is string => Boolean(part)).join("\n\n");
	if (!contentText) return [];
	return [{ role: "assistant", content: [{ type: "text", text: contentText }] }];
}

function toDelegationUpdate(
	requestId: string,
	update: PromptTemplateBridgeResult,
): PromptTemplateDelegationUpdate | undefined {
	const progress = update.details?.progress?.[0];
	const taskProgress = update.details?.progress?.map((entry) => {
		const lastOutput = entry.recentOutput?.[entry.recentOutput.length - 1];
		const safeLastOutput =
			typeof lastOutput === "string" && lastOutput.trim() && lastOutput !== "(running...)" ? lastOutput : undefined;
		return {
			index: entry.index,
			agent: entry.agent ?? "delegate",
			status: entry.status,
			currentTool: entry.currentTool,
			currentToolArgs: entry.currentToolArgs,
			recentOutput: safeLastOutput,
			recentOutputLines: filterRecentOutput(entry.recentOutput),
			recentTools: sanitizeRecentTools(entry.recentTools),
			model: resolveProgressModel(update, entry),
			toolCount: entry.toolCount,
			durationMs: entry.durationMs,
			tokens: entry.tokens,
		};
	});
	if (!progress && (!taskProgress || taskProgress.length === 0)) return undefined;
	const lastOutput = progress?.recentOutput?.[progress.recentOutput.length - 1];
	const safeLastOutput =
		typeof lastOutput === "string" && lastOutput.trim() && lastOutput !== "(running...)" ? lastOutput : undefined;
	return {
		requestId,
		currentTool: progress?.currentTool,
		currentToolArgs: progress?.currentToolArgs,
		recentOutput: safeLastOutput,
		recentOutputLines: filterRecentOutput(progress?.recentOutput),
		recentTools: sanitizeRecentTools(progress?.recentTools),
		model: progress ? resolveProgressModel(update, progress) : undefined,
		toolCount: progress?.toolCount,
		durationMs: progress?.durationMs,
		tokens: progress?.tokens,
		taskProgress,
	};
}

export function registerPromptTemplateDelegationBridge<Ctx extends { cwd?: string }>(
	options: PromptTemplateBridgeOptions<Ctx>,
): {
	cancelAll: () => void;
	dispose: () => void;
} {
	const controllers = new Map<string, AbortController>();
	const activeSettlements = new Map<string, BridgeRequestSettlement>();
	const pendingCancels = new Set<string>();
	const subscriptions: Array<() => void> = [];

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!data || typeof data !== "object") return;
		const requestId = (data as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		const controller = controllers.get(requestId);
		if (controller) {
			controller.abort();
			return;
		}
		pendingCancels.add(requestId);
	});

	subscribe(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, async (data) => {
		const request = parsePromptTemplateRequest(data);
		if (!request) return;
		const settlement = readBridgeRequestSettlement(data, "prompt-template");

		const ctx = options.getContext();
		if (!ctx) {
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: "No active extension context for delegated subagent execution.",
			};
			emitBridgeEvent(options.events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response, settlement);
			return;
		}

		const controller = new AbortController();
		controllers.set(request.requestId, controller);
		if (settlement) activeSettlements.set(request.requestId, settlement);

		if (pendingCancels.delete(request.requestId)) {
			controller.abort();
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: "Delegated prompt cancelled.",
			};
			emitBridgeEvent(options.events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response, settlement);
			controllers.delete(request.requestId);
			activeSettlements.delete(request.requestId);
			return;
		}

		if (
			!emitBridgeEvent(
				options.events,
				PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
				{ requestId: request.requestId },
				settlement,
			)
		) {
			controller.abort();
			controllers.delete(request.requestId);
			activeSettlements.delete(request.requestId);
			return;
		}

		try {
			const result = await options.execute(request.requestId, request, controller.signal, ctx, (update) => {
				const payload = toDelegationUpdate(request.requestId, update);
				if (!payload) return;
				if (!emitBridgeEvent(options.events, PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload, settlement)) {
					controller.abort();
				}
			});
			const contentText = firstTextContent(result.content);
			const messages = buildDelegationMessages(result.details?.results?.[0] ?? {}, contentText);
			const parallelResults = request.tasks
				? request.tasks.map<PromptTemplateDelegationParallelResult>((task, index) => {
						const step = result.details?.results?.[index];
						if (!step) {
							return {
								agent: task.agent,
								messages: [],
								isError: true,
								errorText: "Missing result for delegated parallel task.",
							};
						}
						const errorText = step.error;
						return {
							agent: step.agent ?? task.agent,
							messages: buildDelegationMessages(step),
							isError: step.status === "error" || !!errorText,
							errorText: errorText || undefined,
						};
					})
				: undefined;
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages,
				...(parallelResults ? { parallelResults } : {}),
				...(contentText ? { contentText } : {}),
				isError: result.isError === true,
				errorText: result.isError ? contentText : undefined,
			};
			emitBridgeEvent(options.events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response, settlement);
		} catch (error) {
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: error instanceof Error ? error.message : String(error),
			};
			emitBridgeEvent(options.events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response, settlement);
		} finally {
			controllers.delete(request.requestId);
			activeSettlements.delete(request.requestId);
		}
	});

	return {
		cancelAll: () => {
			for (const [requestId, controller] of controllers) {
				rejectStoppedBridgeRequest(activeSettlements.get(requestId));
				controller.abort();
			}
			controllers.clear();
			activeSettlements.clear();
			pendingCancels.clear();
		},
		dispose: () => {
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
			pendingCancels.clear();
		},
	};
}
