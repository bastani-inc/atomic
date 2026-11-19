import { CODEMODE_TOOL_NAME, type CodemodeNestedCall } from "../../extensions/codemode/tool.js";
import type { ChatMessageEntry, ChatMessageRenderOptions } from "./components/chat-message-renderer.ts";
import { renderChatMessageEntry, type ToolEntryStateTarget } from "./components/chat-message-renderer.ts";
import {
	CodemodeGenericCallComponent,
	type CodemodeNestedCallComponent,
	CodemodeNestedCalls,
	codemodeNestedToolCalls,
	withoutCodemodeToolCalls,
} from "./components/codemode-nested-calls.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import type { Component } from "./interactive-mode-deps.ts";
import { StartupChatContainer } from "./interactive-startup-chat-container.ts";

/**
 * The main chat draws each tool call a codemode script makes as a block of its own, after the script's block: live
 * from the nested `tool_execution_*` events, and from the blocks the codemode result keeps once the session is
 * reopened. Other tools and their nested calls draw as before.
 */

type LiveNestedComponent = CodemodeNestedCallComponent & ToolEntryStateTarget;
type RenderableResult = Parameters<ToolEntryStateTarget["updateResult"]>[0];

interface CodemodeCall {
	/** The codemode call's block in the chat. */
	readonly block: Component;
	/** Its nested calls' blocks, once it made one. */
	calls?: CodemodeNestedCalls;
	/** The chat was drawn again while the script ran, so it may lack the calls made before; its result has them all. */
	readonly redrawn: boolean;
}

/** The codemode calls of the current run, by tool call id. */
const runs = new WeakMap<InteractiveModeBase, Map<string, CodemodeCall>>();

function codemodeCalls(mode: InteractiveModeBase): Map<string, CodemodeCall> {
	let calls = runs.get(mode);
	if (!calls) {
		calls = new Map();
		runs.set(mode, calls);
	}
	return calls;
}

export function isCodemodeCall(toolName: string): boolean {
	return toolName === CODEMODE_TOOL_NAME;
}

/** What the block of tool `toolName` shows of `result`: a codemode block leaves its tool calls to their own blocks. */
export function chatBlockResult<T extends { details?: unknown }>(toolName: string, result: T): T {
	return isCodemodeCall(toolName) ? withoutCodemodeToolCalls(result) : result;
}

/**
 * Follow codemode call `toolCallId`, drawn as `block`, for the nested calls it makes from now on. `redrawn`: the chat
 * was drawn from the session while the call ran.
 */
export function followCodemodeCall(
	mode: InteractiveModeBase,
	toolCallId: string,
	block: Component,
	redrawn = false,
): void {
	codemodeCalls(mode).set(toolCallId, { block, redrawn });
}

/** The chat is drawn again: the blocks of the calls it followed are gone. */
export function forgetCodemodeCalls(mode: InteractiveModeBase): void {
	runs.delete(mode);
}

/** Puts `calls` right after `block` in the chat, or nowhere when the chat no longer shows `block`. */
function placeAfter(mode: InteractiveModeBase, block: Component, calls: Component): boolean {
	const chat = mode.chatContainer;
	const index = chat.children.indexOf(block);
	if (index < 0) return false;
	if (chat instanceof StartupChatContainer) chat.insertChildren(index + 1, [calls]);
	else chat.children.splice(index + 1, 0, calls);
	return true;
}

/**
 * A nested tool call event, one that carries `parentToolCallId`. The call of a followed codemode call gets a block of
 * its own, drawn by `create` as a direct call of its tool is; nested calls of other tools stay out of the chat.
 */
export function showNestedToolEvent(
	mode: InteractiveModeBase,
	event: {
		type: string;
		parentToolCallId: string;
		toolCallId: string;
		toolName: string;
		args?: unknown;
		partialResult?: unknown;
		result?: unknown;
		isError?: boolean;
		durationMs?: number;
	},
	create: (toolName: string, toolCallId: string, args: unknown) => LiveNestedComponent,
): void {
	const parent = codemodeCalls(mode).get(event.parentToolCallId);
	if (!parent) return;
	if (event.type === "tool_execution_start") {
		if (!parent.calls) {
			const calls = new CodemodeNestedCalls(mode.outputPad, mode.toolOutputExpanded);
			if (!placeAfter(mode, parent.block, calls)) return;
			parent.calls = calls;
		}
		if (parent.calls.has(event.toolCallId)) return;
		const component = create(event.toolName, event.toolCallId, event.args);
		component.setExpanded(mode.toolOutputExpanded);
		component.setArgsComplete();
		component.markExecutionStarted(Date.now());
		parent.calls.add(event.toolCallId, component, true);
	} else {
		const component = parent.calls?.get(event.toolCallId) as LiveNestedComponent | undefined;
		if (!component) return;
		const result = event.type === "tool_execution_end" ? event.result : event.partialResult;
		if (typeof result !== "object" || result === null) return;
		if (event.type === "tool_execution_update") {
			component.updateResult({ ...(result as RenderableResult), isError: false }, true);
		} else {
			component.updateResult({
				...(result as RenderableResult),
				isError: event.isError === true,
				...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
			});
			parent.calls?.settle(event.toolCallId);
		}
	}
	mode.ui.requestRender();
}

