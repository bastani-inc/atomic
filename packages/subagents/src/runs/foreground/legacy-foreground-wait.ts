import type { ExtensionContext } from "@bastani/atomic";
import type { SubagentToolResult } from "../../shared/types.js";
import type { SubagentParamsLike } from "./subagent-executor-types.js";

/** The line a launch that still asks to wait in the foreground gets first in its result. */
export const LEGACY_FOREGROUND_WAIT_NOTE =
	'Note: subagents always run in the background; the foreground wait this call asked for was removed. Use subagent({ action: "wait", id }) to wait for a launched child.';

/** How many entries back from its session's leaf a running call's assistant message is looked for. */
const ISSUING_MESSAGE_SEARCH_DEPTH = 256;

function asksForForeground(args: unknown): boolean {
	const wait = typeof args === "object" && args !== null ? (args as { wait?: unknown }).wait : undefined;
	return typeof wait === "object" && wait !== null && (wait as { kind?: unknown }).kind === "foreground";
}

/**
 * Drops the `wait` a call still passes, which the tool no longer has: every launch runs in the background. Whether the
 * call asked to wait in the foreground stays in its own arguments, which {@link takeLegacyForegroundWait} reads.
 */
export function withoutLegacyWait<T extends object>(args: T): T {
	if (!Object.hasOwn(args, "wait")) return args;
	return Object.fromEntries(Object.entries(args).filter(([key]) => key !== "wait")) as T;
}

/**
 * Whether the model's call `toolCallId` asked to wait in the foreground, read from the assistant message that issued
 * it: a session saves that message before it runs any of its calls, and it is the session's latest.
 */
function issuedCallAsksForeground(
	sessionManager: Pick<ExtensionContext["sessionManager"], "getLeafId" | "getEntry">,
	toolCallId: string,
): boolean {
	let entryId = sessionManager.getLeafId();
	for (let depth = 0; entryId !== null && depth < ISSUING_MESSAGE_SEARCH_DEPTH; depth++) {
		const entry = sessionManager.getEntry(entryId);
		if (entry === undefined) return false;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const call = entry.message.content.find((block) => block.type === "toolCall" && block.id === toolCallId);
			return call?.type === "toolCall" && asksForForeground(call.arguments);
		}
		entryId = entry.parentId;
	}
	return false;
}

/**
 * The launch to run, without the `wait` it may still pass, and whether this very call asked to wait in the foreground:
 * in the arguments an extension or SDK caller passed, or in the saved assistant message that issued a model's call.
 * Nothing is remembered between calls, so no other launch is ever told about it.
 */
export function takeLegacyForegroundWait(
	toolCallId: string,
	params: SubagentParamsLike,
	ctx: Pick<ExtensionContext, "sessionManager">,
): { readonly params: SubagentParamsLike; readonly foreground: boolean } {
	const foreground = asksForForeground(params) || issuedCallAsksForeground(ctx.sessionManager, toolCallId);
	return { params: withoutLegacyWait(params), foreground };
}

/** The result with {@link LEGACY_FOREGROUND_WAIT_NOTE} as its first line. */
export function withLegacyForegroundWaitNote(result: SubagentToolResult): SubagentToolResult {
	const [first, ...rest] = result.content;
	const content =
		first?.type === "text"
			? [{ ...first, text: `${LEGACY_FOREGROUND_WAIT_NOTE}\n${first.text}` }, ...rest]
			: [{ type: "text" as const, text: LEGACY_FOREGROUND_WAIT_NOTE }, ...result.content];
	return { ...result, content };
}
