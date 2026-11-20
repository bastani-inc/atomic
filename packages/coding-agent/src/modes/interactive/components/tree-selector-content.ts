import { formatModelLabel } from "../../../core/model-label.ts";
import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { formatReadLineRange } from "../../../core/tools/render-utils.ts";
import { shortenHomePath } from "../../../utils/paths.ts";
import { formatTokenCount } from "../../../utils/token-count.ts";
import { type ThemeColor, theme } from "../theme/theme.js";
import type { ToolCallInfo } from "./tree-selector-types.ts";

export function getSearchableText(node: SessionTreeNode): string {
	const entry = node.entry;
	const parts: string[] = [];

	if (node.label) {
		parts.push(node.label);
	}

	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			parts.push(msg.role);
			if ("content" in msg && msg.content) {
				parts.push(extractContent(msg.content));
			}
			if (msg.role === "bashExecution") {
				const bashMsg = msg as { command?: string };
				if (bashMsg.command) parts.push(bashMsg.command);
			}
			break;
		}
		case "custom_message": {
			parts.push(entry.customType);
			if (typeof entry.content === "string") {
				parts.push(entry.content);
			} else {
				parts.push(extractContent(entry.content));
			}
			break;
		}
		case "compaction":
			parts.push("compaction");
			break;
		case "branch_summary":
			parts.push("branch summary", entry.summary);
			break;
		case "session_info":
			parts.push("title");
			if (entry.name) parts.push(entry.name);
			break;
		case "session_summary":
			parts.push("session summary", entry.summary);
			break;
		case "worktree_snapshot":
			parts.push("snapshot", entry.root);
			break;
		case "model_change":
			parts.push("model", entry.modelId);
			break;
		case "thinking_level_change":
			parts.push("thinking", entry.thinkingLevel);
			break;
		case "custom":
			parts.push("custom", entry.customType);
			break;
		case "context_edit":
			parts.push("context edit", entry.replacement === null ? "omit" : "replace", entry.targetId);
			break;
		case "label":
			parts.push("label", entry.label ?? "");
			break;
	}

	return parts.join(" ");
}

export function getEntryDisplayText(
	node: SessionTreeNode,
	isSelected: boolean,
	toolCallMap: Map<string, ToolCallInfo>,
): string {
	const entry = node.entry;
	let result: string;

	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			const role = msg.role;
			if (role === "user") {
				const msgWithContent = msg as { content?: unknown };
				const content = normalizeText(extractContent(msgWithContent.content));
				result = theme.fg("accent", "user: ") + content;
			} else if (role === "assistant") {
				const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
				const textContent = normalizeText(extractContent(msgWithContent.content));
				if (textContent) {
					result = theme.fg("success", "assistant: ") + textContent;
				} else if (msgWithContent.stopReason === "aborted") {
					result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
				} else if (msgWithContent.errorMessage) {
					const errMsg = normalizeText(msgWithContent.errorMessage).slice(0, 80);
					result = theme.fg("success", "assistant: ") + theme.fg("error", errMsg);
				} else {
					result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
				}
			} else if (role === "toolResult") {
				const toolMsg = msg as { toolCallId?: string; toolName?: string };
				const toolCall = toolMsg.toolCallId ? toolCallMap.get(toolMsg.toolCallId) : undefined;
				if (toolCall) {
					result = theme.fg("muted", formatToolCall(toolCall.name, toolCall.arguments));
				} else {
					result = theme.fg("muted", `[${toolMsg.toolName ?? "tool"}]`);
				}
			} else if (role === "bashExecution") {
				const bashMsg = msg as { command?: string };
				result = theme.fg("dim", `[bash]: ${normalizeText(bashMsg.command ?? "")}`);
			} else {
				result = theme.fg("dim", `[${role}]`);
			}
			break;
		}
		case "custom_message": {
			const content =
				typeof entry.content === "string"
					? entry.content
					: entry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalizeText(content);
			break;
		}
		case "compaction": {
			result = theme.fg("borderAccent", `[compaction: ${formatTokenCount(entry.tokensBefore)} tokens]`);
			break;
		}
		case "branch_summary":
			result = theme.fg("warning", `[branch summary]: `) + normalizeText(entry.summary);
			break;
		case "model_change":
			result = theme.fg("dim", `[model: ${formatModelLabel({ provider: entry.provider, id: entry.modelId })}]`);
			break;
		case "thinking_level_change":
			result = theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
			break;
		case "custom":
			result = theme.fg("dim", `[custom: ${entry.customType}]`);
			break;
		case "context_edit":
			result = theme.fg("dim", `[context ${entry.replacement === null ? "omit" : "replace"}: ${entry.targetId}]`);
			break;
		case "label":
			result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
			break;
		case "session_info":
			result = entry.name
				? [theme.fg("dim", "[title: "), theme.fg("dim", entry.name), theme.fg("dim", "]")].join("")
				: [theme.fg("dim", "[title: "), theme.italic(theme.fg("dim", "empty")), theme.fg("dim", "]")].join("");
			break;
		case "session_summary":
			result = theme.fg("dim", `[session summary]: `) + normalizeText(entry.summary);
			break;
		case "worktree_snapshot":
			result = theme.fg("dim", `[snapshot: ${entry.root} ${entry.snapshotId.slice(0, 12)}]`);
			break;
		default:
			result = "";
	}

	return isSelected ? theme.bold(result) : result;
}

