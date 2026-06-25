import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";
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
		case "model_change":
			parts.push("model", entry.modelId);
			break;
		case "thinking_level_change":
			parts.push("thinking", entry.thinkingLevel);
			break;
		case "context_window_change":
			parts.push("context window", String(entry.contextWindow));
			break;
		case "custom":
			parts.push("custom", entry.customType);
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
			const tokens = Math.round(entry.tokensBefore / 1000);
			result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
			break;
		}
		case "branch_summary":
			result = theme.fg("warning", `[branch summary]: `) + normalizeText(entry.summary);
			break;
		case "model_change":
			result = theme.fg("dim", `[model: ${entry.modelId}]`);
			break;
		case "thinking_level_change":
			result = theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
			break;
		case "context_window_change":
			result = theme.fg("dim", `[context window: ${entry.contextWindow}]`);
			break;
		case "custom":
			result = theme.fg("dim", `[custom: ${entry.customType}]`);
			break;
		case "label":
			result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
			break;
		case "session_info":
			result = entry.name
				? [theme.fg("dim", "[title: "), theme.fg("dim", entry.name), theme.fg("dim", "]")].join("")
				: [theme.fg("dim", "[title: "), theme.italic(theme.fg("dim", "empty")), theme.fg("dim", "]")].join("");
			break;
		default:
			result = "";
	}

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
	const shortenPath = (p: string): string => {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
		return p;
	};

	switch (name) {
		case "read": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let display = path;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				display += `:${start}${end ? `-${end}` : ""}`;
			}
			return `[read: ${display}]`;
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
