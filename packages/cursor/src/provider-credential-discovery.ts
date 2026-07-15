interface CursorCredentialDiscoveryContext {
	readonly mode?: "tui" | "rpc" | "json" | "print";
	readonly ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
	readonly modelRegistry?: { getApiKeyForProvider?(provider: string): Promise<string | undefined> | string | undefined };
}

interface CursorCredentialDiscoveryDependencies {
	readonly inactive: () => boolean;
	readonly useContextResolver: (resolver: () => Promise<string | undefined> | string | undefined) => void;
	readonly resolveAccessToken: () => Promise<string | undefined> | string | undefined;
	readonly invalidateCredential: (message: string) => Error;
	readonly scheduleDiscovery: (accessToken: string) => Promise<boolean> | undefined;
	readonly refreshError: () => string | undefined;
	readonly reportPrintWarning: (context: CursorCredentialDiscoveryContext | undefined) => void;
}

function isCatalogDiscovery(event: unknown): boolean {
	return typeof event === "object" && event !== null && "type" in event && event.type === "model_catalog_discover";
}

export async function discoverStoredCursorCredential(
	event: unknown,
	context: CursorCredentialDiscoveryContext | undefined,
	dependencies: CursorCredentialDiscoveryDependencies,
): Promise<void> {
	if (dependencies.inactive()) return;
	const registry = context?.modelRegistry;
	if (registry?.getApiKeyForProvider) dependencies.useContextResolver(() => registry.getApiKeyForProvider?.("cursor"));
	const shouldAwait = context?.mode === "print" || isCatalogDiscovery(event);
	let accessToken: string | undefined;
	try {
		accessToken = await dependencies.resolveAccessToken();
	} catch {
		const error = dependencies.invalidateCredential("Cursor credential lookup failed. Log in again and reselect an exact model with --list-models.");
		context?.ui?.notify(error.message, "error");
		if (shouldAwait) throw error;
		return;
	}
	if (!accessToken) {
		const error = dependencies.invalidateCredential("Cursor is not authenticated. Log in again and reselect an exact model with --list-models.");
		context?.ui?.notify(error.message, "error");
		if (shouldAwait) throw error;
		return;
	}
	const task = dependencies.scheduleDiscovery(accessToken);
	if (!task) {
		if (context?.mode === "print" && dependencies.refreshError()) dependencies.reportPrintWarning(context);
		return;
	}
	if (!shouldAwait) {
		void task.then((success) => {
			const refreshError = dependencies.refreshError();
			if (!success || refreshError) context?.ui?.notify(`Cursor model refresh warning: ${refreshError ?? "retained the previous catalog"}`, "warning");
		});
		return;
	}
	const success = await task;
	if (success && !dependencies.refreshError()) return;
	dependencies.reportPrintWarning(context);
}
