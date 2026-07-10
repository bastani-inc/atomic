import type { ExtensionAPI } from "@bastani/atomic";

interface ApiRegistration {
	cleanup: () => void;
	disposed: boolean;
}

export interface ApiLifecycle {
	isCurrent(): boolean;
	setCleanup(cleanup: () => void): void;
	dispose(): void;
}

function getWeakMap<T>(key: string): WeakMap<ExtensionAPI, T> {
	const store = globalThis as Record<string, unknown>;
	const existing = store[key];
	if (existing instanceof WeakMap) return existing as WeakMap<ExtensionAPI, T>;
	const registry = new WeakMap<ExtensionAPI, T>();
	store[key] = registry;
	return registry;
}

export function beginApiLifecycle(pi: ExtensionAPI): ApiLifecycle {
	const registry = getWeakMap<ApiRegistration>("__piSubagentRuntimeRegistrations");
	try {
		registry.get(pi)?.cleanup();
	} catch {
		// Reload cleanup is best effort; a stale resource must not block registration.
	}

	let ownedCleanup = () => {};
	const registration: ApiRegistration = {
		disposed: false,
		cleanup: () => {
			if (registration.disposed) return;
			registration.disposed = true;
			try {
				ownedCleanup();
			} finally {
				if (registry.get(pi) === registration) registry.delete(pi);
			}
		},
	};
	registry.set(pi, registration);

	return {
		isCurrent: () => !registration.disposed && registry.get(pi) === registration,
		setCleanup(cleanup) {
			ownedCleanup = cleanup;
		},
		dispose() {
			if (registry.get(pi) === registration) registration.cleanup();
		},
	};
}

export function getApiScopedSet(pi: ExtensionAPI, key: string): Set<string> {
	const registry = getWeakMap<Set<string>>(key);
	const existing = registry.get(pi);
	if (existing) return existing;
	const values = new Set<string>();
	registry.set(pi, values);
	return values;
}
