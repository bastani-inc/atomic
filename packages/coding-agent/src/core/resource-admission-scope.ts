import { AsyncLocalStorage } from "node:async_hooks";
import type { ResourceAdmission } from "./sdk-types.ts";

const scope = new AsyncLocalStorage<ResourceAdmission>();

export function withResourceAdmission<T>(admission: ResourceAdmission, callback: () => Promise<T>): Promise<T> {
	return scope.run(admission, callback);
}

export function currentResourceAdmission(): ResourceAdmission | undefined {
	return scope.getStore();
}
