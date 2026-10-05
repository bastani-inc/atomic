import { getCurrentSystemMessage } from "@bastani/pi-ai";
import type { ImageContent } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { runCallback } from "../callback-activity.ts";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "../system-prompt.ts";
import type {
	AgentBeforeSettleEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BoundaryContextPreview,
	BoundaryResult,
	ContextEvent,
	ContextEventResult,
	ContextWithSystemEvent,
	Extension,
	ExtensionContext,
	ExtensionError,
	ExtensionEvent,
	InputEvent,
	InputEventResult,
	InputSource,
	MessageEndEvent,
	MessageEndEventResult,
	ProjectTrustEvent,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionBoundaryDraft,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

/** Combined result from all before_agent_start handlers. */
export interface BeforeAgentStartCombinedResult {
	messages: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

export interface ResourcesDiscoverCombinedResult {
	skillPaths: Array<{ path: string; extensionPath: string }>;
	promptPaths: Array<{ path: string; extensionPath: string }>;
	themePaths: Array<{ path: string; extensionPath: string }>;
}

/** Events handled by the generic emit() method. */
export type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| ContextWithSystemEvent
	| BeforeProviderRequestEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
	| TurnEndEvent
	| AgentBeforeSettleEvent
>;

export type BoundaryBaseEvent =
	| Omit<TurnEndEvent, "entries" | "continue" | "context">
	| Omit<AgentBeforeSettleEvent, "entries" | "continue" | "context">;

export interface BoundaryDispatchResult {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	valid: boolean;
}

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

export type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

type EmitExtensionError = (error: ExtensionError) => void;

const isSessionBeforeEvent = (event: RunnerEmitEvent): event is SessionBeforeEvent =>
	event.type === "session_before_switch" ||
	event.type === "session_before_fork" ||
	event.type === "session_before_compact" ||
	event.type === "session_before_tree";

function shutdownErrorMessage(error: unknown): string {
	if (error instanceof AggregateError && error.errors.length > 0)
		return error.errors.map(shutdownErrorMessage).join("; ");
	return error instanceof Error ? error.message : String(error);
}

const emitCaughtError = (emitError: EmitExtensionError, extensionPath: string, event: string, error: unknown): void => {
	emitError({
		extensionPath,
		event,
		error:
			event === "session_shutdown"
				? shutdownErrorMessage(error)
				: error instanceof Error
					? error.message
					: String(error),
		stack: error instanceof Error ? error.stack : undefined,
	});
};

export function snapshotEventHandlers(extensions: Extension[], event: ExtensionEvent["type"]) {
	return extensions.map((ext) => ({ ext, handlers: ext.handlers.get(event)?.slice() ?? [] }));
}

export async function runGenericHandlers<TEvent extends RunnerEmitEvent>(
	extensions: Extension[],
	ctx: ExtensionContext,
	event: TEvent,
	emitError: EmitExtensionError,
	isCurrent?: () => boolean,
): Promise<RunnerEmitResult<TEvent>> {
	let result: SessionBeforeEventResult | undefined;
	const promptNotifications: Promise<void>[] = [];

	for (const { ext, handlers } of snapshotEventHandlers(extensions, event.type)) {
		for (const handler of handlers) {
			// Workflow publishers can retire while a previous handler awaits.
			if (isCurrent && !isCurrent()) return result as RunnerEmitResult<TEvent>;
			try {
				const invocation = runCallback(
					{ kind: "extension.hook", name: event.type, sourcePath: ext.path },
					// Activity reporting may yield again before invoking the callback.
					() => (!isCurrent || isCurrent() ? handler(event, ctx) : undefined),
				);
				if (event.type === "ui_prompt_start" || event.type === "ui_prompt_end") {
					// These notifications dispatch independently. Awaiting one observer here
					// lets an end overtake its start at every later observer, leaving a false block.
					promptNotifications.push(
						invocation.then(
							() => {},
							(error) => emitCaughtError(emitError, ext.path, event.type, error),
						),
					);
					continue;
				}
				const handlerResult = await invocation;
				if (isSessionBeforeEvent(event) && handlerResult) {
					result = handlerResult as SessionBeforeEventResult;
					if (result.cancel) return result as RunnerEmitResult<TEvent>;
				}
			} catch (error) {
				emitCaughtError(emitError, ext.path, event.type, error);
			}
		}
	}

	if (promptNotifications.length > 0) await Promise.all(promptNotifications);
	return result as RunnerEmitResult<TEvent>;
}

export async function runMessageEndHandlers(
	extensions: Extension[],
	ctx: ExtensionContext,
	event: MessageEndEvent,
	emitError: EmitExtensionError,
): Promise<AgentMessage | undefined> {
	let currentMessage = event.message;
	let modified = false;

	for (const { ext, handlers } of snapshotEventHandlers(extensions, "message_end")) {
		for (const handler of handlers) {
			try {
				const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
				const handlerResult = (await runCallback(
					{ kind: "extension.hook", name: currentEvent.type, sourcePath: ext.path },
					() => handler(currentEvent, ctx),
				)) as MessageEndEventResult | undefined;
				if (!handlerResult?.message) continue;

				if (handlerResult.message.role !== currentMessage.role) {
					emitError({
						extensionPath: ext.path,
						event: "message_end",
						error: "message_end handlers must return a message with the same role",
					});
					continue;
				}

				currentMessage = handlerResult.message;
				modified = true;
			} catch (error) {
				emitCaughtError(emitError, ext.path, "message_end", error);
			}
		}
	}

	return modified ? currentMessage : undefined;
}

export async function runToolResultHandlers(
	extensions: Extension[],
	ctx: ExtensionContext,
	event: ToolResultEvent,
	emitError: EmitExtensionError,
): Promise<ToolResultEventResult | undefined> {
	const currentEvent: ToolResultEvent = { ...event };
	let modified = false;

	for (const { ext, handlers } of snapshotEventHandlers(extensions, "tool_result")) {
		for (const handler of handlers) {
			try {
				const handlerResult = (await runCallback(
					{ kind: "extension.hook", name: currentEvent.type, sourcePath: ext.path },
					() => handler(currentEvent, ctx),
				)) as ToolResultEventResult | undefined;
				if (!handlerResult) continue;
				if (handlerResult.content !== undefined) {
					currentEvent.content = handlerResult.content;
					currentEvent.structuredContent = handlerResult.structuredContent;
					modified = true;
				}
				if (handlerResult.details !== undefined) {
					currentEvent.details = handlerResult.details;
					modified = true;
				}
				if (handlerResult.structuredContent !== undefined) {
					currentEvent.structuredContent = handlerResult.structuredContent;
					modified = true;
				}
				if (handlerResult.usage !== undefined) {
					currentEvent.usage = handlerResult.usage;
					modified = true;
				}
				if (handlerResult.isError !== undefined) {
					currentEvent.isError = handlerResult.isError;
					modified = true;
				}
			} catch (error) {
				emitCaughtError(emitError, ext.path, "tool_result", error);
			}
		}
	}

	return modified
		? {
				content: currentEvent.content,
				details: currentEvent.details,
				isError: currentEvent.isError,
				structuredContent: currentEvent.structuredContent,
				usage: currentEvent.usage,
			}
		: undefined;
}

export async function runToolCallHandlers(
	extensions: Extension[],
	ctx: ExtensionContext,
	event: ToolCallEvent,
): Promise<ToolCallEventResult | undefined> {
	let result: ToolCallEventResult | undefined;

	for (const { ext, handlers } of snapshotEventHandlers(extensions, "tool_call")) {
		for (const handler of handlers) {
			const handlerResult = await runCallback(
				{ kind: "extension.hook", name: event.type, sourcePath: ext.path },
				() => handler(event, ctx),
			);
			if (handlerResult) {
				result = handlerResult as ToolCallEventResult;
				if (result.block) return result;
			}
		}
	}

	return result;
}

function isUserBashEventResult(value: unknown): value is UserBashEventResult {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const hasOperations = candidate.operations !== undefined;
	const hasResult = candidate.result !== undefined;
	if (hasOperations === hasResult) return false;
	if (hasOperations) {
		const operations = candidate.operations;
		return (
			typeof operations === "object" &&
			operations !== null &&
			typeof (operations as Record<string, unknown>).exec === "function"
		);
	}
	const result = candidate.result;
	if (typeof result !== "object" || result === null) return false;
	const record = result as Record<string, unknown>;
	return (
		typeof record.output === "string" &&
		"exitCode" in record &&
		(record.exitCode === undefined || typeof record.exitCode === "number") &&
		typeof record.cancelled === "boolean" &&
		typeof record.truncated === "boolean" &&
		(record.fullOutputPath === undefined || typeof record.fullOutputPath === "string")
	);
}

export async function runUserBashHandlers(
	extensions: Extension[],
	ctx: ExtensionContext,
	event: UserBashEvent,
	emitError: EmitExtensionError,
): Promise<UserBashEventResult | undefined> {
	for (const { ext, handlers } of snapshotEventHandlers(extensions, "user_bash")) {
		for (const handler of handlers) {
			try {
				const handlerResult = await runCallback(
					{ kind: "extension.hook", name: event.type, sourcePath: ext.path },
					() => handler(event, ctx),
				);
				if (handlerResult === undefined) continue;
				if (!isUserBashEventResult(handlerResult)) {
					throw new Error(
						"Invalid user_bash handler result: return undefined for local execution or exactly one valid { operations } or { result } object",
					);
				}
				return handlerResult;
			} catch (error) {
				emitCaughtError(emitError, ext.path, "user_bash", error);
				throw error;
			}
		}
	}

	return undefined;
}

function sameMessages(left: AgentMessage[], right: AgentMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/**
 * Re-attach the prompt and tool state after a `context` handler. Handlers only see the
 * conversation; the system messages belong to Atomic. An unchanged conversation keeps every
 * system message in place, so models with mid-conversation support keep their cached
 * prefix. A changed one gets the replayed prompt sections and tool declarations as one
 * leading system message, so pruning, windowing, or slicing from a compaction summary
 * cannot drop them.
 */
function restoreSystemMessages(
	current: AgentMessage[],
	visible: AgentMessage[],
	returned: AgentMessage[],
): AgentMessage[] {
	if (sameMessages(returned, visible)) return current;
	const head = getCurrentSystemMessage(current);
	return head ? [head, ...returned] : returned;
}

/**
 * Run the request-time transforms in two phases. `context` handlers see the conversation
 * only and Atomic restores the prompt and tool state after each; `context_with_system`
 * handlers then see the full transcript and their output is used as returned.
 */
export async function runContextHandlers(
	extensions: Extension[],
	ctx: ExtensionContext,
	messages: AgentMessage[],
	emitError: EmitExtensionError,
): Promise<AgentMessage[]> {
	let currentMessages = structuredClone(messages);

	for (const { ext, handlers } of snapshotEventHandlers(extensions, "context")) {
		for (const handler of handlers) {
			try {
				const visibleMessages = currentMessages.filter((message) => message.role !== "system");
				const visibleSnapshot = visibleMessages.slice();
				const event: ContextEvent = { type: "context", messages: visibleMessages };
				const handlerResult = (await runCallback(
					{ kind: "extension.hook", name: event.type, sourcePath: ext.path },
					() => handler(event, ctx),
				)) as ContextEventResult | undefined;

				// Handlers may return a new list or edit event.messages in place.
				const returned =
					handlerResult?.messages ??
					(sameMessages(visibleMessages, visibleSnapshot) ? undefined : visibleMessages);
				if (!returned) continue;
				currentMessages = restoreSystemMessages(currentMessages, visibleSnapshot, returned);
			} catch (error) {
				emitCaughtError(emitError, ext.path, "context", error);
			}
		}
	}

	for (const { ext, handlers } of snapshotEventHandlers(extensions, "context_with_system")) {
		for (const handler of handlers) {
			try {
				const hadLeadingSystemMessage = currentMessages[0]?.role === "system";
				const event: ContextWithSystemEvent = { type: "context_with_system", messages: currentMessages };
				const handlerResult = (await runCallback(
					{ kind: "extension.hook", name: event.type, sourcePath: ext.path },
					() => handler(event, ctx),
				)) as ContextEventResult | undefined;
				currentMessages = handlerResult?.messages ?? currentMessages;
				// Providers read the prompt and initial tools from the leading system message.
				// Losing it is never intended; report it but honor the handler's output.
				if (hadLeadingSystemMessage && currentMessages[0]?.role !== "system") {
					emitError({
						extensionPath: ext.path,
						event: "context_with_system",
						error: "Handler removed the leading system message; the request has no prompt or initial tool declarations. Keep it at index 0 or replace a dropped prefix with getCurrentSystemMessage().",
					});
				}
			} catch (error) {
				emitCaughtError(emitError, ext.path, "context_with_system", error);
			}
		}
	}

	return currentMessages;
}

/** Dispatch an actionable boundary event, revalidating the context preview after every handler. */
export async function runBoundaryHandlers(
	extensions: Extension[],
	ctx: ExtensionContext,
	baseEvent: BoundaryBaseEvent,
	buildContext: (entries: SessionBoundaryDraft[]) => BoundaryContextPreview | Promise<BoundaryContextPreview>,
	emitError: EmitExtensionError,
): Promise<BoundaryDispatchResult> {
	let entries: SessionBoundaryDraft[] = [];
	let shouldContinue = false;
	let context = await buildContext(entries);
	let valid = true;

	for (const { ext, handlers } of snapshotEventHandlers(extensions, baseEvent.type)) {
		for (const handler of handlers) {
			const event = {
				...baseEvent,
				entries,
				continue: shouldContinue,
				context,
			} as TurnEndEvent | AgentBeforeSettleEvent;
			try {
				const handlerResult = (await runCallback(
					{ kind: "extension.hook", name: event.type, sourcePath: ext.path },
					() => handler(event, ctx),
				)) as BoundaryResult | undefined;
				if (handlerResult?.entries !== undefined) entries = handlerResult.entries;
				if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
			} catch (error) {
				emitCaughtError(emitError, ext.path, baseEvent.type, error);
			}

			try {
				context = await buildContext(entries);
				valid = true;
			} catch (error) {
				valid = false;
				emitError({
					extensionPath: ext.path,
					event: baseEvent.type,
					error: `Invalid boundary entries: ${error instanceof Error ? error.message : String(error)}`,
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}

	return valid
		? { entries, continue: shouldContinue, context, valid: true }
		: { entries: [], continue: false, context, valid: false };
}

export async function runBeforeProviderRequestHandlers(
	extensions: Extension[],
	ctx: ExtensionContext,
	payload: unknown,
	emitError: EmitExtensionError,
): Promise<unknown> {
	let currentPayload = payload;

	for (const { ext, handlers } of snapshotEventHandlers(extensions, "before_provider_request")) {
		for (const handler of handlers) {
			try {
				const event: BeforeProviderRequestEvent = { type: "before_provider_request", payload: currentPayload };
				const handlerResult = await runCallback(
					{ kind: "extension.hook", name: event.type, sourcePath: ext.path },
					() => handler(event, ctx),
				);
				if (handlerResult !== undefined) currentPayload = handlerResult;
			} catch (error) {
				emitCaughtError(emitError, ext.path, "before_provider_request", error);
			}
		}
	}

	return currentPayload;
}

export async function runBeforeAgentStartHandlers(
	extensions: Extension[],
	baseCtx: ExtensionContext,
	assertActive: () => void,
	prompt: string,
	images: ImageContent[] | undefined,
	baseOptions: BuildSystemPromptOptions,
	emitError: EmitExtensionError,
): Promise<BeforeAgentStartCombinedResult> {
	const systemPromptOptions = normalizeBuildSystemPromptOptions(baseOptions);
	const ctx = Object.defineProperties({}, Object.getOwnPropertyDescriptors(baseCtx)) as ExtensionContext;
	ctx.getSystemPrompt = () => {
		assertActive();
		return buildSystemPrompt(systemPromptOptions);
	};
	const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];

	for (const { ext, handlers } of snapshotEventHandlers(extensions, "before_agent_start")) {
		for (const handler of handlers) {
			try {
				const event: BeforeAgentStartEvent = {
					type: "before_agent_start",
					prompt,
					images,
					get systemPrompt() {
						return buildSystemPrompt(systemPromptOptions);
					},
					systemPromptOptions,
				};
				const handlerResult = await runCallback(
					{ kind: "extension.hook", name: event.type, sourcePath: ext.path },
					() => handler(event, ctx),
				);
				if (!handlerResult) continue;

				const result = handlerResult as BeforeAgentStartEventResult;
				if (result.message) messages.push(result.message);
				if (result.systemPrompt !== undefined) {
					systemPromptOptions.forceSystemPrompt = result.systemPrompt;
				}
			} catch (error) {
				emitCaughtError(emitError, ext.path, "before_agent_start", error);
			}
		}
	}

	return { messages, systemPromptOptions };
}

export async function runResourcesDiscoverHandlers(
	extensions: Extension[],
	ctx: ExtensionContext,
	cwd: string,
	reason: ResourcesDiscoverEvent["reason"],
	emitError: EmitExtensionError,
): Promise<ResourcesDiscoverCombinedResult> {
	const skillPaths: ResourcesDiscoverCombinedResult["skillPaths"] = [];
	const promptPaths: ResourcesDiscoverCombinedResult["promptPaths"] = [];
	const themePaths: ResourcesDiscoverCombinedResult["themePaths"] = [];

	for (const { ext, handlers } of snapshotEventHandlers(extensions, "resources_discover")) {
		for (const handler of handlers) {
			try {
				const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
				const result = (await runCallback({ kind: "extension.hook", name: event.type, sourcePath: ext.path }, () =>
					handler(event, ctx),
				)) as ResourcesDiscoverResult | undefined;
				if (result?.skillPaths?.length) {
					skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
				}
				if (result?.promptPaths?.length) {
					promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
				}
				if (result?.themePaths?.length) {
					themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
				}
			} catch (error) {
				emitCaughtError(emitError, ext.path, "resources_discover", error);
			}
		}
	}

	return { skillPaths, promptPaths, themePaths };
}

export async function runInputHandlers(
	extensions: Extension[],
	ctx: ExtensionContext,
	text: string,
	images: ImageContent[] | undefined,
	source: InputSource,
	streamingBehavior: "steer" | "followUp" | undefined,
	emitError: EmitExtensionError,
): Promise<InputEventResult> {
	let currentText = text;
	let currentImages = images;

	for (const { ext, handlers } of snapshotEventHandlers(extensions, "input")) {
		for (const handler of handlers) {
			try {
				const event: InputEvent = {
					type: "input",
					text: currentText,
					images: currentImages,
					source,
					streamingBehavior,
				};
				const result = (await runCallback({ kind: "extension.hook", name: event.type, sourcePath: ext.path }, () =>
					handler(event, ctx),
				)) as InputEventResult | undefined;
				if (result?.action === "handled") return result;
				if (result?.action === "transform") {
					currentText = result.text;
					currentImages = result.images ?? currentImages;
				}
			} catch (error) {
				emitCaughtError(emitError, ext.path, "input", error);
			}
		}
	}

	return currentText !== text || currentImages !== images
		? { action: "transform", text: currentText, images: currentImages }
		: { action: "continue" };
}
