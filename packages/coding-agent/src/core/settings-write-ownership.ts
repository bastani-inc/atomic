import { asyncScope } from "./async-scope.ts";
import type { SettingsScope } from "./settings-types.ts";

// Internal write receipts: do not drain the manager's caller-owned error channel.
export const settingsWriteOwner = asyncScope<object>();
export const ownedSettingsManagers = new WeakMap<object, object>();
const failures = new WeakMap<object, Map<SettingsScope, unknown>>();
export function recordSettingsWrite(owner: object | undefined, scope: SettingsScope, error?: unknown): void {
	if (!owner) return;
	let receipt = failures.get(owner);
	if (!receipt) {
		receipt = new Map();
		failures.set(owner, receipt);
	}
	if (error === undefined) receipt.delete(scope);
	else receipt.set(scope, error);
}
export function assertSettingsWrites(owner: object): void {
	const errors = [...(failures.get(owner)?.values() ?? [])];
	if (errors.length) throw new AggregateError(errors, "Settings persistence failed");
}
