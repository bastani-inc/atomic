import type { Provider } from "../models.ts";

/**
 * GitHub Copilot host routing for raw-token (PAT) auth, whether the token comes
 * from `COPILOT_GITHUB_TOKEN` or from an API key saved through `/login`.
 *
 * Upstream pi pins `github-copilot` to `https://api.individual.githubcopilot.com`
 * and only derives a per-tenant host inside the OAuth loader, which returns an
 * `auth.baseUrl` from the token's `proxy-ep` segment. `envApiKeyAuth` resolves
 * raw tokens without a base URL, so business/enterprise tokens are sent to the
 * individual CAPI host and GitHub answers `421 Misdirected Request`.
 *
 * This module restores the routing precedence for the raw-token path only; the
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

function withModelBaseUrl<TModel extends { baseUrl: string }>(models: readonly TModel[], baseUrl: string): TModel[] {
	return models.map((model) => ({ ...model, baseUrl }));
}

/**
 * Rewrite the builtin Copilot provider's host when a raw Copilot token is configured.
 *
 * `getStoredApiKey` returns the API key saved through `/login`, if any. It wins
 * over `COPILOT_GITHUB_TOKEN`, matching credential resolution, and is read on
 * every access so a login or logout reroutes without rebuilding the provider.
 *
 * Applied to the builtin layer so a `models.json` `baseUrl` override, which is
 * composed afterwards, still takes precedence. Without a raw token the provider
 * keeps pi's exact behavior, so OAuth logins are unaffected.
 */
export function withCopilotEnvBaseUrl(
	provider: Provider,
	env: CopilotRoutingEnv,
	getStoredApiKey?: () => string | undefined,
): Provider {
	if (provider.id !== COPILOT_PROVIDER_ID) return provider;
	if (!getStoredApiKey && !env.COPILOT_GITHUB_TOKEN?.trim()) return provider;
	const routedBaseUrl = (): string | undefined => {
		const token = getStoredApiKey?.()?.trim() || env.COPILOT_GITHUB_TOKEN?.trim();
		return token ? resolveCopilotEnvBaseUrl({ ...env, COPILOT_GITHUB_TOKEN: token }) : undefined;
	};
	const routed = <TModel extends { baseUrl: string }>(models: readonly TModel[]): readonly TModel[] => {
		const baseUrl = routedBaseUrl();
		return baseUrl ? withModelBaseUrl(models, baseUrl) : models;
	};
	const { getAllModels } = provider;
	return {
		...provider,
		get baseUrl() {
			return routedBaseUrl() ?? provider.baseUrl;
		},
		getModels: () => routed(provider.getModels()),
		...(getAllModels ? { getAllModels: () => routed(getAllModels.call(provider)) } : {}),
	};
}