/**
 * Codemode call `toolCallId` ended with `result`. A call followed since a redraw while it ran gets its nested blocks
 * from the result, which has every call the script made.
 */
export function endCodemodeCall(mode: InteractiveModeBase, toolCallId: string, result: { details?: unknown }): void {
	const call = codemodeCalls(mode).get(toolCallId);
	if (!call?.redrawn) return;
	const calls = nestedCallsFromResult(mode, mode.chatMessageRenderOptions(), result.details);
	if (!calls) return;
	const previous = call.calls;
	if (previous) {
		const index = mode.chatContainer.children.indexOf(previous);
		if (index >= 0) mode.chatContainer.children[index] = calls;
		previous.dispose();
	} else if (!placeAfter(mode, call.block, calls)) {
		calls.dispose();
		return;
	}
	call.calls = calls;
	mode.ui.requestRender();
}

/** The run ended: a nested call whose end never came was interrupted. */
export function endCodemodeRun(mode: InteractiveModeBase): void {
	for (const call of runs.get(mode)?.values() ?? []) {
		for (const component of call.calls?.runningCalls() ?? []) {
			(component as LiveNestedComponent).updateResult?.({
				content: [{ type: "text", text: "Interrupted" }],
				isError: true,
			});
		}
	}
	runs.delete(mode);
}

/** A nested call's block from what the codemode result kept of it, or a generic row when it kept nothing. */
function savedNestedCall(
	call: CodemodeNestedCall,
	options: ChatMessageRenderOptions,
	outputPad: number,
): CodemodeNestedCallComponent {
	const block = call.block;
	if (!block || typeof block !== "object" || !Array.isArray(block.content))
		return new CodemodeGenericCallComponent(call, options.cwd, outputPad);
	const entry: ChatMessageEntry = {
		role: "tool",
		kind: "tool",
		toolName: call.name,
		toolCallId: call.id,
		args: block.args,
		result: {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: block.content,
			details: block.details,
			isError: block.isError === true,
			timestamp: 0,
			...(call.durationMs === undefined ? {} : { durationMs: Math.round(call.durationMs) }),
		},
		isPartial: false,
		argsComplete: true,
		executionStarted: true,
	};
	return renderChatMessageEntry(entry, options) as CodemodeNestedCallComponent;
}

/** The blocks of the tool calls in a codemode result's `details`, or undefined when it has none. */
function nestedCallsFromResult(
	mode: InteractiveModeBase,
	options: ChatMessageRenderOptions,
	details: unknown,
): CodemodeNestedCalls | undefined {
	const saved = codemodeNestedToolCalls(details);
	if (saved.length === 0) return undefined;
	const calls = new CodemodeNestedCalls(mode.outputPad, mode.toolOutputExpanded);
	for (const call of saved) {
		const component = savedNestedCall(call, options, mode.outputPad);
		component.setExpanded(mode.toolOutputExpanded);
		calls.add(call.id, component);
	}
	return calls;
}

/**
 * After the chat drew `entry` from the session as `block`, the blocks of the tool calls a codemode call made follow
 * it. A codemode call still running is followed for the calls it makes from now on.
 */
export function addSavedCodemodeCalls(
	mode: InteractiveModeBase,
	entry: ChatMessageEntry,
	block: Component,
	options: ChatMessageRenderOptions,
): void {
	if (entry.kind !== "tool" || !isCodemodeCall(entry.toolName)) return;
	if (entry.isPartial !== false || !entry.result) {
		followCodemodeCall(mode, entry.toolCallId, block, true);
		return;
	}
	const calls = nestedCallsFromResult(mode, options, entry.result.details);
	if (calls) mode.chatContainer.addChild(calls);
}
