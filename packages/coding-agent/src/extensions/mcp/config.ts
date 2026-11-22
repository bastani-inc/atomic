/**
 * MCP server configuration.
 *
 * Servers are read from `mcp.json` in the agent directory and, for trusted projects, from
 * `<project>/.atomic/mcp.json`. Both use the `mcpServers` shape shared by other MCP clients, so
 * existing configurations can be copied over. Project entries replace global entries with the
 * same name.
 *
 * A project entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and
 * `toolExposure` of the global server with the same name, for example to turn it off in one project:
 * `{ "mcpServers": { "internal-tools": { "enabled": false } } }`. The rest of the global entry is kept,
 * including credentials the project could not set itself.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * HTTP servers without an `Authorization` header use OAuth when they answer 401 (sign in with `/mcp`).
 * `"auth": { "provider": "<provider>" }` sends the token of a `/login` provider instead. Project files
 * cannot use it, so a repository cannot pick where the credential goes.
 *
 * The top-level `autoEnableCodemode` (default true) activates the codemode tool when a server
 * with `codemode` exposure connects. A project value overrides the global one.
 */

import { existsSync, promises as fsPromises, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.js";
import {
	type McpExposure,
	type McpServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "../../core/mcp-servers.ts";
import {
	settingsFileTarget,
	settingsFileTargetAsync,
	writeSettingsFile,
	writeSettingsFileAsync,
} from "../../core/settings-storage.ts";
import { pathExists } from "../../core/tools/path-utils.ts";
import { stripBom } from "../../utils/text.ts";

export type {
	McpExposure,
	McpHttpServerConfig,
	McpOAuthConfig,
	McpServerConfig,
	McpStdioServerConfig,
} from "../../core/mcp-servers.ts";
export { getMcpToolExposure } from "../../core/mcp-servers.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;

/** How long a request to the server may take, in milliseconds: its `timeout`, or 60 seconds. */
export function mcpRequestTimeoutMs(config: McpServerConfig): number {
	return (config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
}

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** Config file that defined the entry, or the path of the extension that registered it. */
	source: string;
	/**
	 * The global or the project `mcp.json`, or `extension` for servers registered with
	 * `atomic.registerMcpServer()`. Changes to extension servers are not saved.
	 */
	scope?: "global" | "project" | "extension";
	/** Project `mcp.json` with an override of this global server's `enabled`, `exposure`, or `toolExposure`. */
	override?: string;
}

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	/** Activate the codemode tool when `codemode` servers connect. Default: true. */
	autoEnableCodemode?: boolean;
	errors: string[];
	/** The project `mcp.json` when the project is trusted, where `/mcp` saves project overrides. */
	projectConfig?: string;
}

const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Whether an entry overrides a server defined elsewhere instead of defining one. */
function isOverride(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface McpConfigState {
	servers: Map<string, McpServerEntry>;
	autoEnableCodemode?: boolean;
	errors: string[];
}

function applyParsedConfigFile(
	path: string,
	parsed: unknown,
	scope: "global" | "project",
	state: McpConfigState,
): void {
	const { servers, errors } = state;
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	if (typeof parsed.autoEnableCodemode === "boolean") state.autoEnableCodemode = parsed.autoEnableCodemode;
	else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		if (scope === "project" && isRecord(value) && isOverride(value)) {
			const base = servers.get(name);
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
			if (!base) {
				errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
			} else if (extra.length > 0) {
				errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
			} else {
				const config = validateMcpServerConfig(name, { ...base.config, ...value });
				if (typeof config === "string") errors.push(`${path}: ${config}`);
				else servers.set(name, { ...base, config, override: path });
			}
			continue;
		}
		const config = validateMcpServerConfig(name, value);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		// Names that differ only in `-` and `_` would share a namespace.
		const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
		if (clash) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (scope === "project" && "url" in config && config.auth) {
			errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
			continue;
		}
		servers.set(name, { name, config, source: path, scope });
	}
}

function readConfigFileSync(path: string, scope: "global" | "project", state: McpConfigState): void {
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
	} catch {
		state.errors.push(`${path}: failed to read or parse MCP configuration`);
		return;
	}
	applyParsedConfigFile(path, parsed, scope, state);
}

