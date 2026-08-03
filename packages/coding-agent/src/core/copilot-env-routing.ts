import type { Api, Model, Provider } from "@earendil-works/pi-ai";

/**
 * GitHub Copilot host routing for `COPILOT_GITHUB_TOKEN` (PAT) auth.
 *
 * Upstream pi pins `github-copilot` to `https://api.individual.githubcopilot.com`
 * and only derives a per-tenant host inside the OAuth loader, which returns an
 * `auth.baseUrl` from the token's `proxy-ep` segment. `envApiKeyAuth` resolves
 * `COPILOT_GITHUB_TOKEN` without a base URL, so business/enterprise tokens are
 * sent to the individual CAPI host and GitHub answers `421 Misdirected Request`.
 *
 * This module restores the routing precedence for the env-token path only; the
 * OAuth path stays exactly upstream. A `models.json` provider `baseUrl` still
 * wins, because it is applied as a later overlay in `applyModelsJson`.
 */

export type CopilotRoutingEnv = Readonly<Record<string, string | undefined>>;

const COPILOT_PROVIDER_ID = "github-copilot";
/** Public routing hub: resolves the caller's plan-specific CAPI host server-side. */
const PUBLIC_COPILOT_HUB = "https://api.githubcopilot.com";
const ENTERPRISE_COPILOT_HOST = "https://api.enterprise.githubcopilot.com";

function normalizeBaseUrl(value: string): string {
	const trimmed = value.trim().replace(/\/+$/u, "");
	if (!trimmed) return "";
	return /^https?:\/\//u.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** `tid=...;exp=...;proxy-ep=proxy.business.githubcopilot.com;...` -> API host. */
function baseUrlFromToken(token: string): string | undefined {
	const match = token.match(/proxy-ep=([^;]+)/u);
	if (!match?.[1]) return undefined;
	const host = match[1].trim().replace(/^proxy\./u, "api.");
	return host ? normalizeBaseUrl(host) : undefined;
}

function hostFromServerUrl(serverUrl: string): string | undefined {
	try {
		return new URL(normalizeBaseUrl(serverUrl)).hostname.toLowerCase() || undefined;
	} catch {
		return undefined;
	}
}

function baseUrlFromServerHost(host: string): string | undefined {
	if (host === "github.com" || host.endsWith(".github.com")) return undefined;
	// Tenant-scoped GHE.com: octocorp.ghe.com -> copilot-api.octocorp.ghe.com
	if (host.endsWith(".ghe.com")) {
		const tenant = host.slice(0, -".ghe.com".length).split(".").pop();
		return tenant ? `https://copilot-api.${tenant}.ghe.com` : ENTERPRISE_COPILOT_HOST;
	}
	// GitHub Enterprise Server on a self-hosted domain routes through the
	// enterprise CAPI host rather than a per-appliance Copilot endpoint.
	return ENTERPRISE_COPILOT_HOST;
}

/**
 * Resolve the Copilot API base URL for env-token auth, highest precedence first:
 *
 * 1. `COPILOT_API_TARGET` / `GITHUB_COPILOT_BASE_URL` explicit override
 * 2. the `proxy-ep` segment embedded in `COPILOT_GITHUB_TOKEN`
 * 3. an explicit `enterpriseDomain`
 * 4. `GITHUB_SERVER_URL` (`*.ghe.com` tenant host, else the enterprise host)
 * 5. the public Copilot routing hub when `COPILOT_GITHUB_TOKEN` is set
 *
 * Returns `undefined` when nothing applies, leaving pi's individual-host default.
 */
export function resolveCopilotEnvBaseUrl(env: CopilotRoutingEnv, enterpriseDomain?: string): string | undefined {
	const override = env.COPILOT_API_TARGET?.trim() || env.GITHUB_COPILOT_BASE_URL?.trim();
	if (override) return normalizeBaseUrl(override);

	const token = env.COPILOT_GITHUB_TOKEN?.trim();
	if (token) {
		const fromToken = baseUrlFromToken(token);
		if (fromToken) return fromToken;
	}

	if (enterpriseDomain?.trim()) return `https://copilot-api.${enterpriseDomain.trim()}`;

	const serverUrl = env.GITHUB_SERVER_URL?.trim();
	if (serverUrl) {
		const host = hostFromServerUrl(serverUrl);
		const fromServer = host ? baseUrlFromServerHost(host) : undefined;
		if (fromServer) return fromServer;
	}

	return token ? PUBLIC_COPILOT_HUB : undefined;
}

function withModelBaseUrl<TApi extends Api>(models: readonly Model<TApi>[], baseUrl: string): Model<TApi>[] {
	return models.map((model) => ({ ...model, baseUrl }));
}

/**
 * Rewrite the builtin Copilot provider's host when `COPILOT_GITHUB_TOKEN` is set.
 *
 * Applied to the builtin layer so a `models.json` `baseUrl` override, which is
 * composed afterwards, still takes precedence. Providers without the env token
 * are returned untouched so OAuth logins keep pi's exact behavior.
 */
export function withCopilotEnvBaseUrl(provider: Provider, env: CopilotRoutingEnv): Provider {
	if (provider.id !== COPILOT_PROVIDER_ID || !env.COPILOT_GITHUB_TOKEN?.trim()) return provider;
	const baseUrl = resolveCopilotEnvBaseUrl(env);
	if (!baseUrl || baseUrl === provider.baseUrl) return provider;
	return {
		...provider,
		baseUrl,
		// Wrap the getter so dynamically refreshed models are routed too.
		getModels: () => withModelBaseUrl(provider.getModels(), baseUrl),
	};
}
