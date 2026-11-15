import { afterEach, describe, expect, it } from "vitest";
import { getPromptCacheTtlMs } from "../src/cache-warming.ts";
import { getAtomicEnvValue } from "../src/utils/provider-env.ts";

describe("ATOMIC_* settings with legacy PI_* names (#5174)", () => {
	const names = ["ATOMIC_CACHE_RETENTION", "PI_CACHE_RETENTION"] as const;
	const saved = names.map((name) => process.env[name]);
	afterEach(() => {
		names.forEach((name, index) => {
			const value = saved[index];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
	});

	it("reads ATOMIC_<name> first and falls back to PI_<name>", () => {
		expect(getAtomicEnvValue("CACHE_RETENTION", { PI_CACHE_RETENTION: "long" })).toBe("long");
		expect(
			getAtomicEnvValue("CACHE_RETENTION", { ATOMIC_CACHE_RETENTION: "none", PI_CACHE_RETENTION: "long" }),
		).toBe("none");
		delete process.env.ATOMIC_CACHE_RETENTION;
		delete process.env.PI_CACHE_RETENTION;
		expect(getAtomicEnvValue("CACHE_RETENTION")).toBeUndefined();
	});

	it("applies ATOMIC_CACHE_RETENTION to the prompt cache", () => {
		const model = { promptCache: { short: 300, long: 3600 } } as Parameters<typeof getPromptCacheTtlMs>[0];
		delete process.env.PI_CACHE_RETENTION;
		process.env.ATOMIC_CACHE_RETENTION = "long";
		expect(getPromptCacheTtlMs(model, undefined)).toBe(3_600_000);
		process.env.ATOMIC_CACHE_RETENTION = "short";
		process.env.PI_CACHE_RETENTION = "long";
		expect(getPromptCacheTtlMs(model, undefined)).toBe(300_000);
	});
});
