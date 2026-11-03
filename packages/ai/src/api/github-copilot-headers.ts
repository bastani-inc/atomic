import type { Message, ProviderHeaders } from "../types.ts";

// Copilot expects X-Initiator to indicate whether the request is user-initiated
// or agent-initiated (e.g. follow-up after assistant/tool messages).
export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last && last.role !== "user" ? "agent" : "user";
}

// Copilot requires Copilot-Vision-Request header when sending images
export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		return false;
	});
}

/**
 * Environment/API-key Copilot credentials are raw GitHub tokens unless they
 * contain the `tid=` segment emitted by the Copilot token exchange.
 *
 * A missing credential is not classified as raw: callers may be supplying
 * authentication through headers, and adding an integration id in that case
 * would change requests that do not have a resolved bearer token.
 */
export function isRawCopilotToken(apiKey: string | undefined): boolean {
	return apiKey !== undefined && apiKey.length > 0 && !apiKey.split(";").some((segment) => segment.startsWith("tid="));
}

/**
 * Keep a custom provider/model integration id ahead of the dynamic default.
 * Built-in Copilot models carry `vscode-chat` as their OAuth static header;
 * raw-token requests replace that built-in value with the developer CLI id.
 * In the pi-ai layer alone, an explicitly supplied `vscode-chat` value is
 * indistinguishable from the catalog default and is replaced for raw-token
 * requests; the Atomic coding agent resolves header provenance separately so
 * an explicitly configured `vscode-chat` survives there. A per-request header
 * is merged later and always wins.
 */
export function preserveCopilotIntegrationHeader(
	modelHeaders: ProviderHeaders | undefined,
	dynamicHeaders: Record<string, string>,
): Record<string, string> {
	const modelIntegrationHeader = Object.entries(modelHeaders ?? {}).find(
		([name]) => name.toLowerCase() === "copilot-integration-id",
	);
	if (!modelIntegrationHeader || modelIntegrationHeader[1] === "vscode-chat") return dynamicHeaders;

	return Object.fromEntries(
		Object.entries(dynamicHeaders).filter(([name]) => name.toLowerCase() !== "copilot-integration-id"),
	);
}

/** Client identity headers every GitHub Copilot request carries. */
export const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

/** API version for reading the account's model list. */
export const COPILOT_API_VERSION = "2026-06-01";

/** Integration ID GitHub Copilot expects with a raw GitHub token. */
const RAW_TOKEN_INTEGRATION_ID = "copilot-developer-cli";

/** Identity headers for a request outside a conversation, such as reading the account's model list. */
export function copilotClientHeaders(apiKey: string): Record<string, string> {
	return isRawCopilotToken(apiKey)
		? { ...COPILOT_HEADERS, "Copilot-Integration-Id": RAW_TOKEN_INTEGRATION_ID }
		: { ...COPILOT_HEADERS };
}

export function buildCopilotDynamicHeaders(params: {
	messages: Message[];
	hasImages: boolean;
	apiKey?: string;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Initiator": inferCopilotInitiator(params.messages),
		"Openai-Intent": "conversation-edits",
	};

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	if (isRawCopilotToken(params.apiKey)) {
		headers["Copilot-Integration-Id"] = RAW_TOKEN_INTEGRATION_ID;
	}

	return headers;
}
