import { asyncScope } from "../async-scope.ts";
import { drainExtensionAPIWork, retireExtensionAPI, runExtensionAPICleanup, sealExtensionAPI } from "./loader-api.ts";
import { createExtensionContext } from "./runner-context.ts";
import { noOpUIContext } from "./runner-ui.ts";
import type { Extension, ExtensionRuntime, SessionShutdownEvent } from "./types.ts";

export const factoryAcquisitions = asyncScope<{
	pending?: Map<Extension, { cwd: string; runtime: ExtensionRuntime }>;
	replacement?: boolean;
	/** The shutdown the rolled-back factories see, when they are let go for another session rather than a failure. */
	shutdown?: Pick<SessionShutdownEvent, "reason" | "targetSessionId">;
	/** Told of each extension as its cleanup begins. */
	onCleanup?: (extension: Extension) => void;
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

/**
 * Runs `operation`, recording the extension factories it runs. `rollback` later shuts them down as a failed creation's
 * are: each sees `shutdown` as its session_shutdown, its API retires and its runtime is invalidated. `release` hands them
 * over to the session that keeps them, so the record holds none of them any more. When `operation` fails, the factories
 * it ran are rolled back at once.
 */
export async function recordFactoryAcquisitions<T>(operation: () => Promise<T>): Promise<{
	result: T;
	release: () => void;
	rollback: (
		shutdown: Pick<SessionShutdownEvent, "reason" | "targetSessionId">,
		onCleanup?: (extension: Extension) => void,
	) => Promise<unknown[]>;
}> {
	const pending = new Map<Extension, { cwd: string; runtime: ExtensionRuntime }>();
	let result: T;
	try {
		result = await factoryAcquisitions.run({ pending }, operation);
	} catch (error) {
		throw factoryRollbackError(
			error,
			await factoryAcquisitions.run({ pending }, () => rollbackFactoryAcquisitions()),
		);
	}
	return {
		result,
		release: () => pending.clear(),
		rollback: (shutdown, onCleanup) =>
			factoryAcquisitions.run({ pending, shutdown, onCleanup }, () => rollbackFactoryAcquisitions()),
	};
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
		factoryAcquisitions.getStore()?.onCleanup?.(extension);
		await runExtensionAPICleanup(extension, async () => {
			for (const handler of extension.handlers.get("session_shutdown") ?? []) {
				try {
					const scope = factoryAcquisitions.getStore();
					await handler(
						{ type: "session_shutdown", ...(scope?.shutdown ?? { reason: scope?.replacement ? "new" : "quit" }) },
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
		getProjectHistory: unavailable,
		getModelRegistry: unavailable,
		getModel: () => undefined,
		getScopedModels: () => [],
		getThinkingLevel: () => undefined,
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