async function readConfigFile(path: string, scope: "global" | "project", state: McpConfigState): Promise<void> {
	if (!(await pathExists(path))) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(await fsPromises.readFile(path, "utf8")));
	} catch {
		state.errors.push(`${path}: failed to read or parse MCP configuration`);
		return;
	}
	applyParsedConfigFile(path, parsed, scope, state);
}

function finalizeLoadedMcpConfig(state: McpConfigState, projectConfig: string | undefined): LoadedMcpConfig {
	return {
		servers: [...state.servers.values()],
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
		errors: state.errors,
		...(projectConfig ? { projectConfig } : {}),
	};
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
export function loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig {
	const state: McpConfigState = { servers: new Map(), errors: [] };
	readConfigFileSync(join(options.agentDir, "mcp.json"), "global", state);
	const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
	if (projectConfig) readConfigFileSync(projectConfig, "project", state);
	return finalizeLoadedMcpConfig(state, projectConfig);
}

export async function loadMcpConfigAsync(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): Promise<LoadedMcpConfig> {
	const state: McpConfigState = { servers: new Map(), errors: [] };
	await readConfigFile(join(options.agentDir, "mcp.json"), "global", state);
	const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
	if (projectConfig) await readConfigFile(projectConfig, "project", state);
	return finalizeLoadedMcpConfig(state, projectConfig);
}

/** Settings `/mcp` changes. `enabled: true` and `exposure: "codemode"` are the defaults and remove the key. */
export interface McpServerConfigPatch {
	enabled?: boolean;
	exposure?: McpExposure;
}

function patchMcpServerEntry(
	path: string,
	name: string,
	patch: McpServerConfigPatch,
	options: { override?: boolean },
): (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean {
	return (servers, parsed) => {
		let server: unknown = servers && Object.hasOwn(servers, name) ? servers[name] : undefined;
		if (server === undefined && options.override) {
			server = {};
			parsed.mcpServers = { ...servers, [name]: server };
		}
		if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
		const keepDefaults = isOverride(server);
		if (patch.enabled !== undefined) {
			if (patch.enabled && !keepDefaults) delete server.enabled;
			else server.enabled = patch.enabled;
		}
		if (patch.exposure !== undefined) {
			if (patch.exposure === "codemode" && !keepDefaults) delete server.exposure;
			else server.exposure = patch.exposure;
		}
		return true;
	};
}

/**
 * Change one server's settings in the `mcp.json` that defines or overrides it. With `override`, a
 * missing entry is added as an override. Overrides keep default values, since they replace the global
 * server's. Other content is kept; the file is rewritten with its indentation.
 */
export function updateMcpServerConfig(
	path: string,
	name: string,
	patch: McpServerConfigPatch,
	options: { override?: boolean } = {},
): void {
	if (RESERVED_SERVER_NAMES.has(name))
		throw new Error(`Invalid MCP server name "${name}": reserved object property names are not allowed`);
	editMcpServersSync(path, patchMcpServerEntry(path, name, patch, options));
}

export async function updateMcpServerConfigAsync(
	path: string,
	name: string,
	patch: McpServerConfigPatch,
	options: { override?: boolean } = {},
): Promise<void> {
	if (RESERVED_SERVER_NAMES.has(name))
		throw new Error(`Invalid MCP server name "${name}": reserved object property names are not allowed`);
	await editMcpServers(path, patchMcpServerEntry(path, name, patch, options));
}

/**
 * Add a server to an `mcp.json`, creating the file when missing. An existing entry with the same
 * name is replaced. Returns true when an entry was replaced.
 */
export function addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean {
	let replaced = false;
	editMcpServersSync(path, (servers, parsed) => {
		const target = servers ?? {};
		replaced = Object.hasOwn(target, name) && target[name] !== undefined;
		target[name] = config;
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}

export async function addMcpServerConfigAsync(path: string, name: string, config: McpServerConfig): Promise<boolean> {
	let replaced = false;
	await editMcpServers(path, (servers, parsed) => {
		const target = servers ?? {};
		replaced = Object.hasOwn(target, name) && target[name] !== undefined;
		target[name] = config;
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}

/** Remove a server from an `mcp.json`. Returns false when the file does not define it. */
export function removeMcpServerConfig(path: string, name: string): boolean {
	assertNoPendingAsyncEdit(path);
	if (!existsSync(path)) return false;
	let removed = false;
	editMcpServersSync(path, (servers) => {
		if (!servers || !Object.hasOwn(servers, name) || servers[name] === undefined) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}

export async function removeMcpServerConfigAsync(path: string, name: string): Promise<boolean> {
	let removed = false;
	await editMcpServers(path, (servers) => {
		if (!servers || !Object.hasOwn(servers, name) || servers[name] === undefined) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}

function serializeEditedMcpServers(
	path: string,
	text: string | undefined,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): string | undefined {
	const parsed: unknown = text === undefined ? {} : JSON.parse(text);
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		throw new Error(`${path}: expected an object with an "mcpServers" object`);
	}
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	if (!edit(servers, parsed)) return undefined;
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	return `${JSON.stringify(parsed, null, indent)}\n`;
}

const pendingAsyncPaths = new Map<string, number>();

function trackPendingAsyncPath(path: string, delta: 1 | -1): void {
	const next = (pendingAsyncPaths.get(path) ?? 0) + delta;
	if (next <= 0) pendingAsyncPaths.delete(path);
	else pendingAsyncPaths.set(path, next);
}

function assertNoPendingAsyncEdit(path: string): void {
	if (pendingAsyncPaths.size === 0) return;
	const resolvedPath = resolve(path);
	const target = settingsFileTarget(resolvedPath);
	const conflicted =
		pendingAsyncPaths.has(resolvedPath) ||
		pendingAsyncPaths.has(target) ||
		[...pendingAsyncPaths.keys()].some((pendingPath) => {
			try {
				return settingsFileTarget(pendingPath) === target;
			} catch {
				return pendingPath === resolvedPath;
			}
		});
	if (conflicted) {
		throw new Error(
			`Cannot synchronously edit ${path} while an asynchronous MCP configuration edit is in progress; await addMcpServerConfigAsync, updateMcpServerConfigAsync, or removeMcpServerConfigAsync instead`,
		);
	}
}

function editMcpServersSync(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	assertNoPendingAsyncEdit(path);
	const target = settingsFileTarget(resolve(path));
	const text = existsSync(target) ? stripBom(readFileSync(target, "utf8")) : undefined;
	const output = serializeEditedMcpServers(path, text, edit);
	if (output === undefined) return;
	mkdirSync(dirname(target), { recursive: true });
	writeSettingsFile(target, output);
}

const pendingEdits = new Map<string, Promise<void>>();
let editRegistrationQueue = Promise.resolve();

function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): Promise<void> {
	const resolvedPath = resolve(path);
	trackPendingAsyncPath(resolvedPath, 1);
	const registration = editRegistrationQueue.then(async () => {
		const target = await settingsFileTargetAsync(resolvedPath);
		trackPendingAsyncPath(target, 1);
		const previous = pendingEdits.get(target) ?? Promise.resolve();
		let releaseNext!: () => void;
		const nextGate = new Promise<void>((resolveGate) => {
			releaseNext = resolveGate;
		});
		const chained = previous.then(() => nextGate);
		pendingEdits.set(target, chained);
		return { target, previous, chained, releaseNext };
	});
	editRegistrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);
	return (async () => {
		let registered: Awaited<typeof registration> | undefined;
		try {
			registered = await registration;
			await registered.previous;
			await rewriteMcpServers(path, registered.target, edit);
		} finally {
			trackPendingAsyncPath(resolvedPath, -1);
			if (registered !== undefined) {
				trackPendingAsyncPath(registered.target, -1);
				registered.releaseNext();
				if (pendingEdits.get(registered.target) === registered.chained) {
					pendingEdits.delete(registered.target);
				}
			}
		}
	})();
}

async function rewriteMcpServers(
	path: string,
	target: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): Promise<void> {
	const text = (await pathExists(target)) ? stripBom(await fsPromises.readFile(target, "utf8")) : undefined;
	const output = serializeEditedMcpServers(path, text, edit);
	if (output === undefined) return;
	await fsPromises.mkdir(dirname(target), { recursive: true });
	await writeSettingsFileAsync(target, output);
}
