import type { SourceInfo } from "./source-info.ts";

export interface McpServerOAuthConfig {
	grantType?: "authorization_code" | "client_credentials";
	clientId?: string;
	clientSecret?: string;
	scope?: string;
}

/** One MCP server definition; the same schema as an `mcpServers` entry in `mcp.json`. */
export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	oauth?: McpServerOAuthConfig | false;
	lifecycle?: "keep-alive" | "lazy" | "eager";
	idleTimeout?: number;
	exposeResources?: boolean;
	directTools?: boolean | string[];
	excludeTools?: string[];
	debug?: boolean;
	timeoutMs?: number;
	/** Drop the server from the effective MCP configuration. */
	disabled?: boolean;
}

/** An MCP server contributed by a package manifest or an extension's `pi.registerMcpServer()` call. */
export interface McpServerContribution {
	name: string;
	config: McpServerConfig;
	/** `package` for manifest `mcpServers`; `extension` for runtime registrations. */
	origin: "package" | "extension";
	/** Declaring manifest file for packages; registering extension path and its package source for extensions. */
	sourceInfo: SourceInfo;
}
