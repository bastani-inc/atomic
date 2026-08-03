import { randomUUID } from "node:crypto";
import type { AtomicOAuthLoginCallbacks } from "../../core/oauth-login.ts";
import { normalizeOAuthLoginError } from "../../core/oauth-login.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcOAuthLoginProviderResult } from "./rpc-types.ts";

export type RpcOAuthRequest = Extract<RpcExtensionUIRequest, { provider: string }>;

export function isRpcOAuthRequest(request: RpcExtensionUIRequest): request is RpcOAuthRequest {
	return "provider" in request && request.method.startsWith("oauth_");
}

export async function dispatchRpcOAuthRequest(
	provider: string,
	loginId: string,
	callbacks: AtomicOAuthLoginCallbacks,
	request: RpcOAuthRequest,
	respond: (response: RpcExtensionUIResponse) => Promise<void>,
): Promise<void> {
	if (request.provider !== provider || request.loginId !== loginId) return;
	const sendValue = async (value: string | undefined): Promise<void> => {
		await respond(
			value === undefined
				? { type: "extension_ui_response", id: request.id, cancelled: true }
				: { type: "extension_ui_response", id: request.id, value },
		);
	};
	switch (request.method) {
		case "oauth_auth":
			callbacks.onAuth(request.info);
			return;
		case "oauth_device_code":
			callbacks.onDeviceCode(request.info);
			return;
		case "oauth_progress":
			callbacks.onProgress?.(request.message);
			return;
		case "oauth_info":
			callbacks.onInfo?.(request.message, request.links);
			return;
		case "oauth_prompt":
			await sendValue(await callbacks.onPrompt(request.prompt));
			return;
		case "oauth_select":
			await sendValue(await callbacks.onSelect(request.prompt));
			return;
		case "oauth_manual_code":
			await sendValue(await callbacks.onManualCodeInput?.());
			return;
		case "oauth_manual_code_cancel":
			callbacks.onManualCodeCancel?.();
			return;
	}
}

interface RpcOAuthClientTransport {
	onExtensionUIRequest(listener: (request: RpcExtensionUIRequest) => void): () => void;
	respondExtensionUI(response: RpcExtensionUIResponse): Promise<void>;
	requestInternal<T>(command: {
		type: "login_provider";
		provider: string;
		authType: "oauth";
		loginId: string;
	}): Promise<T>;
	cancelLoginProvider(provider: string, loginId?: string): Promise<void>;
}

export async function loginRpcOAuthProvider(
	client: RpcOAuthClientTransport,
	provider: string,
	callbacks: AtomicOAuthLoginCallbacks,
): Promise<RpcOAuthLoginProviderResult> {
	if (callbacks.signal?.aborted) throw normalizeOAuthLoginError(callbacks.signal.reason, callbacks.signal);
	const loginId = randomUUID();
	let callbackError: unknown;
	const active = new Set<Promise<void>>();
	const unsubscribe = client.onExtensionUIRequest((request) => {
		if (!isRpcOAuthRequest(request) || request.provider !== provider || request.loginId !== loginId) return;
		const operation = dispatchRpcOAuthRequest(provider, loginId, callbacks, request, (response) =>
			client.respondExtensionUI(response),
		);
		active.add(operation);
		void operation
			.catch((error) => {
				callbackError = error;
				void client.cancelLoginProvider(provider, loginId).catch(() => {});
			})
			.finally(() => active.delete(operation));
	});
	const cancel = () => {
		void client.cancelLoginProvider(provider, loginId).catch(() => {});
	};
	callbacks.signal?.addEventListener("abort", cancel, { once: true });
	try {
		const result = await client.requestInternal<RpcOAuthLoginProviderResult>({
			type: "login_provider",
			provider,
			authType: "oauth",
			loginId,
		});
		await Promise.allSettled([...active]);
		if (callbackError !== undefined) {
			throw normalizeOAuthLoginError(callbackError, callbacks.signal, { includeActiveSignal: false });
		}
		return result;
	} finally {
		callbacks.signal?.removeEventListener("abort", cancel);
		unsubscribe();
	}
}
