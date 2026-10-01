/**
 * The part of the MCP integration that talks to servers: connections, transports, and OAuth
 * sign-in. It pulls in the MCP client, so index.ts loads it through runtime.lazy.ts only when a
 * server is configured.
 */

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION } from "../../config.js";
import { resolveMcpServerUrl } from "../../core/mcp-servers.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/resolve-config-value.ts";
import {
	type AuthProvider,
	type CallToolResult,
	JSON_RPC_ERROR_CODES,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	McpAuthRequiredError,
	McpClient,
	McpError,
	type McpFetch,
	McpHttpError,
	type McpRequestOptions,
	McpSessionExpiredError,
	type Tool as McpTool,
	type McpTransport,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	StdioTransport,
	StreamableHttpTransport,
} from "./client/index.js";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "./client/oauth/index.js";
import type { McpServerEntry } from "./config.ts";
import type { McpServerLog } from "./log.ts";
import {
	createMcpAuthProvider,
	type McpAuthProvider,
	type McpOAuthCredentialStore,
	type McpOAuthSettings,
} from "./oauth.ts";
import { isMcpAppResource, type McpResourceServer } from "./resources.ts";
import type { McpToolCaller } from "./tools.ts";

export { McpServerLog } from "./log.ts";
export { McpOAuthCredentialStore, McpSignInCancelledError, signInMcpServer } from "./oauth.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
/** Delays between attempts to connect to an HTTP server that failed with a transient error. */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];
/** Give canceled setup time to retire, without letting a broken transport block session cleanup. */
const OPENING_RETIREMENT_TIMEOUT_MS = 1_000;

async function boundedRetirement(retirement: Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			retirement.catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, OPENING_RETIREMENT_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * `disconnected`: the connection dropped (for example the stdio server exited); the next call
 * reconnects.
 */
type ServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

export type McpTransportFactory = (
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
) => McpTransport;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Network failures and overloaded or restarting servers, which are worth another attempt. */
function isTransientError(error: unknown): boolean {
	if (error instanceof McpHttpError) {
		return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	}
	return error instanceof TypeError;
}

function providerAuthName(entry: McpServerEntry): string | undefined {
	return "url" in entry.config ? entry.config.auth?.provider : undefined;
}

function validateProviderDestination(serverUrl: string): void {
	const url = new URL(serverUrl);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
	) {
		throw new Error("MCP provider credentials require HTTPS or exact loopback HTTP");
	}
}

/** A provider token is granted to this configured origin, never to a redirect destination. */
function providerFetch(serverUrl: string): McpFetch {
	const origin = new URL(serverUrl).origin;
	return async (input, init) => {
		let url = new URL(input);
		let request = { ...init, redirect: "manual" as const };
		for (let redirects = 0; ; redirects++) {
			if (url.origin !== origin) throw new Error("MCP provider request cannot cross origins");
			const response = await fetch(url, request);
			const location = response.headers.get("location");
			if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
			await response.body?.cancel();
			if (redirects >= 10) throw new Error("Too many MCP provider redirects");
			url = new URL(location, url);
			const method = request.method?.toUpperCase() ?? "GET";
			if (
				(response.status === 303 && method !== "HEAD") ||
				([301, 302].includes(response.status) && method === "POST")
			) {
				const headers = new Headers(request.headers);
				for (const header of [
					"content-type",
					"content-length",
					"content-encoding",
					"content-language",
					"content-location",
				])
					headers.delete(header);
				request = { ...request, method: "GET", body: undefined, headers };
			}
		}
	};
}

function signInRequiredMessage(entry: McpServerEntry): string {
	const provider = providerAuthName(entry);
	return `MCP server "${entry.name}" requires sign-in. Run ${provider ? `/login ${provider}` : "/mcp"} to sign in.`;
}

/** HTTP servers authenticate with OAuth unless they supply Authorization or a provider. */
function usesOAuth(entry: McpServerEntry): boolean {
	const { config } = entry;
	if (!("url" in config) || config.auth) return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, like in a shell. */
function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

export function createDefaultTransport(
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		const url = resolveMcpServerUrl(config.url);
		if (config.auth) validateProviderDestination(url);
		return new StreamableHttpTransport({
			url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
			fetch: config.auth ? providerFetch(url) : undefined,
		});
	}
	if (!config.command) throw new Error(`MCP server "${name}" has no command or url`);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	return new StdioTransport({
		command: expandHome(config.command),
		args: config.args?.map(expandHome),
		cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
		env,
		stderr: "pipe",
	});
}

