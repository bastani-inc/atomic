import { createHash } from "node:crypto";
import type { Api, AssistantMessage, Model, StreamOptions } from "@bastani/atomic-ai";
import { type AzureEndpointOptions, resolveAzureBaseUrl } from "@bastani/atomic-ai/api/azure-openai-config";
import { getProviderEnvValue } from "@bastani/atomic-ai/utils/provider-env";

type AccountOptions = Pick<StreamOptions, "apiKey" | "headers" | "env"> &
	Pick<AzureEndpointOptions, "azureBaseUrl" | "azureResourceName"> & {
		baseUrl?: string;
		bearerToken?: string;
		profile?: string;
		project?: string;
		location?: string;
	};

const failureAccounts = new WeakMap<AssistantMessage, string>();

export function observeFailedProviderAccount(message: AssistantMessage, account: string): void {
	failureAccounts.set(message, account);
}

export function failedProviderAccount(message: AssistantMessage): string | undefined {
	return failureAccounts.get(message);
}

function normalizedEndpoint(model: Model<Api>, options: AccountOptions): string {
	const baseUrl = options.baseUrl ?? model.baseUrl;
	try {
		const url = new URL(model.api === "azure-openai-responses" ? resolveAzureBaseUrl({ baseUrl }, options) : baseUrl);
		url.hash = "";
		return url.toString().replace(/\/+(?=\?|$)/, "");
	} catch {
		return baseUrl.trim().replace(/\/+$/, "");
	}
}

function codexAccountId(apiKey: string | undefined): string | undefined {
	const parts = apiKey?.split(".");
	if (parts?.length !== 3 || !parts[1]) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
			"https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
		} | null;
		const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function credentialIdentity(model: Model<Api>, options: AccountOptions): readonly (string | undefined)[] | undefined {
	if (model.api === "openai-codex-responses") {
		// Codex sends this account ID alongside the bearer token. It stays the same when the token rotates.
		const account = codexAccountId(options.apiKey);
		if (account) return ["codex-account", account];
	}
	const headers = new Map(
		[...Object.entries(model.headers ?? {}), ...Object.entries(options.headers ?? {})].map(([name, value]) => [
			name.toLowerCase(),
			value,
		]),
	);
	const authorization = headers.get("authorization") ?? headers.get("cf-aig-authorization");
	const key =
		authorization?.replace(/^Bearer\s+/i, "") ??
		headers.get("x-api-key") ??
		headers.get("api-key") ??
		headers.get("x-goog-api-key") ??
		options.apiKey;
	const env = (name: string) => getProviderEnvValue(name, options.env);
	if (model.api === "bedrock-converse-stream") {
		if (env("AWS_BEDROCK_SKIP_AUTH") === "1") return undefined;
		const bearer = options.bearerToken || key || env("AWS_BEARER_TOKEN_BEDROCK");
		if (bearer) return ["key", bearer];
		const profile = options.profile || options.env?.AWS_PROFILE;
		if (profile) return ["aws-profile", profile];
		const accessKey = env("AWS_ACCESS_KEY_ID");
		if (accessKey) return ["aws-access-key", accessKey];
		if (env("AWS_PROFILE")) return ["aws-profile", env("AWS_PROFILE")];
		const role =
			env("AWS_ROLE_ARN") ??
			env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ??
			env("AWS_CONTAINER_CREDENTIALS_FULL_URI") ??
			env("AWS_WEB_IDENTITY_TOKEN_FILE");
		if (role) return ["aws-role", role];
	}
	if (key) return ["key", key];
	if (model.api === "google-vertex") {
		const project = options.project || env("GOOGLE_CLOUD_PROJECT") || env("GCLOUD_PROJECT");
		const location = options.location || env("GOOGLE_CLOUD_LOCATION");
		if (project && location) return ["vertex-adc", project, location, env("GOOGLE_APPLICATION_CREDENTIALS")];
	}
	if (model.api === "anthropic-messages" && env("ANTHROPIC_FEDERATION_RULE_ID")) {
		return [
			"anthropic-federation",
			env("ANTHROPIC_ORGANIZATION_ID"),
			env("ANTHROPIC_FEDERATION_RULE_ID"),
			env("ANTHROPIC_SERVICE_ACCOUNT_ID"),
			env("ANTHROPIC_WORKSPACE_ID"),
			env("ANTHROPIC_IDENTITY_TOKEN_FILE"),
		];
	}
	return undefined;
}

/** Hash the effective endpoint and credential. Never retain either raw value in limit or turn state. */
export function providerAccount(model: Model<Api>, options: AccountOptions): string | undefined {
	const credential = credentialIdentity(model, options);
	if (!credential) return undefined;
	return createHash("sha256")
		.update(JSON.stringify([normalizedEndpoint(model, options), credential]))
		.digest("hex");
}
