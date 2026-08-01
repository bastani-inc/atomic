import { describe, expect, it } from "vitest";
import { shouldStartRpcCatalogRefresh } from "../src/main-app-mode.ts";

describe("RPC startup model refresh", () => {
	it("leaves interactive-engine catalog refresh ownership to the model selector", () => {
		expect(shouldStartRpcCatalogRefresh(false, true)).toBe(false);
	});

	it("preserves eager refresh for online standalone RPC sessions", () => {
		expect(shouldStartRpcCatalogRefresh(false, false)).toBe(true);
	});

	it("does not refresh either RPC shape while offline", () => {
		expect(shouldStartRpcCatalogRefresh(true, false)).toBe(false);
		expect(shouldStartRpcCatalogRefresh(true, true)).toBe(false);
	});
});
