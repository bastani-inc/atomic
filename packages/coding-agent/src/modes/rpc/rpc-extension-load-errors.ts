import type { AgentSession } from "../../core/agent-session.js";
import type { RpcOutput } from "./rpc-responses.ts";

/** The load that produced an extension load error: the startup load or a later reload. */
export type ExtensionLoadEvent = "startup" | "reload";

/**
 * Report each extension that failed to load in the session's last (re)load as an `extension_error` event. Startup and
 * every reload report through here, so an extension that breaks while it is being edited is never dropped silently.
 */
export function outputExtensionLoadErrors(session: AgentSession, event: ExtensionLoadEvent, output: RpcOutput): void {
	for (const extensionError of session.resourceLoader.getExtensions().errors) {
		output({ type: "extension_error", extensionPath: extensionError.path, event, error: extensionError.error });
	}
}

/**
 * Whether an `extension_error` reports an extension load failure rather than an error raised while running. Load
 * failures name the extension file; errors the session raises itself use a `session:` pseudo path.
 */
export function isExtensionLoadError(error: { extensionPath: string; event: string }): boolean {
	return (error.event === "startup" || error.event === "reload") && !error.extensionPath.startsWith("session:");
}
