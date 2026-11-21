/**
 * Records of the MCP tools a session declared to the model, kept in the session so a resumed session can keep
 * declaring them while their servers reconnect.
 *
 * A session declares an MCP tool with its server's listing of it. When the session is resumed, the servers start
 * again and list their tools only once connected. Without a record, the first request after the resume would declare
 * those tools removed and the next one declare them again, which changes the tool list the provider has cached. With
 * the record, the resumed session registers the tool from it until the server reconnects, and a call to it waits for
 * the server and runs only when the server lists the same tool again.
 *
 * The records also keep the summary the `mcp_servers` section showed for each server, so a resumed session shows it
 * while the server reconnects instead of sending the section without it and again with it.
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

/** Where the server a record was written for was defined: its `McpServerEntry.scope`, null for none. */
export type McpRecordScope = NonNullable<McpServerEntry["scope"]> | null;

/** The server a record was written for, so a record is not used for a server that now points elsewhere. */
export interface McpServerIdentity {
	/** Fingerprint of the server's URL or command. */
	transport: string;
	/** Where the server was defined. Records written before it was recorded have none (see recordMatchesServer). */
	scope?: McpRecordScope;
}

/** One declared MCP tool: the name it was declared under, its server, and the server's listing of it. */
export interface McpToolRecord extends McpServerIdentity {
	name: string;
	server: string;
	tool: McpTool;
}

/** A server the resource tools reached when they were declared. */
export interface McpResourceServerRecord extends McpServerIdentity {
	server: string;
}

/** The summary the `mcp_servers` section showed for a server, as the section showed it (empty for none). */
export interface McpServerSummaryRecord extends McpServerIdentity {
	server: string;
	summary: string;
	/** The section had room for only the ellipsis of a longer summary. With room for one character it shows none. */
	cut?: true;
}

export interface McpToolRecordData {
	tools: McpToolRecord[];
	/** The servers with resources, when the resource tools are declared and the set changed. */
	resourceServers?: McpResourceServerRecord[];
	/** The server summaries the section showed, when they changed. */
	summaries?: McpServerSummaryRecord[];
}

/**
 * What the branch's records say: the latest record of each tool name, of the servers with resources, and of each
 * server's summary (servers whose latest summary record is empty have none).
 */
export interface McpToolRecords {
	tools: Map<string, McpToolRecord>;
	resourceServers: McpResourceServerRecord[] | undefined;
	summaries: Map<string, McpServerSummaryRecord>;
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
		left.scope === right.scope &&
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

function fingerprint(entry: McpServerEntry, args: (args: string[] | undefined) => string[]): string {
	const { config } = entry;
	const target =
		"url" in config
			? { url: urlTarget(config.url) }
			: { command: config.command, args: args(config.args), ...(config.cwd ? { cwd: config.cwd } : {}) };
	return createHash("sha256").update(JSON.stringify(target)).digest("hex").slice(0, 16);
}

/**
 * A hash of what the server connects to. It leaves out the credentials a URL, headers, environment or command
 * arguments may hold, so the session stores nothing derived from them. A command's arguments are all left out, since
 * any of them can be a token; they are hashed as an empty list, so a command without arguments keeps the fingerprint
 * earlier versions recorded.
 */
export function transportFingerprint(entry: McpServerEntry): string {
	return fingerprint(entry, () => []);
}

/** What a record names of the server it was written for. */
export function serverIdentity(entry: McpServerEntry): Required<McpServerIdentity> {
	return { transport: transportFingerprint(entry), scope: entry.scope ?? null };
}

/**
 * Whether a record was written for this server: the same URL or command, defined in the same place, so a record of a
 * project's server is not used for a global server of the same name. Records written before arguments were left out
 * name no scope and hash the command's arguments too: they count only while the arguments are unchanged.
 */
export function recordMatchesServer(entry: McpServerEntry, record: McpServerIdentity): boolean {
	if (record.scope === undefined) return fingerprint(entry, (args) => args ?? []) === record.transport;
	return record.scope === (entry.scope ?? null) && record.transport === transportFingerprint(entry);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServerRecord(value: unknown): value is Record<string, unknown> & { server: string } & McpServerIdentity {
	return (
		isRecord(value) &&
		typeof value.server === "string" &&
		typeof value.transport === "string" &&
		(value.scope === undefined || value.scope === null || typeof value.scope === "string")
	);
}

function isToolRecord(value: unknown): value is McpToolRecord {
	if (!isServerRecord(value) || !isRecord(value.tool)) return false;
	return (
		typeof value.name === "string" &&
		value.name.startsWith("mcp__") &&
		typeof value.tool.name === "string" &&
		isRecord(value.tool.inputSchema)
	);
}

function isSummaryRecord(value: unknown): value is McpServerSummaryRecord {
	return isServerRecord(value) && typeof value.summary === "string" && (value.cut === undefined || value.cut === true);
}

/** The latest records on the branch. Malformed records are ignored. */
export function readToolRecords(branch: readonly SessionEntry[]): McpToolRecords {
	const tools = new Map<string, McpToolRecord>();
	let resourceServers: McpResourceServerRecord[] | undefined;
	const summaries = new Map<string, McpServerSummaryRecord>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== MCP_TOOL_RECORD_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const { data } = entry;
		if (Array.isArray(data.tools))
			for (const record of data.tools) if (isToolRecord(record)) tools.set(record.name, record);
		if (Array.isArray(data.resourceServers)) resourceServers = data.resourceServers.filter(isServerRecord);
		// A record without a summary retires the server's earlier ones.
		for (const record of Array.isArray(data.summaries) ? data.summaries.filter(isSummaryRecord) : []) {
			if (record.summary) summaries.set(record.server, record);
			else summaries.delete(record.server);
		}
	}
	return { tools, resourceServers, summaries };
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

/**
 * The system prompt section `name`, with its tags, as the branch's requests last sent it: the newest system message
 * that sets or removes it, or the prompt a compaction carried over, which has every section.
 */
export function latestSystemSection(branch: readonly SessionEntry[], name: string): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "compaction" && entry.systemMessage) return entry.systemMessage.sections?.[name] ?? undefined;
		if (entry.type !== "message" || entry.message.role !== "system") continue;
		const sections = entry.message.sections;
		if (sections && Object.hasOwn(sections, name)) return sections[name] ?? undefined;
	}
	return undefined;
}