/** Servers that do not implement `resources/templates/list` have no templates. */
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
	try {
		return await list();
	} catch (error) {
		if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
		throw error;
	}
}

function listTemplates(client: McpClient, options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
	return withoutTemplates(() => client.listResourceTemplates(options), []);
}

/**
 * Resources and templates at connect time, for the counts in `/mcp` and `pi mcp list`. A server
 * whose lists fail still connects: the resource tools list and read its resources on demand.
 */
async function fetchResources(
	client: McpClient,
): Promise<{ resources: Resource[]; resourceTemplates: ResourceTemplate[] }> {
	const [resources, resourceTemplates] = await Promise.all([
		client.listResources().catch(() => []),
		listTemplates(client).catch(() => []),
	]);
	return {
		resources: resources.filter((resource) => !isMcpAppResource(resource)),
		resourceTemplates: resourceTemplates.filter((template) => !isMcpAppResource(template)),
	};
}

/** One configured server. Reconnects lazily when a call finds the connection gone. */
export class McpServerConnection implements McpToolCaller, McpResourceServer {
	readonly entry: McpServerEntry;
	state: ServerState = "connecting";
	error: string | undefined;
	tools: McpTool[] = [];
	/**
	 * Whether the server offers resources. The lists below are what it listed at the last connect or
	 * change, without MCP App resources.
	 */
	hasResources = false;
	resources: Resource[] = [];
	resourceTemplates: ResourceTemplate[] = [];
	/** Server instructions from `initialize`, describing its tools as a group. */
	instructions: string | undefined;
	/** Last OAuth challenge from the server; sign-in uses its resource metadata URL and scope. */
	challenge: OAuthChallenge | undefined;
	private client: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	private initializingClient: McpClient | undefined;
	private initializingTransport: McpTransport | undefined;
	private closing: Promise<void> | undefined;
	private readonly activeRequests = new Map<McpClient, number>();
	private readonly retiringClients = new Map<McpClient, { promise: Promise<void>; close: () => Promise<void> }>();
	private closed = false;
	/** Stderr of the last stdio server that failed to connect. */
	private stderrTail: string | undefined;
	private readonly cwd: string;
	private readonly createTransport: McpTransportFactory;
	private readonly authProvider: McpAuthProvider | undefined;
	private readonly onTools: (connection: McpServerConnection) => void;
	private readonly onChange: ((connection: McpServerConnection) => void) | undefined;
	private readonly log: McpServerLog | undefined;

