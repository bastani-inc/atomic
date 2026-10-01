import type { SourceInfo } from "./source-info.ts";

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
const MCP_EXPOSURES: readonly string[] = ["codemode", "deferred", "direct", "hidden"];
const EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

interface McpServerConfigBase {
	exposure?: McpExposure;
	description?: string;
	toolExposure?: Record<string, McpExposure>;
	enabled?: boolean;
	timeout?: number;
}
export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}
export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
	auth?: { provider: string };
}
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
export interface McpServerContribution {
	name: string;
	config: McpServerConfig;
	origin: "package" | "extension";
	sourceInfo: SourceInfo;
}
export interface McpOAuthConfig {
	clientId?: string;
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
	clientName?: string;
	authServerMetadataUrl?: string;
}

export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
export function resolveMcpServerUrl(value: string): string {
	const resolved = value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)/g,
		(_match, brace: string | undefined, powershell: string | undefined) => {
			const name = brace ?? powershell!;
			const replacement = process.env[name];
			if (replacement === undefined) throw new Error(`MCP server URL environment variable "${name}" is not set`);
			return replacement;
		},
	);
	if (!URL.canParse(resolved) || !/^https?:$/.test(new URL(resolved).protocol))
		throw new Error("Invalid MCP server URL after environment variable interpolation: expected HTTP(S)");
	return resolved;
}
export function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && !url.search && !url.hash;
}
function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	for (const key of ["clientId", "clientSecret", "scope"] as const)
		if (value[key] !== undefined && typeof value[key] !== "string") return `oauth.${key} must be a string`;
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535))
		return "oauth.callbackPort must be a port number";
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl))
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		const urlPort = new URL(value.callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port)
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
	}
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim()))
		return "oauth.clientName must be a non-empty string";
	const metadataUrl = value.authServerMetadataUrl;
	if (metadataUrl !== undefined) {
		const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))))
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
	}
	return undefined;
}
function isExposure(value: unknown): value is McpExposure {
	return typeof value === "string" && MCP_EXPOSURES.includes(value);
}
function resolveExposureAlias(value: unknown): unknown {
	return typeof value === "string" ? (EXPOSURE_ALIASES[value] ?? value) : value;
}
function resolveExposureAliases(raw: Record<string, unknown>): Record<string, unknown> {
	const value = { ...raw };
	if (raw.exposure !== undefined) value.exposure = resolveExposureAlias(raw.exposure);
	if (isRecord(raw.toolExposure))
		value.toolExposure = Object.fromEntries(
			Object.entries(raw.toolExposure).map(([tool, exposure]) => [tool, resolveExposureAlias(exposure)]),
		);
	return value;
}
function toolPatternRegExp(pattern: string): RegExp {
	return new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	);
}
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	const overrides = config.toolExposure ?? {};
	const exact = overrides[toolName];
	if (exact !== undefined) return exact;
	for (const [pattern, exposure] of Object.entries(overrides))
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	return config.exposure ?? "codemode";
}
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const value = resolveExposureAliases(raw);
	const { type, exposure, enabled, timeout, toolExposure, description } = value;
	const exposures = MCP_EXPOSURES.map((entry) => `"${entry}"`).join(", ");
	if (exposure !== undefined && !isExposure(exposure)) return `server "${name}": exposure must be one of ${exposures}`;
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, entry] of Object.entries(toolExposure))
			if (!isExposure(entry)) return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (description !== undefined && typeof description !== "string")
		return `server "${name}": description must be a string`;
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0)))
		return `server "${name}": timeout must be a positive number of seconds`;
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		let resolvedUrl: string;
		try {
			resolvedUrl = resolveMcpServerUrl(value.url);
		} catch {
			return `server "${name}": url must be an http or https URL after environment variable interpolation`;
		}
		if (value.headers !== undefined && !isStringRecord(value.headers))
			return `server "${name}": headers must map names to strings`;
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		if (value.auth !== undefined) {
			if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider)
				return `server "${name}": auth.provider must be a provider name`;
			const url = new URL(resolvedUrl);
			if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))
				return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
		}
		return value as unknown as McpHttpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (
			value.args !== undefined &&
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		)
			return `server "${name}": args must be an array of strings`;
		if (value.env !== undefined && !isStringRecord(value.env))
			return `server "${name}": env must map names to strings`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		return value as unknown as McpStdioServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}
