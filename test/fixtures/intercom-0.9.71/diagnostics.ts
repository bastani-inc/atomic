import type { AsyncLocalStorage } from "node:async_hooks";
import type { HostDiagnostic } from "@bastani/atomic";

const contextKey = Symbol.for("atomic.builtin-diagnostic-context.v1");
type Reporter = (diagnostic: Omit<HostDiagnostic, "sessionId">) => void;
const host = globalThis as typeof globalThis & { [contextKey]?: AsyncLocalStorage<Reporter> };

/** Relay/config errors may carry capabilities; emit only a fixed owner diagnostic. */
export function reportOwnedIntercomDiagnostic(): boolean {
	const report = host[contextKey]?.getStore();
	if (!report) return false;
	report({ level: "error", source: "intercom", message: "Intercom operation failed" });
	return true;
}
