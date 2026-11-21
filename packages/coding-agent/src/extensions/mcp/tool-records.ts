/**
 * Records of the MCP tools a session declared to the model, kept in the session so a resumed session can keep
 * declaring them while their servers reconnect.
 *
 * A session declares an MCP tool with its server's listing of it. When the session is resumed, the servers start
 * again and list their tools only once connected. Without a record, the first request after the resume would declare
 * those tools removed and the next one declare them again, which changes the tool list the provider has cached. With
 * the record, the resumed session registers the tool from it until the server reconnects, and a call to it waits for
 * the server and runs only when the server lists the same tool again.
 */

import { createHash } from "node:crypto";
import { getCurrentTools, jsonSchemasEqual, type SystemMessage } from "@bastani/atomic-ai";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { Tool as McpTool } from "./client/index.js";
import type { McpServerEntry } from "./config.ts";
import { LIST_MCP_RESOURCE_TEMPLATES_TOOL, LIST_MCP_RESOURCES_TOOL, READ_MCP_RESOURCE_TOOL } from "./resources.js";

/** The built-in tools that reach the servers' resources; they are declared while a server has resources. */
export const RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
	LIST_MCP_RESOURCES_TOOL,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	READ_MCP_RESOURCE_TOOL,
]);

/** Custom entry type of the records. Kept with the branch when a long session resumes from a later window. */
export const MCP_TOOL_RECORD_ENTRY_TYPE = "atomic.mcp-tool-definitions";

/** One declared MCP tool: the name it was declared under, its server, and the server's listing of it. */
export interface McpToolRecord {
	name: string;
	server: string;
	/** Fingerprint of the server's URL or command, so a record is not used for a server that now points elsewhere. */
	transport: string;
	tool: McpTool;
}

/** A server the resource tools reached when they were declared. */
export interface McpResourceServerRecord {
	server: string;
	transport: string;
}

export interface McpToolRecordData {
	tools: McpToolRecord[];
	/** The servers with resources, when the resource tools are declared and the set changed. */
	resourceServers?: McpResourceServerRecord[];
}

/** What the branch's records say: the latest record of each tool name, and of the servers with resources. */
export interface McpToolRecords {
	tools: Map<string, McpToolRecord>;
	resourceServers: McpResourceServerRecord[] | undefined;
}

/** The fields of a listed tool that its declaration and calls depend on. */
export function recordableTool(tool: McpTool): McpTool {
	return {
		name: tool.name,
		...(tool.title === undefined ? {} : { title: tool.title }),
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema: tool.inputSchema,
		...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
		...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
	};
}

/** JSON with object keys sorted, so the order a server writes them in does not matter. Arrays keep their order. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
	const keys = Object.keys(value)
		.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/**
 * Whether two listings of a tool describe the same tool. Its schemas compare as tool declarations do, so a listing whose
 * `required` names come in another order is the same tool.
 */
export function sameListedTool(left: McpTool, right: McpTool): boolean {
	const { inputSchema: leftInput, outputSchema: leftOutput, ...leftRest } = recordableTool(left);
	const { inputSchema: rightInput, outputSchema: rightOutput, ...rightRest } = recordableTool(right);
	return (
		canonicalJson(leftRest) === canonicalJson(rightRest) &&
		jsonSchemasEqual(leftInput, rightInput) &&
		jsonSchemasEqual(leftOutput, rightOutput)
	);
}

/** Whether two records describe the same tool of the same server under the same name. */
export function sameToolRecord(left: McpToolRecord, right: McpToolRecord): boolean {
	return (
		left.name === right.name &&
		left.server === right.server &&
		left.transport === right.transport &&
		sameListedTool(left.tool, right.tool)
	);
}

/**
 * The scheme, host, port and path of a server URL. Credentials, the query and the fragment are left out: they may
 * hold secrets, and a call to a recorded tool runs only if the server lists the same tool again anyway.
 */
function urlTarget(url: string): string {
	if (URL.canParse(url)) {
		const { protocol, host, pathname } = new URL(url);
		return `${protocol}//${host}${pathname}`;
	}
	// Not a URL until its placeholders are filled in, such as `${MCP_URL}`: cut the same parts out of the text.
	const [beforeQuery = ""] = url.split(/[?#]/, 1);
	return beforeQuery.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, "$1");
}

/**
 * A hash of what the server connects to. It leaves out the credentials a URL, headers or environment may hold, so
 * the session stores nothing derived from them.
 */
export function transportFingerprint(entry: McpServerEntry): string {
	const { config } = entry;
	const target =
		"url" in config
			? { url: urlTarget(config.url) }
			: { command: config.command, args: config.args ?? [], ...(config.cwd ? { cwd: config.cwd } : {}) };
	return createHash("sha256").update(JSON.stringify(target)).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolRecord(value: unknown): value is McpToolRecord {
	if (!isRecord(value) || !isRecord(value.tool)) return false;
	return (
		typeof value.name === "string" &&
		value.name.startsWith("mcp__") &&
		typeof value.server === "string" &&
		typeof value.transport === "string" &&
		typeof value.tool.name === "string" &&
		isRecord(value.tool.inputSchema)
	);
}

function isResourceServerRecord(value: unknown): value is McpResourceServerRecord {
	return isRecord(value) && typeof value.server === "string" && typeof value.transport === "string";
}

/** The latest records on the branch. Malformed records are ignored. */
export function readToolRecords(branch: readonly SessionEntry[]): McpToolRecords {
	const tools = new Map<string, McpToolRecord>();
	let resourceServers: McpResourceServerRecord[] | undefined;
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== MCP_TOOL_RECORD_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const { data } = entry;
		if (Array.isArray(data.tools))
			for (const record of data.tools) if (isToolRecord(record)) tools.set(record.name, record);
		if (Array.isArray(data.resourceServers)) resourceServers = data.resourceServers.filter(isResourceServerRecord);
	}
	return { tools, resourceServers };
}

/** Whether the MCP integration records the declaration of a tool of this name. */
export function isRecordedToolName(name: string): boolean {
	return name.startsWith("mcp__") || RESOURCE_TOOL_NAMES.has(name);
}

/** Names of the MCP tools and resource tools the branch's transcript declares now. */
export function declaredMcpToolNames(branch: readonly SessionEntry[]): Set<string> {
	const systemMessages: SystemMessage[] = [];
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "system") systemMessages.push(entry.message);
		else if (entry.type === "compaction" && entry.systemMessage) systemMessages.push(entry.systemMessage);
	}
	return new Set(
		getCurrentTools(systemMessages)
			.map((tool) => tool.name)
			.filter(isRecordedToolName),
	);
}
