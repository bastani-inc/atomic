import { AsyncLocalStorage } from "node:async_hooks";
import { drainExtensionAPIWork, retireExtensionAPI, runExtensionAPICleanup, sealExtensionAPI } from "./loader-api.ts";
import { createExtensionContext } from "./runner-context.ts";
import { noOpUIContext } from "./runner-ui.ts";
import type { Extension, ExtensionRuntime } from "./types.ts";

export const factoryAcquisitions = new AsyncLocalStorage<{
	pending?: Map<Extension, { cwd: string; runtime: ExtensionRuntime }>;
	replacement?: boolean;
}>();

export async function rollbackFactoryAcquisitions(
	retainedRuntimes: ReadonlySet<ExtensionRuntime> = new Set(),
): Promise<unknown[]> {
	const acquired = [...(factoryAcquisitions.getStore()?.pending ?? [])];
	const failures = await rollbackFactories(acquired.map(([extension, { cwd }]) => ({ extension, cwd })));
	for (const runtime of new Set(acquired.map(([, entry]) => entry.runtime))) {
		if (retainedRuntimes.has(runtime)) continue;
		try {
			runtime.invalidate();
		} catch (error) {
			failures.push(error);
		}
	}
	return failures;
}

/** Factories can acquire resources before a session (and its runner) exists. */
export function rollbackExtensionFactories(extensions: Extension[], cwd: string): Promise<unknown[]> {
	return rollbackFactories(extensions.map((extension) => ({ extension, cwd })));
}

async function rollbackFactories(entries: { extension: Extension; cwd: string }[]): Promise<unknown[]> {
	// Seal the complete owned set before the first await, not one cleanup at a time.
	const closing = entries.filter(({ extension }) => sealExtensionAPI(extension)).reverse();
	for (const { extension } of closing) factoryAcquisitions.getStore()?.pending?.delete(extension);
	// A selected sibling may share the runtime and even be invoking this rollback.
	// Only these factories' receipts belong here; all must settle before any hook.
	await Promise.all(closing.map(({ extension }) => drainExtensionAPIWork(extension)));
	const failures: unknown[] = [];
	for (const { extension, cwd } of closing) {
		await runExtensionAPICleanup(extension, async () => {
			for (const handler of extension.handlers.get("session_shutdown") ?? []) {
				try {
					await handler(
						{ type: "session_shutdown", reason: factoryAcquisitions.getStore()?.replacement ? "new" : "quit" },
						rollbackContext(cwd),
					);
				} catch (error) {
					failures.push(error);
				}
			}
		});
		try {
			await drainExtensionAPIWork(extension);
		} catch (error) {
			failures.push(error);
		}
		try {
			retireExtensionAPI(extension);
		} catch (error) {
			failures.push(error);
		}
	}
	return failures;
}

function rollbackContext(cwd: string) {
	const unavailable = (): never => {
		throw new Error("Session is not initialized during factory rollback");
	};
	const noop = () => {};
	return createExtensionContext({
		assertActive: noop,
		getUIContext: () => noOpUIContext,
		getMode: () => "print",
		hasUI: () => false,
		getCwd: () => cwd,
		getSessionManager: unavailable,
		getModelRegistry: unavailable,
		getModel: () => undefined,
		getScopedModels: () => [],
		getThinkingLevel: () => undefined,
		getOrchestrationContext: () => undefined,
		getSubagentPolicy: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => false,
		getSignal: () => AbortSignal.abort(),
		getSessionSignal: () => AbortSignal.abort(),
		abort: noop,
		hasPendingMessages: () => false,
		shutdown: noop,
		getContextUsage: () => undefined,
		compact: unavailable,
		getSystemPrompt: () => "",
		observeWorkflowActivity: unavailable,
	});
}

export function factoryRollbackError(error: unknown, failures: unknown[]): unknown {
	return failures.length
		? Object.assign(
				new AggregateError([error, ...failures], "Extension factory failed and rollback reported errors"),
				{ code: "ShutdownFailed" },
			)
		: error;
}