	constructor(options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport: McpTransportFactory;
		credentials: McpOAuthCredentialStore;
		/** The current token of a pi provider, for servers with `auth.provider`. */
		providerToken?: (provider: string) => Promise<string | undefined>;
		onTools: (connection: McpServerConnection) => void;
		/** Called when `state`, `error`, or `tools` change. */
		onChange?: (connection: McpServerConnection) => void;
		/** Receives the server's log messages (`notifications/message`). */
		log?: McpServerLog;
	}) {
		const config = options.entry.config;
		// Resolve once so the credential key, destination check, and transport use the same URL.
		this.entry =
			"url" in config
				? { ...options.entry, config: { ...config, url: resolveMcpServerUrl(config.url) } }
				: options.entry;
		this.cwd = options.cwd;
		this.createTransport = options.createTransport;
		this.onTools = options.onTools;
		this.onChange = options.onChange;
		this.log = options.log;
		const url = this.oauthUrl;
		const provider = providerAuthName(this.entry);
		if (provider && "url" in this.entry.config) validateProviderDestination(this.entry.config.url);
		this.authProvider = url
			? createMcpAuthProvider({
					serverUrl: url,
					store: options.credentials.forServer(url),
					settings: () => this.oauthSettings(),
					onChallenge: (challenge) => {
						this.challenge = challenge;
					},
				})
			: provider
				? // Read on every request, so the provider's refreshes apply; MCP stores no copy.
					{ token: async () => options.providerToken?.(provider), settled: async () => {} }
				: undefined;
	}

	get name(): string {
		return this.entry.name;
	}

	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** Server URL when the server authenticates with OAuth. */
	get oauthUrl(): string | undefined {
		return "url" in this.entry.config && usesOAuth(this.entry) ? this.entry.config.url : undefined;
	}

	oauthSettings(): McpOAuthSettings {
		const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
		if (!oauth) return {};
		return {
			clientId: oauth.clientId,
			clientSecret:
				oauth.clientSecret === undefined
					? undefined
					: resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.entry.name}" oauth.clientSecret`),
			callbackPort: oauth.callbackPort,
			callbackUrl: oauth.callbackUrl,
			scope: oauth.scope,
			clientName: oauth.clientName,
			authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
		};
	}

	getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult> {
		return this.withClient((client) => client.callTool(name, args, options));
	}

	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
		return this.withClient((client) => client.readResource(uri, options), true);
	}

	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult> {
		return this.withClient((client) => client.listResourcesPage(cursor, options), true);
	}

	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult> {
		return this.withClient(
			(client) =>
				withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), { resourceTemplates: [] }),
			true,
		);
	}

	allResources(options: McpRequestOptions): Promise<Resource[]> {
		return this.withClient((client) => client.listResources(options), true);
	}

	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]> {
		return this.withClient((client) => listTemplates(client, options), true);
	}

	/**
	 * Run a request, reconnecting when needed. `readOnly` requests are retried once after a transient
	 * HTTP error; tool calls are not, since they may have run.
	 */
	private async withClient<T>(run: (client: McpClient) => Promise<T>, readOnly = false): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			const client = await this.getClient();
			try {
				return await this.runWithClient(client, run);
			} catch (error) {
				if (readOnly && attempt === 1 && error instanceof McpHttpError && isTransientError(error)) {
					await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[0]));
					continue;
				}
				if (error instanceof McpSessionExpiredError && attempt === 1) {
					if (this.closed) throw error;
					const retirement = this.dropClient(client, true);
					if (!this.activeRequests.has(client)) await retirement;
					if (this.closed) throw error;
					continue;
				}
				if (!this.needsSignIn(error)) throw error;
				await this.dropClient(client);
				this.markNeedsAuth();
				throw new Error(signInRequiredMessage(this.entry));
			}
		}
	}

	private async runWithClient<T>(client: McpClient, run: (client: McpClient) => Promise<T>): Promise<T> {
		this.activeRequests.set(client, (this.activeRequests.get(client) ?? 0) + 1);
		try {
			return await run(client);
		} finally {
			const remaining = (this.activeRequests.get(client) ?? 1) - 1;
			if (remaining > 0) {
				this.activeRequests.set(client, remaining);
			} else {
				this.activeRequests.delete(client);
				void this.retiringClients.get(client)?.close();
			}
		}
	}

	/** Connect again with fresh credentials, for example after signing in. */
	async reconnect(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		await this.getClient();
	}

	/** Disconnect after the stored credentials were removed. */
	async signOut(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		if (!this.closed) this.markNeedsAuth();
	}

	/** OAuth servers that still reject the request after a refresh need the user to sign in again. */
	private needsSignIn(error: unknown): boolean {
		return (
			error instanceof McpOAuthAuthorizationRequiredError ||
			(this.authProvider !== undefined && error instanceof McpAuthRequiredError)
		);
	}

	private markNeedsAuth(): void {
		this.state = "needs-auth";
		this.error = undefined;
		this.changed();
	}

	private changed(): void {
		this.onChange?.(this);
	}

	private dropClient(client: McpClient, drainRequests = false): Promise<void> {
		if (this.client === client) this.client = undefined;
		const pending = this.retiringClients.get(client);
		if (pending) {
			if (!drainRequests) void pending.close();
			return pending.promise;
		}
		let resolve!: () => void;
		const promise = new Promise<void>((done) => {
			resolve = done;
		});
		let closing: Promise<void> | undefined;
		const close = () => {
			closing ??= client
				.close()
				.catch(() => undefined)
				.finally(() => {
					this.retiringClients.delete(client);
					resolve();
				});
			return closing;
		};
		this.retiringClients.set(client, { promise, close });
		if (!drainRequests || !this.activeRequests.has(client)) void close();
		return promise;
	}

	private async open(): Promise<McpClient> {
		this.state = "connecting";
		this.changed();
		const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
		for (let attempt = 0; ; attempt++) {
			this.stderrTail = undefined;
			try {
				return await this.connectOnce();
			} catch (error) {
				const delay = retries[attempt];
				if (this.closed || delay === undefined || !isTransientError(error)) {
					throw this.connectFailed(error);
				}
				await new Promise((resolve) => setTimeout(resolve, delay));
				if (this.closed) throw this.connectFailed(error);
			}
		}
	}

	private async connectOnce(): Promise<McpClient> {
		if (this.closed) throw new Error("shut down while connecting");
		const client = new McpClient({
			name: "pi",
			version: VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		this.initializingClient = client;
		const log = this.log;
		if (log) client.onNotification("notifications/message", (params) => log.write(this.entry.name, params));
		let transport: McpTransport | undefined;
		try {
			transport = this.createTransport(this.entry, this.cwd, this.authProvider);
			this.initializingTransport = transport;
			if (this.closed) throw new Error("shut down while connecting");
			await client.connect(transport);
			client.onNotification("notifications/tools/list_changed", () => {
				void this.refreshTools(client);
			});
			client.onNotification("notifications/resources/list_changed", () => {
				void this.refreshResources(client);
			});
			const stdio = transport instanceof StdioTransport ? transport : undefined;
			client.onClose(() => this.handleClientClose(client, stdio));
			// Servers without the tools capability (prompts or resources only) do not answer tools/list.
			const hasResources = client.serverCapabilities?.resources !== undefined;
			const [tools, resources] = await Promise.all([
				client.serverCapabilities?.tools ? client.listTools() : [],
				hasResources ? fetchResources(client) : { resources: [], resourceTemplates: [] },
			]);
			if (this.closed) throw new Error("shut down while connecting");
			if (client.connectionState !== "connected") throw new Error("connection closed during setup");
			this.client = client;
			this.tools = tools;
			this.hasResources = hasResources;
			this.resources = resources.resources;
			this.resourceTemplates = resources.resourceTemplates;
			this.instructions = client.instructions?.trim() || undefined;
			this.state = "connected";
			this.error = undefined;
			this.onTools(this);
			this.changed();
			return client;
		} catch (error) {
			await client.close().catch(() => undefined);
			if (transport instanceof StdioTransport) {
				this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
			}
			throw error;
		} finally {
			// A delayed start may allocate resources after its first close. Retire them too.
			if (this.closed) await transport?.close().catch(() => undefined);
			if (this.initializingClient === client) {
				this.initializingClient = undefined;
				this.initializingTransport = undefined;
			}
		}
	}

	private connectFailed(error: unknown): Error {
		if (this.needsSignIn(error) && !this.closed) {
			this.markNeedsAuth();
			return new Error(signInRequiredMessage(this.entry));
		}
		this.state = this.closed ? "closed" : "failed";
		this.error = this.stderrTail ? `${errorMessage(error)}\n${this.stderrTail}` : errorMessage(error);
		this.changed();
		return new Error(`MCP server "${this.entry.name}" failed to connect: ${this.error}`);
	}

	/** The transport dropped. The next call reconnects; until then the status shows why. */
	private handleClientClose(client: McpClient, stdio: StdioTransport | undefined): void {
		if (this.client !== client || this.closed) return;
		this.client = undefined;
		this.state = "disconnected";
		const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
		this.error = stderr ? `Connection closed\n${stderr}` : "Connection closed";
		this.changed();
	}

	private async refreshTools(client: McpClient): Promise<void> {
		try {
			const tools = await this.runWithClient(client, (client) => client.listTools());
			if (this.client !== client || this.closed) return;
			this.tools = tools;
			this.onTools(this);
		} catch (error) {
			this.error = `Failed to refresh tools: ${errorMessage(error)}`;
		}
		this.changed();
	}

	private async refreshResources(client: McpClient): Promise<void> {
		const { resources, resourceTemplates } = await this.runWithClient(client, fetchResources);
		if (this.client !== client || this.closed) return;
		this.resources = resources;
		this.resourceTemplates = resourceTemplates;
		this.onTools(this);
		this.changed();
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.state = "closed";
		this.changed();
		const client = this.client;
		this.client = undefined;
		const opening = this.opening;
		const initializingClient = this.initializingClient;
		const initializingTransport = this.initializingTransport;
		// Close immediately, before waiting for setup: start itself may need close to unblock.
		const retirement = Promise.allSettled([
			client?.close(),
			initializingClient?.close(),
			initializingTransport?.close(),
			opening,
			...[...this.retiringClients.values()].map((retirement) => retirement.close()),
		]);
		this.closing = (async () => {
			await boundedRetirement(retirement);
			// Preserve an already-rotated refresh token before exiting.
			await this.authProvider?.settled();
		})();
		return this.closing;
	}
}
