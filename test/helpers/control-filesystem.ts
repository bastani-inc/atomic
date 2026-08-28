import assert from "node:assert/strict";
import { vi } from "vitest";

const state = vi.hoisted(() => ({ armed: false, calls: [] as string[] }));

function guardedValue(value: unknown, operation: string, cache: WeakMap<object, unknown>): unknown {
	if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
	const objectValue = value as object;
	const cached = cache.get(objectValue);
	if (cached) return cached;
	const guarded = new Proxy(objectValue, {
		apply(target, thisArg, args) {
			if (state.armed) {
				state.calls.push(operation);
				throw new Error(`control filesystem call: ${operation}`);
			}
			return Reflect.apply(target as (...args: unknown[]) => unknown, thisArg, args);
		},
		get(target, property, receiver) {
			const nested = Reflect.get(target, property, receiver) as unknown;
			return guardedValue(nested, `${operation}.${String(property)}`, cache);
		},
	});
	cache.set(objectValue, guarded);
	return guarded;
}

function guardedFilesystemModule(module: Record<string, unknown>): Record<string, unknown> {
	const cache = new WeakMap<object, unknown>();
	return Object.fromEntries(Object.entries(module).map(([name, value]) => [name, guardedValue(value, name, cache)]));
}

vi.mock("node:fs", async (importOriginal) => guardedFilesystemModule(await importOriginal<Record<string, unknown>>()));
vi.mock("node:fs/promises", async (importOriginal) =>
	guardedFilesystemModule(await importOriginal<Record<string, unknown>>()),
);
vi.mock("fs", async (importOriginal) => guardedFilesystemModule(await importOriginal<Record<string, unknown>>()));
vi.mock("fs/promises", async (importOriginal) =>
	guardedFilesystemModule(await importOriginal<Record<string, unknown>>()),
);

export const controlFilesystem = {
	get calls(): readonly string[] {
		return state.calls;
	},
	arm(): void {
		state.calls.length = 0;
		state.armed = true;
	},
	assertUntouched(): void {
		assert.deepEqual(state.calls, []);
	},
	disarm(): void {
		state.armed = false;
	},
};