// The fixed start of each row's full text, so a stored row keeps its place and colour while its text is read.
const pendingFrames: Record<string, readonly [ThemeColor, string, string]> = {
	user: ["accent", "user: ", ""],
	assistant: ["success", "assistant: ", ""],
	toolResult: ["muted", "[", "]"],
	bashExecution: ["dim", "[bash]: ", ""],
	custom_message: ["customMessageLabel", "[", "]"],
	compaction: ["borderAccent", "[compaction: ", "]"],
	branch_summary: ["warning", "[branch summary]: ", ""],
	model_change: ["dim", "[model: ", "]"],
	thinking_level_change: ["dim", "[thinking: ", "]"],
	custom: ["dim", "[custom: ", "]"],
	context_edit: ["dim", "[context ", "]"],
	label: ["dim", "[label: ", "]"],
	session_info: ["dim", "[title: ", "]"],
	session_summary: ["dim", "[session summary]: ", ""],
	worktree_snapshot: ["dim", "[snapshot: ", "]"],
};

/** A stored row whose text is still being read (…), or could not be read (unavailable). */
export function getPendingDisplayText(
	row: { readonly type: string; readonly role?: string } | undefined,
	isSelected: boolean,
	failed: boolean,
): string {
	const gap = failed ? theme.fg("error", "unavailable") : theme.fg("dim", "…");
	const kind = row?.type === "message" ? row.role : row?.type;
	const frame = kind !== undefined && Object.hasOwn(pendingFrames, kind) ? pendingFrames[kind] : undefined;
	let result: string;
	if (frame) {
		const [color, open, close] = frame;
		result = theme.fg(color, open) + gap + (close ? theme.fg(color, close) : "");
	} else if (row?.type === "message" && !failed) {
		// Any other role shows just its name, which the outline already has.
		result = theme.fg("dim", `[${row.role}]`);
	} else result = gap;
	return isSelected ? theme.bold(result) : result;
}

export function formatLabelTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	const now = new Date();
	const hours = date.getHours().toString().padStart(2, "0");
	const minutes = date.getMinutes().toString().padStart(2, "0");
	const time = `${hours}:${minutes}`;

	if (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	) {
		return time;
	}

	const month = date.getMonth() + 1;
	const day = date.getDate();
	if (date.getFullYear() === now.getFullYear()) {
		return `${month}/${day} ${time}`;
	}

	const year = date.getFullYear().toString().slice(-2);
	return `${year}/${month}/${day} ${time}`;
}

export function extractContent(content: unknown): string {
	const maxLen = 200;
	if (typeof content === "string") return content.slice(0, maxLen);
	if (Array.isArray(content)) {
		let result = "";
		for (const c of content) {
			if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
				result += (c as { text: string }).text;
				if (result.length >= maxLen) return result.slice(0, maxLen);
			}
		}
		return result;
	}
	return "";
}

export function hasTextContent(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (Array.isArray(content)) {
		for (const c of content) {
			if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
				const text = (c as { text?: string }).text;
				if (text && text.trim().length > 0) return true;
			}
		}
	}
	return false;
}

function normalizeText(s: string): string {
	return s.replace(/[\n\t]/g, " ").trim();
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	const shortenPath = (p: string): string => shortenHomePath(p, process.env.HOME || process.env.USERPROFILE || "");

	switch (name) {
		case "read": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			return `[read: ${path}${formatReadLineRange(args.offset, args.limit)}]`;
		}
		case "write": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			return `[write: ${path}]`;
		}
		case "edit": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			return `[edit: ${path}]`;
		}
		case "bash": {
			const rawCmd = String(args.command || "");
			const cmd = rawCmd
				.replace(/[\n\t]/g, " ")
				.trim()
				.slice(0, 50);
			return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
		}
		case "find": {
			const pattern = String(args.pattern || "");
			const path = shortenPath(String(args.path || "."));
			return `[find: ${pattern} in ${path}]`;
		}
		case "ls": {
			const path = shortenPath(String(args.path || "."));
			return `[ls: ${path}]`;
		}
		default: {
			// Custom tool - show name and truncated JSON args
			const serializedArgs = JSON.stringify(args);
			const argsStr = serializedArgs.slice(0, 40);
			return `[${name}: ${argsStr}${serializedArgs.length > 40 ? "..." : ""}]`;
		}
	}
}
