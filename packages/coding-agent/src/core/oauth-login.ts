import type { AuthInfoLink, AuthInteraction, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

export interface AtomicOAuthLoginCallbacks extends OAuthLoginCallbacks {
	onManualCodeCancel?(): void;
	onInfo?(message: string, links: readonly AuthInfoLink[]): void;
}

/** JSON-safe provider-owned OAuth metadata transported across isolated-engine boundaries. */
export interface OAuthProviderMetadata {
	id: string;
	name: string;
	loginLabel?: string;
	usesCallbackServer?: boolean;
}

/** Marks failures after credential acquisition so presentation never mistakes nested AbortErrors for cancellation. */
export class OAuthLoginTransactionError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "OAuthLoginTransactionError";
	}
}

export function isOAuthLoginCancelled(
	error: unknown,
	signal?: AbortSignal,
	options: { includeActiveSignal?: boolean } = {},
): boolean {
	if (error instanceof OAuthLoginTransactionError) return false;
	if (options.includeActiveSignal !== false && signal?.aborted) return true;
	const reason = signal?.reason;
	const seen = new Set<object>();
	let current: unknown = error;
	while (current !== undefined && current !== null) {
		if (current === reason && reason !== undefined) return true;
		if (current === "Login cancelled") return true;
		if (typeof current !== "object") return false;
		if (seen.has(current)) return false;
		seen.add(current);
		const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
		if (candidate.name === "AbortError" || candidate.message === "Login cancelled") return true;
		current = candidate.cause;
	}
	return false;
}

export function normalizeOAuthLoginError(
	error: unknown,
	signal?: AbortSignal,
	options?: { includeActiveSignal?: boolean },
): unknown {
	if (error instanceof Error && error.message === "Login cancelled" && error.cause !== undefined) return error;
	if (!isOAuthLoginCancelled(error, signal, options)) return error;
	return new Error("Login cancelled", { cause: error });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		onAbort?.();
		return Promise.reject(signal.reason ?? new Error("Authentication prompt cancelled"));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			onAbort?.();
			reject(signal.reason ?? new Error("Authentication prompt cancelled"));
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export function createAuthInteraction(callbacks: AtomicOAuthLoginCallbacks): AuthInteraction {
	return {
		signal: callbacks.signal,
		prompt: async (prompt) => {
			switch (prompt.type) {
				case "select":
					return (
						(await callbacks.onSelect({
							message: prompt.message,
							options: prompt.options.map(({ id, label }) => ({ id, label })),
						})) ?? ""
					);
				case "manual_code":
					return abortable(
						callbacks.onManualCodeInput
							? callbacks.onManualCodeInput()
							: callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder }),
						prompt.signal,
						callbacks.onManualCodeCancel,
					);
				default:
					return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
			}
		},
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					callbacks.onAuth({ url: event.url, instructions: event.instructions });
					break;
				case "device_code":
					callbacks.onDeviceCode(event);
					break;
				case "progress":
					callbacks.onProgress?.(event.message);
					break;
				case "info":
					callbacks.onInfo?.(event.message, event.links ?? []);
					break;
			}
		},
	};
}
