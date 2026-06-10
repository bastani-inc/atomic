import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalAtomicExperimental = process.env.ATOMIC_EXPERIMENTAL;
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;

	afterEach(() => {
		if (originalAtomicExperimental === undefined) {
			delete process.env.ATOMIC_EXPERIMENTAL;
		} else {
			process.env.ATOMIC_EXPERIMENTAL = originalAtomicExperimental;
		}
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when the experimental flags are unset", () => {
		delete process.env.ATOMIC_EXPERIMENTAL;
		delete process.env.PI_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when ATOMIC_EXPERIMENTAL is empty", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ATOMIC_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when ATOMIC_EXPERIMENTAL is set to 1", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ATOMIC_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns true when the legacy PI_EXPERIMENTAL is set to 1", () => {
		delete process.env.ATOMIC_EXPERIMENTAL;
		process.env.PI_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when ATOMIC_EXPERIMENTAL is set to 0", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ATOMIC_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when ATOMIC_EXPERIMENTAL is set to a non-1 value", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ATOMIC_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
