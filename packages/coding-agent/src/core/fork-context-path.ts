import { buildContextEntries } from "./session-manager-history.ts";
import type { SessionEntry } from "./session-manager-types.ts";
import { TOOL_OUTPUT_ENTRY_TYPE } from "./session-tool-output.ts";
import { TOOL_DEACTIVATION_ENTRY_TYPE } from "./tool-deactivation.ts";

const forkSettings = new Set(["workspace_binding", TOOL_DEACTIVATION_ENTRY_TYPE, "codemode-store"]);

/** A new child inherits request content, not the source's admission authority or its recoverable operations.
 * Model-visible content from a notice is still the same provider input, but is no longer a deliverable card. */
export function forkContextPath(path: SessionEntry[]): SessionEntry[] {
	const leaf = path.at(-1);
	if (!leaf) return [];
	const window = new Set(buildContextEntries(path, leaf.id, undefined, path).map((e) => e.id));
	const anchors = new Set<string>();
	const toolResults = new Set<string>();
	for (const entry of path) {
		if (!window.has(entry.id)) continue;
		if (entry.type === "compaction") {
			if (entry.firstKeptEntryId !== null) anchors.add(entry.firstKeptEntryId);
			if (entry.coveredThroughEntryId !== undefined) anchors.add(entry.coveredThroughEntryId);
		}
		if (entry.type === "message" && entry.message.role === "toolResult") toolResults.add(entry.message.toolCallId);
	}
	const retained: SessionEntry[] = [];
	for (const source of path) {
		let entry: SessionEntry | undefined = source;
		if (source.type === "custom") {
			const ref =
				source.customType === TOOL_OUTPUT_ENTRY_TYPE &&
				(source.data as { toolCallId?: string } | undefined)?.toolCallId;
			if (!forkSettings.has(source.customType) && !(ref && toolResults.has(ref))) entry = undefined;
		} else if (source.type === "custom_message") {
			if (!window.has(source.id) || source.excludeFromContext) entry = undefined;
			else if (
				source.protectedReconciliation ||
				source.stageAdmissionKey ||
				/^(intercom|subagent|workflow|task)[._:-]/.test(source.customType)
			) {
				entry = {
					type: "custom_message",
					id: source.id,
					parentId: source.parentId,
					timestamp: source.timestamp,
					customType: "atomic.inherited-context",
					content: source.content,
					display: false,
				};
			}
		}
		if (!entry && anchors.has(source.id))
			entry = {
				type: "custom",
				customType: "atomic.fork-anchor",
				id: source.id,
				parentId: source.parentId,
				timestamp: source.timestamp,
			};
		if (!entry) continue;
		const parentId = retained.at(-1)?.id ?? null;
		retained.push(entry.parentId === parentId ? entry : { ...entry, parentId });
	}
	return retained.length
		? retained
		: [{ type: "custom", customType: "atomic.fork-anchor", id: leaf.id, parentId: null, timestamp: leaf.timestamp }];
}
