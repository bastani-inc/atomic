import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai/compat";
import { APP_NAME } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

function isOpenRouterModel(model: Model<Api>): boolean {
	return model.provider === "openrouter" || matchesHost(model.baseUrl, OPENROUTER_HOST);
}

function isNvidiaNimModel(model: Model<Api>): boolean {
	return model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST);
}

function isCloudflareModel(model: Model<Api>): boolean {
	return (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
		matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
	);
}

function getDefaultAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
): Record<string, string> | undefined {
	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (isOpenRouterModel(model)) {
		return {
			"HTTP-Referer": "https://atomic.sh",
			"X-OpenRouter-Title": APP_NAME,
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (isNvidiaNimModel(model)) {
		return {
			"X-BILLING-INVOKE-ORIGIN": "Atomic",
		};
	}

	if (isCloudflareModel(model)) {
		return {
			"User-Agent": APP_NAME,
		};
	}

	return undefined;
}

function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (
		model.provider !== "opencode" &&
		model.provider !== "opencode-go" &&
		!matchesHost(model.baseUrl, OPENCODE_HOST)
	) {
		return undefined;
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": APP_NAME };
}

function mergeHeaderSource(merged: ProviderHeaders, headers: ProviderHeaders | undefined): void {
	if (!headers) return;
	for (const [key, value] of Object.entries(headers)) {
		const normalizedKey = key.toLowerCase();
		for (const existingKey of Object.keys(merged)) {
			if (existingKey.toLowerCase() === normalizedKey) {
				delete merged[existingKey];
			}
		}
		// Preserve `null` verbatim: under pi-ai 0.80.2 a `null` header value is the
		// documented suppression signal for a provider/API default header. Collapsing
		// it to `undefined` or dropping it would let pi-ai re-add its own default and
		// silently defeat the caller's suppression request.
		merged[key] = value;
	}
}

export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {};
	mergeHeaderSource(merged, getSessionHeaders(model, sessionId));
	mergeHeaderSource(merged, getDefaultAttributionHeaders(model, settingsManager));

	for (const headers of headerSources) {
		mergeHeaderSource(merged, headers);
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
