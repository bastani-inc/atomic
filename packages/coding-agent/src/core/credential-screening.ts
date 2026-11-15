import { type Credential, containsKnownEnvCredential } from "@bastani/atomic-ai";
import { containsConfiguredValue } from "./resolve-config-value.ts";

export function containsCredentialValue(serialized: string, value: unknown): boolean {
	return typeof value === "string" && !!value.trim() && serialized.includes(JSON.stringify(value).slice(1, -1));
}

/** Inspect stored token material, not request auth (which can refresh OAuth or execute commands). */
export function containsCredential(serialized: string, credential: Credential | undefined): boolean {
	if (!credential) return false;
	if (credential.type === "api_key") {
		return (
			(!!credential.key && containsConfiguredValue(serialized, credential.key, credential.env)) ||
			containsKnownEnvCredential(serialized, credential.env)
		);
	}
	return Object.entries(credential).some(
		([name, value]) =>
			/^(?:access|refresh)$|token|secret|password|api[_-]?key/i.test(name) &&
			containsCredentialValue(serialized, value),
	);
}

interface AuthConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	models?: readonly { headers?: Record<string, string> }[];
	modelOverrides?: Record<string, { headers?: Record<string, string> }>;
}

export function containsAuthConfig(serialized: string, config: AuthConfig | undefined): boolean {
	if (!config) return false;
	if (config.apiKey && containsConfiguredValue(serialized, config.apiKey)) return true;
	const headers = [
		config.headers,
		...(config.models?.map((model) => model.headers) ?? []),
		...Object.values(config.modelOverrides ?? {}).map((model) => model.headers),
	];
	return headers.some((entries) =>
		Object.entries(entries ?? {}).some(
			([name, value]) =>
				(/auth|token|key|secret|cookie/i.test(name) || /[$!]/.test(value)) &&
				containsConfiguredValue(serialized, value),
		),
	);
}
