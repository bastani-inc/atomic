import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerEntry } from "./types.js";

export interface ProviderAuth {
	provider: string;
}

export type ProviderTokenResolver = (provider: string) => Promise<string | undefined>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_SAME_ORIGIN_REDIRECTS = 3;
const URL_REQUIREMENT = "auth.provider requires an https URL, or http on localhost, 127.0.0.1, or [::1]";

export class McpProviderAuthError extends Error {
	constructor(
		message: string,
		/** Set when the provider login is missing or rejected, so the server needs a sign-in. */
		readonly provider?: string,
	) {
		super(message);
		this.name = "McpProviderAuthError";
	}
}

export function isProviderAuth(auth: ServerEntry["auth"] | unknown): auth is ProviderAuth {
	return typeof auth === "object" && auth !== null && typeof (auth as { provider?: unknown }).provider === "string";
}

export function providerAuthShapeError(auth: unknown): string | undefined {
	if (typeof auth !== "object" || auth === null) return undefined;
	const provider = (auth as { provider?: unknown }).provider;
	return typeof provider === "string" && provider.trim() ? undefined : "auth.provider must be a provider name";
}

export function providerAuthUrlError(value: string | undefined): string | undefined {
	if (!value) return "auth.provider requires a url";
	try {
		const url = new URL(value);
		if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return undefined;
	} catch {}
	return URL_REQUIREMENT;
}

export function providerSignInMessage(serverName: string, provider: string): string {
	return `MCP server "${serverName}" requires sign-in. Run /login ${provider} to sign in.`;
}

export function providerSignInGuidance(
	definition: Pick<ServerEntry, "auth"> | undefined,
	serverName: string,
): string | undefined {
	return isProviderAuth(definition?.auth) ? providerSignInMessage(serverName, definition.auth.provider) : undefined;
}

function signInRequired(serverName: string, provider: string): McpProviderAuthError {
	return new McpProviderAuthError(providerSignInMessage(serverName, provider), provider);
}

/**
 * Sends the provider's current token on every request to the configured origin only. The token is read
 * for each request, never stored, and redirects are not followed except within the same origin.
 */
export function createProviderAuthFetch(options: {
	serverName: string;
	provider: string;
	serverUrl: string;
	token: ProviderTokenResolver | undefined;
	fetch?: FetchLike;
}): FetchLike {
	const { serverName, provider, token } = options;
	const origin = new URL(options.serverUrl).origin;
	return async (input, init) => {
		let url = new URL(input);
		for (let redirects = 0; ; redirects++) {
			if (url.origin !== origin) {
				throw new McpProviderAuthError(
					`MCP server "${serverName}" request refused: provider credentials are only sent to the configured server origin.`,
				);
			}
			const value = await token?.(provider);
			if (!value) throw signInRequired(serverName, provider);
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${value}`);
			const response = await (options.fetch ?? globalThis.fetch)(url, { ...init, headers, redirect: "manual" });
			if (response.status === 401) {
				await response.body?.cancel().catch(() => {});
				throw signInRequired(serverName, provider);
			}
			const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
			if (!location) return response;
			await response.body?.cancel().catch(() => {});
			const target = new URL(location, url);
			const samePreservingRedirect = response.status === 307 || response.status === 308;
			if (!samePreservingRedirect || target.origin !== origin || redirects >= MAX_SAME_ORIGIN_REDIRECTS) {
				throw new McpProviderAuthError(
					`MCP server "${serverName}" redirected the request; provider credentials are not sent across redirects.`,
				);
			}
			url = target;
		}
	};
}
