import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InMemorySettingsStorage } from "../src/core/settings-storage.ts";
import type { Settings } from "../src/core/settings-types.ts";

/** JSON.parse keeps these names as own keys, which is how they reach the settings manager from settings input. */
const PROTOTYPE_KEYS_JSON =
	'{"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}';

const protoAccessor = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")!;
let prototypeAssignments: number;

beforeEach(() => {
	prototypeAssignments = 0;
	// Count every assignment through `__proto__`, which would swap an object's prototype for settings input.
	Object.defineProperty(Object.prototype, "__proto__", {
		...protoAccessor,
		set(this: object, value: object | null) {
			prototypeAssignments++;
			protoAccessor.set!.call(this, value);
		},
	});
});

afterEach(() => {
	Object.defineProperty(Object.prototype, "__proto__", protoAccessor);
});

function readStored(storage: InMemorySettingsStorage): Record<string, Record<string, unknown>> {
	let stored = "{}";
	storage.withLock("global", (current) => {
		stored = current ?? "{}";
		return undefined;
	});
	return JSON.parse(stored) as Record<string, Record<string, unknown>>;
}

describe("settings keys named after prototype properties", () => {
	test("overriding and setting warnings with __proto__, constructor and prototype keys touches no prototype", async () => {
		const objectPrototypeKeys = Object.getOwnPropertyNames(Object.prototype).sort();
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage);

		manager.applyOverrides(JSON.parse(`{"warnings":${PROTOTYPE_KEYS_JSON}}`) as Partial<Settings>);
		manager.setWarnings({
			...(JSON.parse(PROTOTYPE_KEYS_JSON) as Record<string, boolean>),
			anthropicExtraUsage: false,
		});
		await manager.flush();

		assert.equal(prototypeAssignments, 0);
		assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), objectPrototypeKeys);
		assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
		assert.equal(Object.prototype.constructor, Object);
		const warnings = manager.getWarnings() as Record<string, unknown>;
		assert.equal(Object.getPrototypeOf(warnings), Object.prototype);
		assert.equal(warnings.anthropicExtraUsage, false);
		assert.equal(readStored(storage).warnings?.anthropicExtraUsage, false);
	});
});
