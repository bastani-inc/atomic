import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const EXPECTED_NATIVE_EXPORTS = [
	"FileType",
	"GrepOutputMode",
	"PtySession",
	"blockRangeAt",
	"glob",
	"grep",
	"hasMatch",
	"invalidateFsScanCache",
	"search",
] as const;

const requireNativeBinding = process.env.ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE === "1";
let binding: object | undefined;
let loadError: Error | undefined;
try {
	binding = createRequire(import.meta.url)("@bastani/atomic-natives") as object;
} catch (error) {
	loadError = error instanceof Error ? error : new Error(String(error));
}

describe("Atomic native binding export contract", () => {
	it.skipIf(!requireNativeBinding && !binding)("loads the host binding with exactly the supported exports", () => {
		if (!binding) throw loadError ?? new Error("Native binding is required but unavailable");
		expect(Object.keys(binding).sort()).toEqual([...EXPECTED_NATIVE_EXPORTS].sort());
	});
});
