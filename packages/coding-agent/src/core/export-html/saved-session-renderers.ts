import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getExportTemplateDirAsync } from "../../config.js";
import { installHostModuleBridge } from "../extensions/host-module-bridge.ts";
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

/** Load a presentation asset at runtime, like a shipped extension bundle. A static import would fold its
 * dependencies (including the build host's native binding) into every platform's shared CLI. */
async function loadExtensionCards(): Promise<typeof import("./extension-cards.mjs").extensionCard | undefined> {
	try {
		await installHostModuleBridge();
		const url = pathToFileURL(join(await getExportTemplateDirAsync(), "extension-cards.mjs"));
		return ((await import(url.href)) as typeof import("./extension-cards.mjs")).extensionCard;
	} catch {
		// An incomplete installation can still show the original arguments and results with the HTML template.
		return undefined;
	}
}

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
	return needsCards ? loadExtensionCards() : undefined;
}
