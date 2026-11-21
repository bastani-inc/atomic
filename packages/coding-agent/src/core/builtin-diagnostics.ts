import { type AsyncScope, asyncScope } from "./async-scope.ts";
import type { HostDiagnostic } from "./extensions/host-input.js";
import { lifecycleScopeForOwner } from "./session-lifecycle-scope.ts";

const contextKey = Symbol.for("atomic.builtin-diagnostic-context.v1");
const diagnosticKey = Symbol.for("atomic.builtin-diagnostic.v1");
type Reporter = (diagnostic: Omit<HostDiagnostic, "sessionId">) => void;
// Raw builtin TS and the compiled host share invocation context, never a current-session singleton.
const host = globalThis as typeof globalThis & { [contextKey]?: AsyncScope<Reporter> };
host[contextKey] ??= asyncScope<Reporter>();
const context = host[contextKey];

export function withBuiltinDiagnostics<T>(owner: object, operation: () => T): T {
	const scope = lifecycleScopeForOwner(owner) as { [diagnosticKey]?: Reporter };
	const report = scope[diagnosticKey];
	return report ? context.run(report, operation) : operation();
}
