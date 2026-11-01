import { AsyncLocalStorage } from "node:async_hooks";
import type { ResourceAdmission } from "./sdk-types.ts";

const scope = new AsyncLocalStorage<ResourceAdmission | undefined>();

export function withResourceAdmission<T>(admission: ResourceAdmission, callback: () => Promise<T>): Promise<T> {
	return scope.run(admission, callback);
}

/**
 * Runs `callback` under `admission` alone, or under none when it is undefined: an enclosing scope no longer applies.
 * A turn that a message delivered to a session starts runs under that session's own admission this way.
 */
export function withOwnResourceAdmission<T>(admission: ResourceAdmission | undefined, callback: () => T): T {
	return scope.run(admission, callback);
}

export function currentResourceAdmission(): ResourceAdmission | undefined {
	return scope.getStore();
}
