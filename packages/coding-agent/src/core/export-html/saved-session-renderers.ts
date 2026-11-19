import { codemodeRenderers, savedCodemodeRenderers } from "../../extensions/codemode/renderer.js";
import type { ToolRenderers } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";

const extensionTools = new Set([
	"subagent",
	"workflow",
	"intercom",
	"contact_supervisor",
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
]);

/** Resolve only shipped presentation code, never extension factories or modules named by the session file. */
export async function savedSessionToolRenderers(entries: readonly SessionEntry[]) {
	const needsCards = entries.some(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			Array.isArray(entry.message.content) &&
			entry.message.content.some(
				(block) =>
					block.type === "toolCall" &&
					typeof block.name === "string" &&
					(extensionTools.has(block.name) || block.name.startsWith("mcp__")),
			),
	);
	const extension = needsCards ? (await import("./extension-cards.mjs")).extensionCard : undefined;
	return {
		getToolRenderers: (name: string): ToolRenderers | undefined =>
			name === "codemode" ? savedCodemodeRenderers : extension?.(name),
		getNestedToolRenderers: (name: string): ToolRenderers | undefined =>
			name === "codemode" ? codemodeRenderers : extension?.(name),
	};
}
