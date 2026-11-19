import { type AsyncScope, asyncScope } from "../async-scope.ts";
import { withBuiltinDiagnostics } from "../builtin-diagnostics.ts";
import {
	drainSessionWork,
	hasCallingSessionWork,
	sessionLifetime,
	sessionQuitSignal,
	trackSessionWork,
} from "../session-lifecycle-work.ts";
import { hostInputError } from "./host-input.js";
import { STALE_EXTENSION_CONTEXT_MESSAGE } from "./stale-context.ts";
import type { ExtensionRuntime } from "./types.ts";

interface WorkBinding {
	sealed: boolean;
	cleanup: AsyncScope<{ active: boolean }>;
	revoked?: boolean;
	run<T>(operation: () => Promise<T>): Promise<T>;
	drain(): Promise<void>;
	signal(): AbortSignal;
	quitting(): boolean;
}

// Built and source loaders share bindings, without consulting or modifying an SDK runtime's properties.
const bindingsKey = Symbol.for("atomic.extension-work-bindings.v1");
const host = globalThis as typeof globalThis & { [bindingsKey]?: WeakMap<ExtensionRuntime, WorkBinding> };
host[bindingsKey] ??= new WeakMap<ExtensionRuntime, WorkBinding>();
const bindings = host[bindingsKey];

export function bindExtensionWork(runtime: ExtensionRuntime, owner: object): void {
	if (bindings.has(runtime)) return;
	bindings.set(runtime, {
		sealed: false,
		cleanup: asyncScope<{ active: boolean }>(),
		run: (operation) => trackSessionWork(owner, () => trackSessionWork(runtime, operation)),
		drain: () => drainSessionWork(runtime),
		signal: () => sessionLifetime(owner),
		quitting: () => sessionQuitSignal(owner).aborted,
	});
}

export function extensionSessionSignal(runtime: ExtensionRuntime): AbortSignal {
	return bindings.get(runtime)?.signal() ?? sessionLifetime(runtime);
}

export function extensionSessionQuitting(runtime: ExtensionRuntime): boolean {
	return bindings.get(runtime)?.quitting() === true;
}

export function sealExtensionWork(runtime: ExtensionRuntime): void {
	const binding = bindings.get(runtime);
	if (binding) binding.sealed = true;
}

export function resumeExtensionWork(runtime: ExtensionRuntime): void {
	const binding = bindings.get(runtime);
	if (binding) binding.sealed = false;
}

export function extensionWorkOpen(runtime: ExtensionRuntime): boolean {
	return !bindings.get(runtime)?.sealed;
}

export function trackExtensionWork<T>(runtime: ExtensionRuntime, operation: () => Promise<T>): Promise<T> {
	return withBuiltinDiagnostics(
		runtime,
		() => bindings.get(runtime)?.run(operation) ?? trackSessionWork(runtime, operation),
	);
}

export async function drainExtensionWork(runtime: ExtensionRuntime): Promise<void> {
	await (bindings.get(runtime)?.drain() ?? drainSessionWork(runtime));
}

/** Cleanup may inspect its retired resources, but cannot act on a successor. */
export function assertExtensionAction(runtime: ExtensionRuntime): void {
	const binding = bindings.get(runtime);
	if (binding?.revoked) throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
	if (binding?.sealed && !binding.cleanup.getStore()?.active && !hasCallingSessionWork(runtime))
		throw hostInputError("SessionClosed");
}

export function isRetiredExtensionCleanup(runtime: ExtensionRuntime): boolean {
	const binding = bindings.get(runtime);
	return !!binding?.revoked && !!binding.cleanup.getStore()?.active;
}

/** Revoke capabilities without releasing resources still owned by admitted callbacks. */
export function revokeExtensionAuthority(runtime: ExtensionRuntime): void {
	const binding = bindings.get(runtime);
	if (!binding || binding.revoked) return;
	binding.revoked = true;
	const assertActive = runtime.assertActive.bind(runtime);
	runtime.assertActive = () => {
		assertActive();
		if (!binding.cleanup.getStore()?.active) throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
	};
}

export async function runExtensionCleanup<T>(runtime: ExtensionRuntime, operation: () => Promise<T>): Promise<T> {
	const binding = bindings.get(runtime);
	if (!binding) return operation();
	const scope = { active: true };
	try {
		return await binding.cleanup.run(scope, operation);
	} finally {
		scope.active = false;
	}
}
