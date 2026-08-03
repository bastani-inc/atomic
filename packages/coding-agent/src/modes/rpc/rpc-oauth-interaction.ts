import { randomUUID } from "node:crypto";
import type { AtomicOAuthLoginCallbacks } from "../../core/oauth-login.ts";
import { normalizeOAuthLoginError } from "../../core/oauth-login.ts";
import type { RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import type { RpcOutput } from "./rpc-responses.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types.ts";

export interface OAuthInteractionTransport {
	output: RpcOutput;
	pending: RpcPendingExtensionRequests;
}

type WithoutEnvelope<T> = T extends object ? Omit<T, "type" | "id"> : never;
type OAuthValueRequest = WithoutEnvelope<
	Extract<RpcExtensionUIRequest, { method: "oauth_prompt" | "oauth_select" | "oauth_manual_code" }>
>;
type OAuthNotification = WithoutEnvelope<Extract<RpcExtensionUIRequest, { provider: string }>>;

function responseValue(response: RpcExtensionUIResponse): string | undefined {
	return "value" in response ? response.value : undefined;
}

function requestValue(
	transport: OAuthInteractionTransport,
	request: OAuthValueRequest,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (signal.aborted) return Promise.reject(normalizeOAuthLoginError(signal.reason, signal));
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			transport.pending.delete(id);
		};
		const onAbort = () => {
			cleanup();
			reject(normalizeOAuthLoginError(signal.reason, signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		transport.pending.set(id, {
			resolve: (response) => {
				cleanup();
				resolve(responseValue(response));
			},
			reject: (error) => {
				cleanup();
				reject(error);
			},
		});
		transport.output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	});
}

function notify(transport: OAuthInteractionTransport, request: OAuthNotification): void {
	transport.output({ type: "extension_ui_request", id: randomUUID(), ...request } as RpcExtensionUIRequest);
}

export function createRpcOAuthCallbacks(
	provider: string,
	loginId: string,
	signal: AbortSignal,
	transport: OAuthInteractionTransport,
): AtomicOAuthLoginCallbacks {
	return {
		signal,
		onAuth: (info) => notify(transport, { method: "oauth_auth", provider, loginId, info }),
		onDeviceCode: (info) => notify(transport, { method: "oauth_device_code", provider, loginId, info }),
		onProgress: (message) => notify(transport, { method: "oauth_progress", provider, loginId, message }),
		onInfo: (message, links) =>
			notify(transport, { method: "oauth_info", provider, loginId, message, links: [...links] }),
		onPrompt: async (prompt) =>
			(await requestValue(transport, { method: "oauth_prompt", provider, loginId, prompt }, signal)) ?? "",
		onSelect: (prompt) => requestValue(transport, { method: "oauth_select", provider, loginId, prompt }, signal),
		onManualCodeInput: async () =>
			(await requestValue(transport, { method: "oauth_manual_code", provider, loginId }, signal)) ?? "",
		onManualCodeCancel: () => notify(transport, { method: "oauth_manual_code_cancel", provider, loginId }),
	};
}
