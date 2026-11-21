import assert from "node:assert/strict";
import { test, vi } from "vitest";

const natives = vi.hoisted(() => ({ loads: 0, missing: true }));

vi.mock("../../packages/coding-agent/src/utils/module-require.js", () => ({
	createModuleRequire: () => (id: string) => {
		assert.equal(id, "@bastani/atomic-natives");
		natives.loads++;
		if (natives.missing)
			throw new Error(
				"Atomic's native module is not installed: this install of Atomic omitted optional dependencies.\nRequire stack:\n- /app/main.js",
			);
		return {};
	},
}));

const { assertNativeModuleAvailable, NativeModuleUnavailableError } = await import(
	"../../packages/coding-agent/src/utils/native-module.js"
);

test("a native module that cannot load stops with the loader's message, and loads once it is installed", () => {
	assert.throws(
		() => assertNativeModuleAvailable(),
		(error: unknown) =>
			error instanceof NativeModuleUnavailableError &&
			error.code === "NativeModuleUnavailable" &&
			error.message ===
				"Atomic's native module is not installed: this install of Atomic omitted optional dependencies.",
	);

	natives.missing = false;
	assertNativeModuleAvailable();
	assertNativeModuleAvailable();
	assert.equal(natives.loads, 2, "a failed load is tried again; a module that loaded is not loaded again");
});
