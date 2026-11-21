/**
 * Built-in MCP integration.
 *
 * Connects the servers from `mcp.json` and the servers extensions register with
 * `pi.registerMcpServer()` when a session starts, and servers registered later right away. A server
 * in `mcp.json` takes precedence over a registered server of the same name. Connections run in the
 * background: the first prompt waits only for servers with `direct` tools, and codemode scripts,
 * `tool_search`, and the resource tools wait for the servers they need when they run. Tools are
 * registered as `mcp__<server>__<tool>`. By default (`"exposure": "codemode"`) the tools are only
 * callable from codemode scripts, which keeps MCP tools out of the model's tool declarations and
 * the codemode description: scripts find the tools with `searchTools()` and the server instructions
 * with `describeNamespace()`. The codemode tool is activated for that unless `autoEnableCodemode` is
 * false or `-codemode` explicitly removed it. `"deferred"` declares the tools to the model once the `tool_search` tool loads them, and
 * activates `tool_search` instead of codemode.
 * `"exposure": "direct"` declares them to the model right away, and `"hidden"` makes them
 * unreachable. `toolExposure` overrides the exposure of single tools. Servers with resources are
 * reached through Codex's `list_mcp_resources`, `list_mcp_resource_templates`, and
 * `read_mcp_resource` tools (resources.ts).
 *
 * Every call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and permission
 * extensions apply to MCP tools the same way they do to built-in tools.
 *
 * The session records each declared MCP tool's listing (tool-records.ts). A resumed session declares those tools
 * from their records while their servers reconnect, so its requests keep the tool list the provider cached; a call
 * waits for the server and runs only if the server lists the same tool again. It also records the summary the
 * `mcp_servers` section showed for each server, and shows it while the server reconnects.
 *
 * Problems found at startup (config errors, failed connections, servers that need a sign-in) are
 * reported once. `/mcp` opens a manager to sign in, reconnect, enable or disable servers, and change
 * their exposure; the last two are saved to the `mcp.json` that defines the server, or apply to the
 * current session for registered servers.
 */

import { join, resolve } from "node:path";
import type { TSchema } from "@bastani/atomic-schema/typebox";
import type { SelectItem } from "@bastani/atomic-tui";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.js";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
	ToolInfo,
} from "../../core/extensions/types.ts";
import { markNativeMcpToolDefinition, matchesMcpDirectToolSelection } from "../../core/mcp-child-policy.ts";
import { mcpNamespace } from "../../core/mcp-servers.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { sliceHead } from "../../core/tools/truncate.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { CODEMODE_TOOL_NAME } from "../codemode/tool.js";
import { TOOL_SEARCH_TOOL_NAME } from "../tool-search/tool.js";
import type { Tool as McpTool } from "./client/index.js";
import {
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfigAsync,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	mcpRequestTimeoutMs,
	updateMcpServerConfigAsync,
} from "./config.ts";
import type { McpOAuthCredentialStore, McpSignInPrompt } from "./oauth.ts";
import { createMcpResourceToolDefinitions } from "./resources.js";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import type * as McpRuntime from "./runtime.ts";
import type { McpServerConnection, McpServerLog, McpTransportFactory } from "./runtime.ts";
import {
	declaredMcpToolNames,
	isRecordedToolName,
	latestSystemSection,
	MCP_TOOL_RECORD_ENTRY_TYPE,
	type McpResourceServerRecord,
	type McpServerIdentity,
	type McpServerSummaryRecord,
	type McpToolRecord,
	type McpToolRecordData,
	type McpToolRecords,
	RESOURCE_TOOL_NAMES,
	readToolRecords,
	recordableTool,
	recordMatchesServer,
	sameListedTool,
	sameToolRecord,
	serverIdentity,
} from "./tool-records.ts";
import { createMcpToolDefinition, createMcpToolName, createMcpToolRenderers, type McpToolDetails } from "./tools.ts";
import { type McpMenu, type McpUi, showMcpManager } from "./ui.ts";

function isCodemodeDiscoveryTool(tool: ToolInfo): boolean {
	return tool.name === CODEMODE_TOOL_NAME && tool.sourceInfo.path === "builtin:codemode";
}

function isToolSearchDiscoveryTool(tool: ToolInfo): boolean {
	return tool.name === TOOL_SEARCH_TOOL_NAME && tool.sourceInfo.path === "builtin:tool-search";
}

export type { McpTransportFactory } from "./runtime.ts";

export interface McpExtensionOptions {
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig | Promise<LoadedMcpConfig>;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	createTransport?: McpTransportFactory;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
	logPath?: string;
	/** Opens the OAuth authorization URL. Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/**
	 * Saves `/mcp` changes to the server's config file: its project `override` when set, else its
	 * `source`. Defaults to editing that `mcp.json`.
	 */
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void | Promise<void>;
	/**
	 * How long the first prompt waits for servers with `direct` tools that are still connecting at
	 * startup, in milliseconds. Their tools become available when they connect. Other servers are
	 * waited for when a script or search needs them. Default: 10000.
	 */
	startupWaitMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;

/** A configured server. Disabled servers have no connection. */
interface McpServer {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	/** For servers extensions registered: the config as registered, to detect re-registrations. */
	registeredConfig?: string;
	attempt?: symbol;
	/** Result of the last `/mcp` action that failed, shown in the manager. */
	message?: string;
	closing?: Promise<void>;
	/** Settles when the connection started for the server connected or failed. */
	ready?: Promise<void>;
}

const EXPOSURE_DESCRIPTIONS: Record<Exclude<McpExposure, "hidden">, string> = {
	codemode: "called from codemode scripts, which find them with searchTools()",
	deferred: "not declared until tool_search loads them, then called directly; no codemode needed",
	direct: "declared to the model like built-in tools",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

function isEnabled(server: Pick<McpServer, "entry">): boolean {
	return server.entry.config.enabled !== false;
}

function hasSelectedMcpServer(selections: readonly string[], name: string): boolean {
	return selections.some((selection) => selection === name || selection.startsWith(`${name}/`));
}

function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? "codemode";
}

/** Exposures the server's tools can have, known from its config before it connects. */
function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
	return new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})]);
}

/** Whether some of the server's tools are declared to the model, so the first prompt waits for them. */
function hasDirectTools(entry: McpServerEntry, selections?: readonly string[], toolNames?: readonly string[]): boolean {
	const namespacePrefix = `${mcpNamespace(entry.name)}__`;
	return (
		(selections !== undefined && hasSelectedMcpServer(selections, entry.name)) ||
		toolNames?.some((name) => name.startsWith(namespacePrefix)) === true ||
		configuredExposures(entry).has("direct")
	);
}

/** Whether some of the server's tools are reached through codemode or tool_search. */
function hasIndirectTools(entry: McpServerEntry): boolean {
	const exposures = configuredExposures(entry);
	return exposures.has("codemode") || exposures.has("deferred");
}

/** Name of the system prompt section that lists the servers whose tools are not declared. */
export const MCP_SERVERS_SECTION = "mcp_servers";
/** Characters of a server description in the section, as Codex allows for deferred namespaces. */
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/**
 * Characters of the whole section. Descriptions shrink to fit; when the server lines alone do not
 * fit, the last servers are left out and counted in a closing line.
 */
export const MAX_SERVERS_SECTION_CHARS = 4096;

/** The section's first line. It explains only the ways of reaching tools that the listed servers use. */
function serversSectionIntro(reaches: ReadonlySet<string>): string {
	let intro = "MCP servers whose tools are not declared to you.";
	if (reaches.has("codemode")) intro += " Call the tools of `codemode` servers from codemode scripts.";
	if (reaches.has("tool_search")) intro += " Load the tools of `tool_search` servers with `tool_search`.";
	return intro;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${sliceHead(text, max - 1).trimEnd()}…`;
}

/** What the `mcp_servers` section needs of a server. */
export interface McpServerListing {
	entry: McpServerEntry;
	connection?: { instructions?: string };
	/** The summary the session recorded for the server, shown instead of its instructions while it reconnects. */
	recordedSummary?: string;
	/** The recorded summary is the ellipsis of a longer one, so with room for one character it shows none. */
	recordedSummaryCut?: boolean;
}

/** First line of the configured description, or of the server instructions once connected. */
function serverSummary(server: McpServerListing): string {
	const text = server.entry.config.description?.trim() || server.connection?.instructions || "";
	return (text.split("\n", 1)[0] ?? "").trim();
}

/**
 * The summary a server's line shows with room for `room` characters: its configured description, else its recorded
 * summary while it reconnects (none with room for one character when the record is a cut summary's ellipsis), else
 * the first line of its instructions.
 */
function shownSummary(server: McpServerListing, room: number): string {
	if (server.entry.config.description?.trim() || server.recordedSummary === undefined) {
		return truncate(serverSummary(server), room);
	}
	return shownRecordedSummary(server.recordedSummary, server.recordedSummaryCut === true, room);
}

/** A recorded summary as a line with room for `room` characters shows it; see {@link shownSummary}. */
function shownRecordedSummary(summary: string, cut: boolean, room: number): string {
	return room === 1 && cut ? "" : truncate(summary, room);
}

/** A summary as a server's line shows it, whether it is only the ellipsis of a longer one, and the server shown. */
interface ShownSummary {
	summary: string;
	cut: boolean;
	identity: Required<McpServerIdentity>;
}

/** The section's text, and the summary it shows for each server whose line has room for one, as shown. */
interface ServersSection {
	text: string;
	summarized: { listing: McpServerListing; summary: string }[];
}

/**
 * The `mcp_servers` section: every enabled server with codemode or deferred tools, with how its
 * tools are reached and a one-line summary. The model learns of the servers from it, since neither
 * codemode nor tool_search lists them. Undefined when there are no such servers.
 */
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	return layOutServersSection(servers)?.text;
}

function layOutServersSection(servers: readonly McpServerListing[]): ServersSection | undefined {
	const listed = servers
		.filter((server) => isEnabled(server) && hasIndirectTools(server.entry))
		.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
	if (listed.length === 0) return undefined;
	const reaches = listed.map((server) =>
		configuredExposures(server.entry).has("codemode") ? "codemode" : "tool_search",
	);
	const intro = serversSectionIntro(new Set(reaches));
	const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`] : [];
	// Characters of the intro, the first `kept` server lines without descriptions, and the omission line.
	const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	// Each description also takes a ": " separator.
	const perServer = summaryRoom(intro, heads.slice(0, kept), omitted(listed.length - kept));
	const summarized =
		perServer > 0
			? listed.slice(0, kept).map((listing) => ({ listing, summary: shownSummary(listing, perServer) }))
			: [];
	const lines = listed
		.slice(0, kept)
		.map((_, index) => (summarized[index]?.summary ? `${heads[index]}: ${summarized[index].summary}` : heads[index]));
	return { text: [intro, ...lines, ...omitted(listed.length - kept)].join("\n"), summarized };
}

/** Room for a summary that each server line of a section with `intro`, these `heads` and `omitted` line had. */
function summaryRoom(intro: string, heads: readonly string[], omitted: readonly string[]): number {
	if (heads.length === 0) return 0;
	const size = [intro, ...heads, ...omitted].join("\n").length;
	return Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size) / heads.length) - 2);
}

/** A server line of the section: its head, the server's namespace, and the summary it shows. */
const SERVER_LINE = /^(- (\S+) \((?:codemode|tool_search)\))(?:: ([^\n]*))?$/;

/** What a section a request sent shows: the summary on each server's line, by namespace, and the room it had. */
interface SentServersSection {
	room: number;
	/** The summaries shown for a namespace, "" for a line without one; more than one when two servers share it. */
	summaries: Map<string, string[]>;
}

/** The section a request sent as `text`, with its tags; undefined when it is not one this extension wrote. */
function readSentServersSection(text: string | undefined): SentServersSection | undefined {
	const [intro, ...rest] = text?.split("\n").slice(1, -1) ?? [];
	if (intro === undefined) return undefined;
	const omitted = rest.at(-1)?.startsWith("- … ") ? [rest.at(-1)!] : [];
	const heads: string[] = [];
	const summaries = new Map<string, string[]>();
	for (const line of rest.slice(0, rest.length - omitted.length)) {
		const match = SERVER_LINE.exec(line);
		if (!match) return undefined;
		heads.push(match[1]!);
		summaries.set(match[2]!, [...(summaries.get(match[2]!) ?? []), match[3] ?? ""]);
	}
	return { room: summaryRoom(intro, heads, omitted), summaries };
}

/**
 * Whether the section a request sent last shows `record`'s summary on its server's line, as the line shows it with the
 * room it had. A record the conversation does not show, such as one whose replacement could not be written, is not
 * shown again after a resume; nor is one a line without a summary leaves unconfirmed.
 */
function showsRecordedSummary(section: SentServersSection | undefined, record: McpServerSummaryRecord): boolean {
	const shown = section?.summaries.get(mcpNamespace(record.server));
	if (!section || section.room <= 0 || shown?.length !== 1) return false;
	const expected = shownRecordedSummary(record.summary, record.cut === true, section.room);
	return expected !== "" && shown[0] === expected;
}

/**
 * Whether a codemode script needs the server: it names the server's namespace, or searches,
 * enumerates, or describes tools or namespaces, which may name the server in other forms.
 */
function scriptNeedsServer(code: string, server: string): boolean {
	if (/\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/.test(code)) return true;
	return code.includes(mcpNamespace(server));
}

/** Short state for lists and the startup report. `withError` appends the first line of a failure. */
function describeState(server: McpServer, withError = true): string {
	if (!isEnabled(server)) return "disabled";
	const connection = server.connection;
	if (!connection) return "starting";
	switch (connection.state) {
		case "needs-auth":
			return "needs sign-in";
		case "failed":
			return withError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed";
		case "connected": {
			const { tools, hasResources } = connection;
			return `connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}${hasResources ? " · resources" : ""}`;
		}
		case "connecting":
			return "connecting…";
		default:
			return connection.state;
	}
}

/** Servers that need the user first. */
function attentionRank(server: McpServer): number {
	if (!isEnabled(server)) return 5;
	switch (server.connection?.state) {
		case "needs-auth":
			return 0;
		case "failed":
			return 1;
		case "disconnected":
			return 2;
		case "connected":
			return 4;
		default:
			return 3;
	}
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	if ("url" in config) return config.url;
	return [config.command, ...(config.args ?? [])].join(" ");
}

const MCP_USAGE = "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let servers: McpServer[] = [];
		/** Servers from `mcp.json`, which take precedence over registered servers of the same name. */
		let configuredEntries: McpServerEntry[] = [];
		let configErrors: string[] = [];
		/** The trusted project's `mcp.json`, where `/mcp` saves project overrides of global servers. */
		let projectConfig: string | undefined;
		/** Registered servers that `mcp.json` overrides, shown in `/mcp`. */
		let overridden: string[] = [];
		let latestContext: ExtensionContext | undefined;
		let subagentMcpDirectTools: readonly string[] | undefined;
		let autoEnableCodemode = true;
		/** Whether the "codemode tools unreachable" warning was shown since the session started. */
		let warnedUnreachable = false;
		let pending: Promise<unknown> | undefined;
		/** Whether a prompt already waited for the startup connections since the session started. */
		let waitedForStartup = false;
		const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		/** Working directory of the session, for stdio servers. */
		let sessionCwd = process.cwd();
		let credentials = options.credentials;
		/** The session's model registry, which resolves `auth.provider` tokens. */
		let modelRegistry: ModelRegistry | undefined;
		let serverLog: McpServerLog | undefined;
		const openUrl = options.openUrl ?? openBrowser;
		const updateConfig =
			options.updateConfig ??
			((entry, patch) =>
				updateMcpServerConfigAsync(entry.override ?? entry.source, entry.name, patch, {
					override: entry.override !== undefined,
				}));

		/**
		 * Lifetime of the current session: aborted on session_shutdown, and before the first session_start
		 * (registrations before that are read on session_start). Work captures `session.signal` when it
		 * starts and drops late results once it aborted, for example a runtime load that resolves after
		 * shutdown. Work that outlives the command that started it also stops on the signal and is
		 * registered with `track`, so shutdown can wait for its cleanup.
		 */
		let session = new AbortController();
		session.abort();
		/** Work registered with `track`: manager actions opening or closing connections, and sign-ins. */
		const backgroundActions = new Set<Promise<void>>();
		const track = <T>(work: Promise<T>): Promise<T> => {
			const task = work.then(
				() => undefined,
				() => undefined,
			);
			backgroundActions.add(task);
			void task.finally(() => backgroundActions.delete(task));
			return work;
		};
		const listeners = new Set<() => void>();
		const emitChange = () => {
			for (const listener of listeners) listener();
		};
		const subscribe = (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		};

		const connections = () => servers.flatMap((server) => (server.connection ? [server.connection] : []));
		const findServer = (name: string) => servers.find((server) => server.entry.name === name);

		/** Servers extensions registered, except names `mcp.json` defines, which take precedence. */
		const registeredServers = (): { servers: McpServer[]; overridden: string[] } => {
			const registered: McpServer[] = [];
			const overriddenNames: string[] = [];
			const namespaceOwners = new Map<string, { name: string; origin: string }>();
			for (const contribution of pi.getMcpServerContributions?.() ?? []) {
				const { name, config, sourceInfo } = contribution;
				const source = sourceInfo.path;
				const hasProviderAuth =
					"url" in config && typeof config.auth === "object" && config.auth !== null && "provider" in config.auth;
				if (hasProviderAuth && (contribution.origin === "package" || sourceInfo.origin === "package")) {
					configErrors.push(
						`${source}: server "${name}": auth.provider is only allowed for explicit extension registrations`,
					);
					continue;
				}
				const configured = configuredEntries.find((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
				if (configured) {
					overriddenNames.push(
						`"${name}" registered by ${source} is overridden by "${configured.name}" in ${configured.source}`,
					);
					continue;
				}
				const namespace = mcpNamespace(name);
				const owner = namespaceOwners.get(namespace);
				if (owner) {
					overriddenNames.push(
						`"${name}" from ${contribution.origin} is ignored because its MCP namespace conflicts with "${owner.name}" from ${owner.origin}`,
					);
					continue;
				}
				namespaceOwners.set(namespace, { name, origin: contribution.origin });
				registered.push({
					entry: { name, config, source, scope: "extension" },
					registeredConfig: JSON.stringify(config),
				});
			}
			return { servers: registered, overridden: overriddenNames };
		};

		const getCredentials = (runtime: typeof McpRuntime): McpOAuthCredentialStore => {
			credentials ??= new runtime.McpOAuthCredentialStore();
			return credentials;
		};

		const getServerLog = (runtime: typeof McpRuntime): McpServerLog => {
			serverLog ??= new runtime.McpServerLog(options.logPath ?? join(getAgentDir(), "mcp.log"));
			return serverLog;
		};

		/** pi tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
		const toolOwners = new Map<string, string>();
		/** Tool names currently offered by each server. */
		const serverTools = new Map<string, Set<string>>();
		/** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
		const definitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();
		/** Each registered tool name's server and that server's latest listing of the tool. */
		const listedTools = new Map<string, { server: string; tool: McpTool }>();
		/**
		 * Tool names registered from the session's records (see tool-records.ts) that their server has not listed
		 * since the session started. They stay declared while the server connects; calls wait for it.
		 */
		const recordedOnly = new Set<string>();
		/** The latest records on the session's branch. */
		let toolRecords: McpToolRecords = { tools: new Map(), resourceServers: undefined, summaries: new Map() };
		/** Tool records being appended, by name, and the resource servers being appended, as JSON. */
		const recordingTools = new Map<string, McpToolRecord>();
		let recordingResources: string | undefined;
		/** MCP tool and resource tool names the session's transcript declares to the model now. */
		let declaredNames = new Set<string>();
		/**
		 * Servers that had resources when the session declared the resource tools and have not finished connecting
		 * since it started. The resource tools stay declared for them meanwhile.
		 */
		const pendingResourceServers = new Set<string>();
		/**
		 * Servers whose recorded summary the `mcp_servers` section shows: their record matched them when the session
		 * started (see recordMatchesServer), and their connection attempt has not settled since.
		 */
		const pendingSummaries = new Set<string>();
		/**
		 * Servers whose summary record on the current branch is what the section its conversation sent last shows of
		 * them (see showsRecordedSummary). Only these records are shown while their servers reconnect.
		 */
		let shownRecords = new Set<string>();
		const readShownRecords = (branch: readonly SessionEntry[]) => {
			const section =
				toolRecords.summaries.size > 0
					? readSentServersSection(latestSystemSection(branch, MCP_SERVERS_SECTION))
					: undefined;
			shownRecords = new Set(
				[...toolRecords.summaries.values()]
					.filter((record) => showsRecordedSummary(section, record))
					.map((record) => record.server),
			);
		};
		/**
		 * The `mcp_servers` section of the prompt being started and the options it was set in, with the summary its
		 * line shows from each server's instructions, and the servers whose line shows their recorded summary.
		 */
		let promptSection:
			| {
					options: BuildSystemPromptOptions;
					text: string | undefined;
					shown: Map<string, ShownSummary>;
					kept: Set<string>;
			  }
			| undefined;

		// Render resumed MCP calls even when their server has not connected or never connects.
		pi.registerToolRenderer((toolName, next) => {
			const registered = next();
			if (registered) return registered;
			if (!toolName.startsWith("mcp__")) return undefined;
			const owner = toolOwners.get(toolName);
			if (owner) return createMcpToolRenderers(owner.replace("\0", "/"));
			const encoded = toolName.slice("mcp__".length);
			const boundary = encoded.indexOf("__");
			const unambiguous =
				boundary > 0 &&
				boundary + 2 < encoded.length &&
				boundary === encoded.lastIndexOf("__") &&
				!/_[a-f0-9]{8}(?:_\d+)?$/.test(toolName);
			const label = unambiguous ? `${encoded.slice(0, boundary)}/${encoded.slice(boundary + 2)}` : toolName;
			return createMcpToolRenderers(label);
		});

		/** Exposure of one of a server's tools, from its config and the subagent policy. */
		const exposureFor = (entry: McpServerEntry, tool: string, name: string): McpExposure => {
			const server = entry.name;
			const configuredExposure = getMcpToolExposure(entry.config, tool);
			const selected =
				(subagentMcpDirectTools !== undefined &&
					matchesMcpDirectToolSelection(subagentMcpDirectTools, server, tool)) ||
				(latestContext?.subagentPolicy?.tools?.includes(name) ?? false);
			return selected && configuredExposure !== "hidden" && exposureOf(entry) !== "hidden"
				? "direct"
				: subagentMcpDirectTools === undefined && !latestContext?.subagentPolicy?.tools
					? configuredExposure
					: "hidden";
		};

		/**
		 * The definition of a server's tool. `recorded` marks a definition built from the session's record before the
		 * server listed the tool: a call to it runs only once the server lists the same tool under the same name.
		 */
		const defineTool = (
			entry: McpServerEntry,
			tool: McpTool,
			name: string,
			instructions: string | undefined,
			recorded?: McpTool,
		): ToolDefinition<TSchema, McpToolDetails> => {
			const server = entry.name;
			const description = entry.config.description?.trim();
			const definition = createMcpToolDefinition({
				server,
				tool,
				name,
				exposure: exposureFor(entry, tool.name, name),
				namespace: {
					name: mcpNamespace(server),
					...(description ? { description } : {}),
					...(instructions ? { instructions } : {}),
				},
				timeoutMs: mcpRequestTimeoutMs(entry.config),
				getClient: async () => {
					const current = findServer(server);
					if (!current || !isEnabled(current)) throw new Error(`MCP server "${server}" is disabled.`);
					const client = current.connection;
					if (!client) throw new Error(`MCP server "${server}" is still starting.`);
					if (recorded) {
						// The call waited for the server's connection attempt (tool_call below). Run it only against the
						// tool the session declared: the server must list it again, unchanged, under this name.
						const listed = listedTools.get(name);
						if (!listed || listed.server !== server) {
							throw new Error(
								client.state === "connected" || client.state === "disconnected"
									? `MCP tool "${server}/${tool.name}" is no longer available.`
									: `MCP server "${server}" did not reconnect (${describeState(current, false)}), so its tool "${tool.name}" is not available.`,
							);
						}
						if (!sameListedTool(listed.tool, recorded)) {
							throw new Error(
								`MCP tool "${server}/${tool.name}" changed since this session declared it, so the call did not run. Its new definition is declared with the next request.`,
							);
						}
					}
					if (
						getMcpToolExposure(current.entry.config, tool.name) === "hidden" ||
						(client.state === "connected" && !client.tools.some((offered) => offered.name === tool.name))
					) {
						throw new Error(`MCP tool "${server}/${tool.name}" is no longer available.`);
					}
					return client;
				},
				readableResources: () => resourceServers().some((current) => current.name === server),
			});
			markNativeMcpToolDefinition(definition, { server, tool: tool.name });
			return definition;
		};

		/** Re-register a tool as hidden, which takes it out of the declared tools. */
		const withdrawTool = (name: string) => {
			const definition = definitions.get(name);
			if (definition) pi.registerTool({ ...definition, exposure: "hidden" });
			listedTools.delete(name);
			recordedOnly.delete(name);
		};

		const registerTools = (connection: McpServerConnection) => {
			if (!servers.some((candidate) => candidate.connection === connection)) return;
			const server = connection.entry.name;
			const entry = findServer(server)?.entry ?? connection.entry;
			const previous = serverTools.get(server) ?? new Set<string>();
			const current = new Set<string>();
			// The connection's instructions replace the recorded summary.
			pendingSummaries.delete(server);
			// Like Codex, all tools whose names sanitize to the same name get the hash suffix, so which
			// one would keep the plain name does not depend on the order of the list.
			const plain = [...new Set(connection.tools.map((tool) => tool.name))].map((tool) =>
				createMcpToolName(server, tool),
			);
			const assignName = (tool: string, owner: string) => {
				const name = createMcpToolName(server, tool, (candidate) => {
					const existing = toolOwners.get(candidate);
					return (
						(existing !== undefined && existing !== owner) ||
						current.has(candidate) ||
						plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
					);
				});
				toolOwners.set(name, owner);
				current.add(name);
				return name;
			};
			// Register in the order of the tool names, not the server's listing, so the order the tools are declared
			// in does not depend on how the server happens to list them.
			const listing = [...connection.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			for (const tool of listing) {
				const name = assignName(tool.name, `${server}\0${tool.name}`);
				const definition = defineTool(entry, tool, name, connection.instructions);
				definitions.set(definition.name, definition);
				listedTools.set(name, { server, tool });
				recordedOnly.delete(name);
				pi.registerTool(definition);
			}
			serverTools.set(server, current);
			// Tools cannot be unregistered, so tools the server dropped are re-registered as hidden. When
			// the server offers them again they are registered with their configured exposure above.
			for (const name of previous) if (!current.has(name)) withdrawTool(name);
			syncResourceTools();
			void recordDeclaredTools();
		};

		/** Make a disabled server's tools unreachable. */
		const hideTools = (server: string) => {
			pendingSummaries.delete(server);
			for (const name of serverTools.get(server) ?? []) withdrawTool(name);
			serverTools.set(server, new Set());
			syncResourceTools();
		};

		/**
		 * Record the server's listing of each MCP tool the transcript declares, when it changed since the last record
		 * on the branch, so a resumed session can keep declaring the tool while the server reconnects.
		 */
		const recordDeclaredTools = async (): Promise<void> => {
			const records = toolRecords;
			const tools: McpToolRecord[] = [];
			for (const name of [...declaredNames].sort()) {
				const listed = listedTools.get(name);
				const entry = listed && findServer(listed.server)?.entry;
				if (!listed || !entry || recordedOnly.has(name)) continue;
				const record: McpToolRecord = {
					name,
					server: listed.server,
					...serverIdentity(entry),
					tool: recordableTool(listed.tool),
				};
				const known = [records.tools.get(name), recordingTools.get(name)];
				if (known.some((previous) => previous && sameToolRecord(previous, record))) continue;
				recordingTools.set(name, record);
				tools.push(record);
			}
			let resourceServers: McpResourceServerRecord[] | undefined;
			if (pendingResourceServers.size === 0 && [...RESOURCE_TOOL_NAMES].some((name) => declaredNames.has(name))) {
				const current = serversWithResources()
					.map((server) => ({ server: server.entry.name, ...serverIdentity(server.entry) }))
					.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
				const json = JSON.stringify(current);
				const known = [JSON.stringify(records.resourceServers), recordingResources];
				if (current.length > 0 && !known.includes(json)) {
					recordingResources = json;
					resourceServers = current;
				}
			}
			if (tools.length === 0 && !resourceServers) return;
			const settled = () => {
				for (const record of tools)
					if (recordingTools.get(record.name) === record) recordingTools.delete(record.name);
				if (resourceServers && recordingResources === JSON.stringify(resourceServers))
					recordingResources = undefined;
			};
			// The records count once they are stored; a failed write is tried again with the next change.
			try {
				await pi.appendEntry<McpToolRecordData>(MCP_TOOL_RECORD_ENTRY_TYPE, {
					tools,
					...(resourceServers ? { resourceServers } : {}),
				});
				if (toolRecords === records) {
					for (const record of tools) records.tools.set(record.name, record);
					if (resourceServers) records.resourceServers = resourceServers;
				}
			} catch {
				// Without the record, a later resume treats these tools as before: removed until their server connects.
			} finally {
				settled();
			}
		};

		/**
		 * On session start, register the tools the transcript declares from their records, for servers that are still
		 * configured with the same URL or command, so the first requests keep declaring them while the servers
		 * connect. A server that connects lists its tools again and they replace these definitions; the ones of a
		 * server that does not connect are withdrawn once its attempt settles.
		 */
		const restoreRecordedTools = (ctx: ExtensionContext) => {
			const branch = ctx.sessionManager.getBranch();
			toolRecords = readToolRecords(branch);
			declaredNames = declaredMcpToolNames(branch);
			// Recorded names stay their servers', as in the session that recorded them: a server that connects first
			// cannot take another server's name, and a call to a declared tool waits for its server. A name a tool had
			// before it was declared under another one is left free.
			const owner = (record: McpToolRecord) => `${record.server}\0${record.tool.name}`;
			const declaredOwners = new Set<string>();
			for (const name of declaredNames) {
				const record = toolRecords.tools.get(name);
				if (!record) continue;
				toolOwners.set(name, owner(record));
				declaredOwners.add(owner(record));
			}
			for (const record of toolRecords.tools.values()) {
				if (!toolOwners.has(record.name) && !declaredOwners.has(owner(record))) {
					toolOwners.set(record.name, owner(record));
				}
			}
			for (const name of declaredNames) {
				const record = toolRecords.tools.get(name);
				if (!record) continue;
				const server = findServer(record.server);
				if (!server || !isEnabled(server) || !recordMatchesServer(server.entry, record)) continue;
				if (exposureFor(server.entry, record.tool.name, name) === "hidden") continue;
				const definition = defineTool(server.entry, record.tool, name, undefined, record.tool);
				definitions.set(name, definition);
				recordedOnly.add(name);
				const names = serverTools.get(record.server) ?? new Set<string>();
				names.add(name);
				serverTools.set(record.server, names);
				pi.registerTool(definition);
			}
			// The resource tools stay declared while a server that had resources reconnects.
			if ([...RESOURCE_TOOL_NAMES].some((name) => declaredNames.has(name))) {
				for (const record of toolRecords.resourceServers ?? []) {
					const server = findServer(record.server);
					if (server && isEnabled(server) && recordMatchesServer(server.entry, record)) {
						pendingResourceServers.add(record.server);
					}
				}
				syncResourceTools();
			}
			// The `mcp_servers` section shows a server's recorded summary while the server reconnects.
			readShownRecords(branch);
			for (const record of toolRecords.summaries.values()) {
				const server = findServer(record.server);
				if (server && isEnabled(server) && recordMatchesServer(server.entry, record))
					pendingSummaries.add(record.server);
			}
		};

		/** The summary record of a server whose connection attempt has not settled since the session started. */
		const pendingSummary = (server: McpServer): McpServerSummaryRecord | undefined => {
			const name = server.entry.name;
			const record =
				pendingSummaries.has(name) && shownRecords.has(name) ? toolRecords.summaries.get(name) : undefined;
			return record && recordMatchesServer(server.entry, record) ? record : undefined;
		};

		/**
		 * The records that make the branch's summary records say what the conversation shows of each server once the
		 * prompt was sent: the summary its line shows from the server's instructions, or none (for a server with a
		 * configured description, no room for a summary, no line, or no longer configured). A missing record counts as
		 * no summary, and a line that shows a server's recorded summary keeps its record.
		 */
		const summaryUpdates = (
			shown: ReadonlyMap<string, ShownSummary>,
			kept: ReadonlySet<string>,
		): McpServerSummaryRecord[] => {
			const updates: McpServerSummaryRecord[] = [];
			for (const name of new Set([...shown.keys(), ...toolRecords.summaries.keys()])) {
				if (kept.has(name)) continue;
				const line = shown.get(name);
				const record = toolRecords.summaries.get(name);
				if (line?.summary) {
					// Recorded for the server the line was rendered for, which may have been replaced since.
					const { summary, cut, identity } = line;
					if (
						!record ||
						record.summary !== summary ||
						(record.cut ?? false) !== cut ||
						record.transport !== identity.transport ||
						record.scope !== identity.scope
					) {
						updates.push({ server: name, ...identity, summary, ...(cut ? { cut: true as const } : {}) });
					}
				} else if (record?.summary) {
					updates.push({ server: name, transport: record.transport, scope: record.scope ?? null, summary: "" });
				}
			}
			return updates;
		};

		/** Append summary records; a failed write is tried again with the next prompt, which finds them changed still. */
		const recordSummaries = async (summaries: McpServerSummaryRecord[]): Promise<void> => {
			const records = toolRecords;
			try {
				await pi.appendEntry<McpToolRecordData>(MCP_TOOL_RECORD_ENTRY_TYPE, { tools: [], summaries });
				if (toolRecords === records) {
					for (const record of summaries) {
						if (record.summary) records.summaries.set(record.server, record);
						else records.summaries.delete(record.server);
					}
				}
			} catch {
				// Without the record, a later resume shows the server without a summary until it connects, as before.
			}
		};

		/** Withdraw the recorded tools of a server whose connection attempt settled without listing them. */
		const withdrawUnlistedRecords = (server: string) => {
			for (const name of serverTools.get(server) ?? []) {
				if (!recordedOnly.has(name)) continue;
				withdrawTool(name);
				serverTools.get(server)?.delete(name);
			}
		};

		/** Enabled servers with resources whose exposure is not `hidden`, which the resource tools reach. */
		const serversWithResources = (): McpServer[] =>
			servers.filter(
				(server) => server.connection?.hasResources && isEnabled(server) && exposureOf(server.entry) !== "hidden",
			);
		const resourceServers = (): McpServerConnection[] =>
			serversWithResources().flatMap((server) => (server.connection ? [server.connection] : []));

		/** Exposure the resource tools were last registered with; undefined until a server has resources. */
		let resourceToolsExposure: McpExposure | undefined;
		/**
		 * Register the resource tools with the widest exposure of the servers they reach: `direct` when
		 * one of them is direct, and so on. They are hidden when no server has resources.
		 */
		const syncResourceTools = () => {
			const exposures = new Set(serversWithResources().map((server) => exposureOf(server.entry)));
			for (const name of pendingResourceServers) {
				const server = findServer(name);
				if (server && isEnabled(server) && exposureOf(server.entry) !== "hidden")
					exposures.add(exposureOf(server.entry));
			}
			const exposure = (["direct", "codemode", "deferred"] as const).find((candidate) => exposures.has(candidate));
			const next = exposure ?? "hidden";
			if (next === resourceToolsExposure || (resourceToolsExposure === undefined && next === "hidden")) return;
			const wasDirect = resourceToolsExposure === "direct";
			resourceToolsExposure = next;
			const resourceDefinitions = createMcpResourceToolDefinitions({ exposure: next, servers: resourceServers });
			for (const definition of resourceDefinitions) pi.registerTool(definition);
			// Hidden tools leave the declared tools when they are registered; only other exposures need this.
			if (wasDirect && next !== "hidden") {
				const names = new Set(resourceDefinitions.map((definition) => definition.name));
				pi.setActiveTools(pi.getActiveTools().filter((name) => !names.has(name)));
			}
		};

		/**
		 * Tools that are not declared to the model are reached through the codemode tool (scripts call
		 * them) or the tool_search tool (it declares them). Either reaches every such tool. Activate the
		 * one the tools' exposure asks for: codemode for `codemode` unless `autoEnableCodemode` is false,
		 * tool_search for `deferred`.
		 */
		const ensureDiscoveryActive = (ctx: ExtensionContext) => {
			// From the config, so the tool is active before the servers connect. Resource tools share
			// their server's exposure.
			const exposures = new Set<McpExposure>();
			for (const server of servers) {
				if (isEnabled(server)) for (const exposure of configuredExposures(server.entry)) exposures.add(exposure);
			}
			const needsCodemode = exposures.has("codemode");
			const needsToolSearch = exposures.has("deferred");
			if (!needsCodemode && !needsToolSearch) return;
			// Other extensions' tools of the same names cannot reach MCP tools, so never activate them.
			const tools = pi.getAllTools();
			const codemode = tools.find(isCodemodeDiscoveryTool);
			const hasCodemode = codemode !== undefined;
			const hasToolSearch = tools.some(isToolSearchDiscoveryTool);
			const active = pi.getActiveTools();
			const activate: string[] = [];
			if (
				needsCodemode &&
				codemode &&
				!codemode.explicitDefaultOptOut &&
				autoEnableCodemode &&
				!active.includes(CODEMODE_TOOL_NAME)
			) {
				activate.push(CODEMODE_TOOL_NAME);
			}
			if (needsToolSearch && hasToolSearch && !active.includes(TOOL_SEARCH_TOOL_NAME)) {
				activate.push(TOOL_SEARCH_TOOL_NAME);
			}
			if (activate.length > 0) pi.setActiveTools([...active, ...activate]);
			const reachable = [...active, ...activate];
			if (hasCodemode && reachable.includes(CODEMODE_TOOL_NAME)) return;
			if (hasToolSearch && reachable.includes(TOOL_SEARCH_TOOL_NAME)) return;
			if (warnedUnreachable) return;
			warnedUnreachable = true;
			const reason =
				needsCodemode && codemode?.explicitDefaultOptOut
					? " (-codemode removed it from the tool selection)"
					: needsCodemode && hasCodemode && !autoEnableCodemode
						? " (autoEnableCodemode is false)"
						: "";
			ctx.ui.notify(
				`MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
				"warning",
			);
		};

		/**
		 * Stored tokens of servers waiting for a sign-in, as they were when the sign-in was needed.
		 * `pi mcp login` in another process (for example run by the agent) changes them.
		 */
		const tokensAtSignIn = new Map<McpServerConnection, Promise<string>>();
		const storedTokens = async (connection: McpServerConnection): Promise<string> => {
			const url = connection.oauthUrl;
			return url && credentials
				? JSON.stringify((await credentials.tokensAsync(connection.name, url)) ?? null)
				: "null";
		};
		const onConnectionChange = (connection: McpServerConnection) => {
			if (connection.state !== "needs-auth") tokensAtSignIn.delete(connection);
			else if (!tokensAtSignIn.has(connection)) {
				const tokens = storedTokens(connection);
				tokens.catch(() => {});
				tokensAtSignIn.set(connection, tokens);
			}
			emitChange();
		};
		/** Reconnect servers that need a sign-in when their credentials were stored since. */
		const reconnectSignedIn = async (ctx: ExtensionContext) => {
			const compared = await Promise.all(
				[...tokensAtSignIn].map(async ([connection, tokens]) => ({
					connection,
					tokens,
					changed: (await storedTokens(connection)) !== (await tokens),
				})),
			);
			const signedIn = compared.filter(({ changed }) => changed);
			if (signedIn.length === 0) return;
			for (const { connection, tokens } of signedIn) {
				if (tokensAtSignIn.get(connection) === tokens) tokensAtSignIn.delete(connection);
			}
			await Promise.allSettled(signedIn.map(({ connection }) => connection.reconnect()));
			ensureDiscoveryActive(ctx);
		};

		/** Create the server's connection, loading the MCP runtime on first use. */
		const createConnection = async (
			server: McpServer,
			isCurrent: () => boolean,
		): Promise<McpServerConnection | undefined> => {
			if (!isCurrent()) return;
			const runtime = await loadMcpRuntime();
			if (!isCurrent()) return;
			const connection = new runtime.McpServerConnection({
				entry: server.entry,
				cwd: sessionCwd,
				createTransport: options.createTransport ?? runtime.createDefaultTransport,
				credentials: getCredentials(runtime),
				providerToken: async (provider) => modelRegistry?.getApiKeyForProvider(provider),
				log: getServerLog(runtime),
				onTools: (connection) => {
					if (isCurrent()) registerTools(connection);
				},
				onChange: (connection) => {
					if (isCurrent()) onConnectionChange(connection);
					else tokensAtSignIn.delete(connection);
				},
			});
			server.connection = connection;
			emitChange();
			return connection;
		};

		const startConnection = (server: McpServer, after?: Promise<unknown>): Promise<void> => {
			const { signal } = session;
			const attempt = Symbol();
			server.attempt = attempt;
			const isCurrent = () =>
				!signal.aborted && server.attempt === attempt && isEnabled(server) && servers.includes(server);
			const ready = (async () => {
				try {
					await after;
					if (!isCurrent()) return;
					const connection = await createConnection(server, isCurrent);
					if (!connection || !isCurrent()) return;
					await connection.getClient().catch(() => undefined);
				} finally {
					if (isCurrent()) {
						withdrawUnlistedRecords(server.entry.name);
						if (pendingResourceServers.delete(server.entry.name)) syncResourceTools();
						// A server that did not connect shows no summary, as when it never connected.
						pendingSummaries.delete(server.entry.name);
					}
				}
			})();
			server.ready = ready.catch(() => undefined);
			return ready;
		};

		const waitForServers = async (waiting: readonly McpServer[], signal: AbortSignal | undefined) => {
			for (;;) {
				const ready = waiting.flatMap((server) =>
					isEnabled(server) && servers.includes(server) && server.ready ? [{ server, ready: server.ready }] : [],
				);
				if (ready.length === 0 || signal?.aborted) return;
				let onAbort: (() => void) | undefined;
				await Promise.race([
					Promise.all(ready.map((attempt) => attempt.ready)),
					new Promise<void>((resolve) => {
						onAbort = () => resolve();
						signal?.addEventListener("abort", onAbort, { once: true });
					}),
				]);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				if (
					signal?.aborted ||
					ready.every(
						(attempt) =>
							!isEnabled(attempt.server) ||
							!servers.includes(attempt.server) ||
							attempt.ready === attempt.server.ready,
					)
				)
					return;
			}
		};

		/**
		 * One message for everything that needs the user after startup, or only for `only`, servers
		 * that connected later.
		 */
		const reportProblems = (ctx: ExtensionContext, only?: readonly McpServer[]) => {
			const lines = only ? [] : configErrors.map((error) => `config: ${error}`);
			for (const server of only ?? servers) {
				const state = server.connection?.state;
				if (state === "needs-auth" || state === "failed")
					lines.push(`${server.entry.name}: ${describeState(server)}`);
			}
			if (lines.length === 0) return;
			ctx.ui.notify(
				`MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
				"warning",
			);
		};

		/**
		 * Save a config change; returns an error message when the file could not be updated. Changes to
		 * registered servers only apply to the current session. `inProject` adds a project override.
		 */
		const saveConfig = async (
			server: McpServer,
			patch: McpServerConfigPatch,
			inProject = false,
		): Promise<string | undefined> => {
			const override = inProject ? projectConfig : server.entry.override;
			const entry = override ? { ...server.entry, override } : server.entry;
			if (entry.scope !== "extension") {
				try {
					await updateConfig(entry, patch);
				} catch (error) {
					return `Could not update ${entry.override ?? entry.source}: ${errorMessage(error)}`;
				}
			}
			server.entry = { ...entry, config: { ...entry.config, ...patch } };
			return undefined;
		};

		/** Sign in, then reconnect. Returns an error message on failure. `cancel` or the session's end stops the sign-in. */
		const signIn = async (
			server: McpServer,
			prompt: McpSignInPrompt,
			cancel?: AbortSignal,
		): Promise<string | undefined> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return `MCP server "${server.entry.name}" does not use OAuth.`;
			const runtime = await loadMcpRuntime();
			const signal = cancel ? AbortSignal.any([session.signal, cancel]) : session.signal;
			try {
				await track(
					runtime.signInMcpServer({
						serverUrl: url,
						store: getCredentials(runtime).forServer(server.entry.name, url),
						settings: await connection.oauthSettings(),
						challenge: connection.challenge,
						prompt,
						signal,
					}),
				);
			} catch (error) {
				if (error instanceof runtime.McpSignInCancelledError) return "Sign-in cancelled.";
				return `Sign-in failed: ${errorMessage(error)}`;
			}
			// The challenge that asked for this sign-in (for example for more scope) is answered.
			connection.challenge = undefined;
			try {
				await connection.reconnect();
			} catch (error) {
				return `Signed in, but ${errorMessage(error)}`;
			}
			return undefined;
		};

		const signOut = async (server: McpServer): Promise<boolean> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return false;
			const removed = await getCredentials(await loadMcpRuntime()).removeAsync(server.entry.name, url);
			await connection.signOut();
			return removed;
		};

		const reconnect = async (server: McpServer): Promise<string | undefined> => {
			const connection = server.connection;
			if (!connection) return `MCP server "${server.entry.name}" is disabled.`;
			const previous = server.ready;
			const ready = (async () => {
				await previous;
				await connection.reconnect();
			})();
			server.ready = ready.catch(() => undefined);
			try {
				await ready;
				return undefined;
			} catch (error) {
				return errorMessage(error);
			}
		};

		/** Returns an error message when the config could not be saved; connection errors show in the state. */
		const setEnabled = async (
			server: McpServer,
			enabled: boolean,
			inProject = false,
		): Promise<string | undefined> => {
			const failed = await saveConfig(server, { enabled }, inProject);
			if (failed) return failed;
			if (!enabled) {
				const connection = server.connection;
				server.attempt = undefined;
				server.connection = undefined;
				if (connection) {
					server.closing = connection.close();
				}
				const closing = server.closing;
				hideTools(server.entry.name);
				emitChange();
				try {
					await closing;
				} finally {
					if (server.closing === closing) server.closing = undefined;
				}
				return undefined;
			}
			await startConnection(server, server.closing);
			return undefined;
		};

		const setExposure = async (server: McpServer, exposure: McpExposure): Promise<string | undefined> => {
			const failed = await saveConfig(server, { exposure });
			if (failed) return failed;
			if (server.connection?.state === "connected") registerTools(server.connection);
			syncResourceTools();
			// Tools no longer exposed directly leave the declared set; direct tools are activated on registration.
			const indirect = new Set(
				pi
					.getAllTools()
					.filter((tool) => tool.exposure !== "direct")
					.map((tool) => tool.name),
			);
			const tools = serverTools.get(server.entry.name) ?? new Set<string>();
			pi.setActiveTools(pi.getActiveTools().filter((name) => !tools.has(name) || !indirect.has(name)));
			emitChange();
			return undefined;
		};

		// ---------------------------------------------------------------------------------------
		// Manager (`/mcp` in the TUI)
		// ---------------------------------------------------------------------------------------

		const notices = () => [
			...configErrors.map((error) => `config: ${error}`),
			...overridden.map((line) => `overridden: ${line}`),
		];

		const serversMenu = (): McpMenu => ({
			title: "MCP servers",
			error: notices().join("\n") || undefined,
			items: [...servers]
				.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
				.map((server) => ({
					value: server.entry.name,
					label: server.entry.name,
					description: `${describeState(server)} · ${exposureOf(server.entry)} · ${server.entry.override ? "global, project override" : (server.entry.scope ?? server.entry.source)}`,
				})),
			empty: `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or ${CONFIG_DIR_NAME}/mcp.json.`,
			confirmLabel: "manage",
			cancelLabel: "close",
		});

		const serverMenu = (name: string): McpMenu => {
			const server = findServer(name);
			if (!server) {
				return {
					title: name,
					items: [],
					empty: "This server is no longer configured.",
					confirmLabel: "",
					cancelLabel: "back",
				};
			}
			const { entry, connection } = server;
			const saved =
				entry.scope === "extension"
					? "for this session"
					: entry.override
						? "saved to the project mcp.json"
						: entry.scope
							? `saved to the ${entry.scope} mcp.json`
							: "saved to mcp.json";
			// Global servers without an override can be turned on or off for the trusted project alone.
			const inProject = entry.scope === "global" && !entry.override && projectConfig !== undefined;
			const inProjectSaved = "saved to the project mcp.json";
			const items: SelectItem[] = [];
			if (!isEnabled(server)) {
				items.push({ value: "enable", label: "Enable", description: saved });
				if (inProject) {
					items.push({ value: "enable-project", label: "Enable in this project", description: inProjectSaved });
				}
			} else {
				const state = connection?.state;
				if (state === "needs-auth")
					items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
				if (state === "connected" && connection) {
					items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
				}
				if (state === "failed" || state === "disconnected" || state === "connected" || state === "needs-auth") {
					items.push({ value: "reconnect", label: "Reconnect" });
				}
				if (state === "connected" && connection?.oauthUrl) {
					items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
				}
				items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
				items.push({ value: "disable", label: "Disable", description: saved });
				if (inProject) {
					items.push({ value: "disable-project", label: "Disable in this project", description: inProjectSaved });
				}
			}
			const details = [
				describeTransport(entry),
				`${entry.scope ?? "config"}: ${entry.source}`,
				...(entry.override ? [`project override: ${entry.override}`] : []),
				`State: ${describeState(server, false)}`,
			];
			const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			return {
				title: `MCP server ${name}`,
				details: details.join("\n"),
				error: error || undefined,
				items,
				selected: items[0]?.value,
				confirmLabel: "select",
				cancelLabel: "back",
			};
		};

		const showTools = async (ui: McpUi, server: McpServer) => {
			const exposure = exposureOf(server.entry);
			const overridden = Object.keys(server.entry.config.toolExposure ?? {}).length > 0;
			await ui.menu(() => ({
				title: `Tools of ${server.entry.name}`,
				details: `Exposure ${exposure}: ${exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure]}${overridden ? "\nSome tools override it with toolExposure." : ""}`,
				items: (server.connection?.tools ?? []).map((tool) => {
					const toolExposure = getMcpToolExposure(server.entry.config, tool.name);
					const description = firstLine(tool.description ?? "");
					return {
						value: tool.name,
						label: tool.name,
						description: toolExposure === exposure ? description : `[${toolExposure}] ${description}`,
					};
				}),
				empty: "The server offers no tools.",
				confirmLabel: "back",
				cancelLabel: "back",
			}));
		};

		const chooseExposure = async (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const current = exposureOf(server.entry);
			const choice = await ui.menu(() => ({
				title: `Exposure of ${server.entry.name}`,
				details:
					server.entry.scope === "extension"
						? `Applies to this session; the server is registered by ${server.entry.source}.`
						: `Saved to ${server.entry.override ?? server.entry.source}.`,
				items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
					value: exposure,
					label: `${exposure === current ? "✓ " : "  "}${exposure}`,
					description: EXPOSURE_DESCRIPTIONS[exposure],
				})),
				selected: current,
				confirmLabel: "save",
				cancelLabel: "back",
			}));
			if (!choice || choice === current) return undefined;
			return setExposure(server, choice as McpExposure);
		};

		const signInWithUi = (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const title = `Sign in to ${server.entry.name}`;
			const cancel = new AbortController();
			const status = (message: string) => ui.status(title, message, () => cancel.abort());
			let authorizationUrl = "";
			status("Contacting the authorization server…");
			return signIn(
				server,
				{
					showAuthorizationUrl: (url) => {
						authorizationUrl = url.href;
						openUrl(url.href);
					},
					promptForRedirectUrl: async (signal) => {
						const value = await ui.redirectUrl(title, authorizationUrl, signal);
						status("Connecting…");
						return value;
					},
				},
				cancel.signal,
			);
		};

		const runInBackground = (
			ctx: ExtensionContext,
			server: McpServer,
			operation: () => Promise<string | undefined>,
		) => {
			const ready = operation();
			const attempt = server.attempt;
			const { signal } = session;
			const finish = (message: string | undefined) => {
				if (signal.aborted || server.attempt !== attempt || !servers.includes(server)) return;
				server.message = message;
				ensureDiscoveryActive(ctx);
				emitChange();
			};
			void track(ready.then(finish, (error) => finish(errorMessage(error))));
		};

		const runAction = async (ui: McpUi, ctx: ExtensionContext, server: McpServer, action: string) => {
			const { signal } = session;
			let message: string | undefined;
			switch (action) {
				case "signin":
					message = await signInWithUi(ui, server);
					break;
				case "reconnect":
					runInBackground(ctx, server, async () => {
						await reconnect(server);
						return undefined;
					});
					break;
				case "signout":
					await signOut(server);
					break;
				case "tools":
					await showTools(ui, server);
					break;
				case "exposure":
					message = await chooseExposure(ui, server);
					break;
				case "enable":
				case "disable":
				case "enable-project":
				case "disable-project": {
					const enable = action.startsWith("enable");
					runInBackground(ctx, server, () => setEnabled(server, enable, action.endsWith("-project")));
					break;
				}
			}
			// The session ended meanwhile (for example during a sign-in), which made ctx stale.
			if (signal.aborted) return;
			server.message = message;
			ensureDiscoveryActive(ctx);
			emitChange();
		};
		const manage = async (ui: McpUi, ctx: ExtensionContext) => {
			for (;;) {
				const name = await ui.menu(serversMenu, subscribe);
				if (!name) return;
				for (;;) {
					const action = await ui.menu(() => serverMenu(name), subscribe);
					const server = findServer(name);
					if (!action || !server) break;
					await runAction(ui, ctx, server, action);
				}
			}
		};

		// ---------------------------------------------------------------------------------------
		// Subcommands and plain status (no TUI)
		// ---------------------------------------------------------------------------------------

		const formatStatus = (): string => {
			if (servers.length === 0 && configErrors.length === 0 && overridden.length === 0) {
				return `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or ${CONFIG_DIR_NAME}/mcp.json.`;
			}
			const lines = servers.map((server) => {
				const { name } = server.entry;
				const exposure = exposureOf(server.entry);
				const connection = server.connection;
				if (connection?.state === "needs-auth")
					return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
				const tools = connection?.state === "connected" ? `, ${connection.tools.length} tools` : "";
				const state = !isEnabled(server)
					? "disabled"
					: connection?.state === "disconnected"
						? "disconnected, reconnects on next call"
						: (connection?.state ?? "starting");
				const error =
					connection?.error && connection.state !== "connected"
						? `\n    ${connection.error.split("\n").join("\n    ")}`
						: "";
				return `${name}: ${state}${tools} (${exposure})${error}`;
			});
			for (const error of configErrors) lines.push(`config error: ${error}`);
			for (const line of overridden) lines.push(`overridden: ${line}`);
			return lines.join("\n");
		};

		/** Resolve the server for a subcommand, asking when the name is omitted and ambiguous. */
		const pickServer = async (
			name: string | undefined,
			ctx: ExtensionCommandContext,
			options: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
		): Promise<McpServer | undefined> => {
			if (name) {
				const server = findServer(name);
				if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
				else if (!options.eligible(server)) ctx.ui.notify(options.none, "error");
				return server && options.eligible(server) ? server : undefined;
			}
			const candidates = servers.filter(options.eligible);
			if (candidates.length === 0) {
				ctx.ui.notify(options.none, "info");
				return undefined;
			}
			const preferred = candidates.filter(options.preferred);
			if (candidates.length === 1) return candidates[0];
			if (preferred.length === 1) return preferred[0];
			const choice = await ctx.ui.select(
				"MCP server",
				candidates.map((server) => server.entry.name),
			);
			return candidates.find((server) => server.entry.name === choice);
		};

		const usesOAuth = (server: McpServer) => server.connection?.oauthUrl !== undefined;
		const oauthPick = {
			eligible: usesOAuth,
			preferred: (server: McpServer) => server.connection?.state === "needs-auth",
			none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
		};

		const loginCommand = async (server: McpServer, ctx: ExtensionCommandContext) => {
			const { name } = server.entry;
			if (!ctx.hasUI) {
				ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
				return;
			}
			const { signal } = session;
			let failure: string | undefined;
			if (ctx.mode === "tui") {
				let completed = false;
				await showMcpManager(ctx, async (ui) => {
					failure = await signInWithUi(ui, server);
					completed = true;
				});
				if (!completed) return;
			} else {
				failure = await signIn(server, {
					showAuthorizationUrl: (url) => {
						ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
						openUrl(url.href);
					},
					promptForRedirectUrl: (signal) =>
						ctx.ui.input(
							`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
							"http://127.0.0.1:.../callback?code=...",
							{ signal },
						),
				});
			}
			// The session ended meanwhile, which cancelled the sign-in and made ctx stale.
			if (signal.aborted) return;
			if (failure) {
				ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
				return;
			}
			ensureDiscoveryActive(ctx);
			ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
		};

		pi.on("session_start", async (_event, ctx) => {
			const loaded = await (options.loadConfig ?? defaultLoadConfig)(ctx);
			latestContext = ctx;
			subagentMcpDirectTools = ctx.subagentPolicy?.mcpDirectTools;
			configErrors = loaded.errors;
			projectConfig = loaded.projectConfig;
			autoEnableCodemode = (ctx.subagentPolicy ? false : loaded.autoEnableCodemode) ?? true;
			warnedUnreachable = false;
			waitedForStartup = false;
			sessionCwd = ctx.cwd;
			modelRegistry = ctx.modelRegistry;
			session = new AbortController();
			const { signal } = session;
			configuredEntries = loaded.servers;
			const registered = registeredServers();
			overridden = registered.overridden;
			servers = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers];
			restoreRecordedTools(ctx);
			emitChange();
			// Codemode or tool_search is activated from the config: the first prompt does not wait for
			// servers whose tools are not declared to the model, and scripts or searches wait for them.
			ensureDiscoveryActive(ctx);
			const enabled = servers.filter(isEnabled);
			if (enabled.length === 0) {
				reportProblems(ctx);
				return;
			}
			// The MCP client loads only now, so sessions without servers never pay for it. Waiting one
			// event loop turn lets the first render happen before loading and connecting.
			const runtime = new Promise((resolve) => setImmediate(resolve)).then(() => loadMcpRuntime());
			pending = Promise.all(enabled.map((server) => startConnection(server, runtime)))
				.then(() => {
					if (!signal.aborted) reportProblems(ctx);
				})
				.catch((error: unknown) => {
					// The session may have been disposed meanwhile, which makes ctx stale.
					try {
						ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
					} catch {}
				});
		});

		// The first prompt waits for servers whose tools are declared to the model, so they are declared
		// in its first request, but not indefinitely: a slow or hanging server must not hold up the
		// prompt. Other servers are waited for when a script or search needs them (below).
		const waitForDirectServers = async (ctx: ExtensionContext) => {
			if (waitedForStartup) return;
			waitedForStartup = true;
			const ready = servers.flatMap((server) =>
				isEnabled(server) &&
				hasDirectTools(server.entry, subagentMcpDirectTools, latestContext?.subagentPolicy?.tools) &&
				server.ready
					? [server.ready]
					: [],
			);
			if (ready.length === 0) return;
			let timer: NodeJS.Timeout | undefined;
			const finished = await Promise.race([
				Promise.all(ready).then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), startupWaitMs);
				}),
			]);
			clearTimeout(timer);
			if (!finished) {
				ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");
			}
		};

		// Every prompt lists the servers in the `mcp_servers` section as they are when it starts. Pi
		// appends the section to the conversation when it changed, for example after a server connected.
		pi.on("before_agent_start", async (event, ctx) => {
			await waitForDirectServers(ctx);
			const { sections } = event.systemPromptOptions;
			const section = layOutServersSection(
				servers.map((server) => {
					const record = pendingSummary(server);
					return { ...server, recordedSummary: record?.summary, recordedSummaryCut: record?.cut };
				}),
			);
			if (section) sections[MCP_SERVERS_SECTION] = section.text;
			else delete sections[MCP_SERVERS_SECTION];
			const shown = new Map<string, ShownSummary>();
			const kept = new Set<string>();
			for (const { listing, summary } of section?.summarized ?? []) {
				if (listing.entry.config.description?.trim()) continue;
				if (listing.recordedSummary !== undefined) kept.add(listing.entry.name);
				// A summary cut down to its ellipsis is recorded as such: with less room it shows none, as the summary does.
				else {
					shown.set(listing.entry.name, {
						summary,
						cut: summary === "…" && serverSummary(listing) !== "…",
						identity: serverIdentity(listing.entry),
					});
				}
			}
			// Recorded once the prompt sends its first message (message_end below).
			promptSection = { options: event.systemPromptOptions, text: section?.text, shown, kept };
		});

		// A codemode script waits for the servers it names, or for every server when it searches or
		// enumerates tools, so their tools are registered before the script runs. tool_search and the
		// resource tools reach every server, so they wait for all of them.
		pi.on("tool_call", async (event, ctx) => {
			const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
			if (!tool) return;
			const readyServers = servers.filter((server) => isEnabled(server) && server.ready);
			if (readyServers.length === 0) return;
			let waiting: McpServer[] = [];
			if (isCodemodeDiscoveryTool(tool)) {
				const { code } = event.input as { code?: unknown };
				const source = typeof code === "string" ? code : "";
				waiting = readyServers.filter((server) => scriptNeedsServer(source, server.entry.name));
			} else if (isToolSearchDiscoveryTool(tool) || RESOURCE_TOOL_NAMES.has(tool.name)) {
				waiting = readyServers;
			} else {
				const owner = toolOwners.get(event.toolName)?.split("\0", 1)[0];
				waiting = readyServers.filter((server) => server.entry.name === owner);
			}
			await waitForServers(waiting, ctx.signal);
		});

		// Keep track of the MCP tools the transcript declares, and record the ones whose listing was not recorded yet.
		// The summaries the prompt's section shows are recorded once its first message ends (the section update, or
		// the prompt itself when the section did not change), so the records say what the conversation shows. When a
		// later handler replaced the section or the prompt, the conversation shows no summary. A reply first means the
		// prompt sent nothing, so nothing changed.
		pi.on("message_end", async (event) => {
			const { message } = event;
			if (promptSection) {
				const { options, text, shown, kept } = promptSection;
				promptSection = undefined;
				if (message.role === "system" || message.role === "user" || message.role === "custom") {
					const sent =
						text !== undefined &&
						options.forceSystemPrompt === undefined &&
						options.sections?.[MCP_SERVERS_SECTION] === text;
					const updates = sent ? summaryUpdates(shown, kept) : summaryUpdates(new Map(), new Set());
					if (updates.length > 0) await recordSummaries(updates);
				}
			}
			if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return;
			for (const tool of message.toolsRemoved ?? []) declaredNames.delete(tool.name);
			for (const tool of message.toolsAdded ?? []) if (isRecordedToolName(tool.name)) declaredNames.add(tool.name);
			// Stored before the request that declares the tools is sent.
			await recordDeclaredTools();
		});

		// Another branch declares other tools and carries other records.
		pi.on("session_tree", (_event, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			toolRecords = readToolRecords(branch);
			readShownRecords(branch);
			declaredNames = declaredMcpToolNames(branch);
			void recordDeclaredTools();
		});

		// Pick up sign-ins done outside the session, such as `pi mcp login` run by the agent.
		pi.on("turn_start", async (_event, ctx) => {
			if (tokensAtSignIn.size > 0) await reconnectSignedIn(ctx);
		});

		// Servers registered or unregistered during the session connect or disconnect right away.
		pi.onMcpServerContributionsChanged?.(() => {
			const { signal } = session;
			if (signal.aborted) return;
			const registered = registeredServers();
			overridden = registered.overridden;
			const next = new Map(registered.servers.map((server) => [server.entry.name, server]));
			const removed = servers.filter(
				(server) =>
					server.entry.scope === "extension" &&
					next.get(server.entry.name)?.registeredConfig !== server.registeredConfig,
			);
			servers = servers.filter((server) => !removed.includes(server));
			for (const server of removed) hideTools(server.entry.name);
			const added = registered.servers.filter((server) => !findServer(server.entry.name));
			servers.push(...added);
			emitChange();
			if (latestContext) ensureDiscoveryActive(latestContext);
			void Promise.all(removed.map((server) => server.connection?.close())).then(async () => {
				const connecting = added.filter(isEnabled);
				if (signal.aborted || connecting.length === 0) return;
				try {
					await Promise.all(connecting.map((server) => startConnection(server)));
					if (!signal.aborted) reportProblems(latestContext!, connecting);
				} catch (error) {
					if (!signal.aborted) latestContext?.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
				}
			});
		});

		pi.on("session_shutdown", async () => {
			session.abort();
			const closing = connections();
			// The retiring registry is discarded. Do not register hidden tools or call a
			// captured UI here: reload has already revoked this generation's authority.
			listeners.clear();
			serverTools.clear();
			definitions.clear();
			toolOwners.clear();
			listedTools.clear();
			recordedOnly.clear();
			toolRecords = { tools: new Map(), resourceServers: undefined, summaries: new Map() };
			recordingTools.clear();
			recordingResources = undefined;
			pendingResourceServers.clear();
			pendingSummaries.clear();
			shownRecords = new Set();
			promptSection = undefined;
			declaredNames = new Set();
			tokensAtSignIn.clear();
			resourceToolsExposure = undefined;
			servers = [];
			latestContext = undefined;
			subagentMcpDirectTools = undefined;
			await Promise.all([...backgroundActions, ...closing.map((connection) => connection.close())]);
			await serverLog?.flush();
		});

		pi.registerCommand("mcp", {
			description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
			getArgumentCompletions: (prefix) => {
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return ["login", "logout", "reconnect"]
						.filter((item) => item.startsWith(action ?? ""))
						.map((item) => ({ value: `${item} `, label: item }));
				}
				if (action !== "login" && action !== "logout" && action !== "reconnect") return null;
				const items = servers
					.filter((candidate) =>
						action === "reconnect" ? candidate.connection !== undefined : usesOAuth(candidate),
					)
					.filter((candidate) => candidate.entry.name.startsWith(server))
					.map((candidate) => ({
						value: `${action} ${candidate.entry.name}`,
						label: candidate.entry.name,
						description: describeState(candidate),
					}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === undefined) {
					if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(ui, ctx));
					else {
						await pending;
						ctx.ui.notify(formatStatus(), "info");
					}
					return;
				}
				if (extra.length > 0) {
					ctx.ui.notify(MCP_USAGE, "warning");
					return;
				}
				await pending;
				switch (action) {
					case "login": {
						const server = await pickServer(name, ctx, oauthPick);
						if (server) await loginCommand(server, ctx);
						return;
					}
					case "logout": {
						const server = await pickServer(name, ctx, oauthPick);
						if (!server) return;
						const removed = await signOut(server);
						ctx.ui.notify(
							removed
								? `Signed out of MCP server "${server.entry.name}".`
								: `No stored credentials for MCP server "${server.entry.name}".`,
							"info",
						);
						return;
					}
					case "reconnect": {
						const server = await pickServer(name, ctx, {
							eligible: (candidate) => candidate.connection !== undefined,
							preferred: (candidate) =>
								candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
							none: "No enabled MCP server to reconnect.",
						});
						if (!server) return;
						const failure = await reconnect(server);
						if (failure) ctx.ui.notify(failure, "error");
						else {
							ensureDiscoveryActive(ctx);
							ctx.ui.notify(
								`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`,
								"info",
							);
						}
						return;
					}
					default:
						ctx.ui.notify(MCP_USAGE, "warning");
				}
			},
		});
	};
}

function defaultLoadConfig(ctx: ExtensionContext): Promise<LoadedMcpConfig> {
	return loadMcpConfigAsync({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
}

export default createMcpExtension();
