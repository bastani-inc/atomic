import { describe, expect, it } from "vitest";
import { resolveSessionIdTarget, resolveSessionIdTargetAcrossScopes } from "../src/session-id-target.ts";

describe("coding-agent session UUID selectors", () => {
	const local = { id: "2603abcd-1111-7222-8333-123456789abc", path: "/local" };
	const collision = { id: "2603abcd-9999-7222-8333-123456789abc", path: "/other" };
	const custom = { id: "2603abcd", path: "/custom" };

	it("prefers exact custom IDs and resolves unique UUID prefixes", () => {
		// Regression: #2603 — exact custom session IDs retain priority over prefix selectors.
		expect(resolveSessionIdTarget(custom.id, [local, custom])).toEqual({ kind: "exact", session: custom });
		expect(resolveSessionIdTarget("2603ABCD", [local])).toEqual({ kind: "unique_prefix", session: local });
	});

	it("reports UUID prefix ambiguity instead of selecting the first session", () => {
		// Regression: #2603 — coding-agent session collisions must request the full UUID.
		const result = resolveSessionIdTarget("2603abcd", [local, collision]);
		expect(result.kind).toBe("ambiguous");
		if (result.kind === "ambiguous") {
			expect(result.matches).toEqual([local, collision]);
			expect(result.message).toMatch(/Use the full UUID/);
		}
	});

	it("distinguishes missing prefixes, malformed truncations, and missing custom IDs", () => {
		// Regression: #2603 — only exactly eight hexadecimal characters form a UUID prefix.
		expect(resolveSessionIdTarget("deadbeef", [local]).kind).toBe("not_found");
		expect(resolveSessionIdTarget("2603abc", [local]).kind).toBe("malformed");
		expect(resolveSessionIdTarget("named-session", [local]).kind).toBe("not_found");
	});

	it("keeps current-project precedence and loads the global scope only when needed", async () => {
		// Regression: #2603 — a unique local prefix wins without widening the existing search scope.
		let globalLoads = 0;
		const globalExact = { id: "2603abcd", path: "/global" };
		const localResult = await resolveSessionIdTargetAcrossScopes("2603abcd", [local], async () => {
			globalLoads += 1;
			return [globalExact];
		});
		expect(localResult).toEqual({ kind: "unique_prefix", scope: "local", session: local });
		expect(globalLoads).toBe(0);

		const globalResult = await resolveSessionIdTargetAcrossScopes("deadbeef", [local], async () => {
			globalLoads += 1;
			return [{ id: "deadbeef-1111-7222-8333-123456789abc", path: "/global-uuid" }];
		});
		expect(globalResult.kind).toBe("unique_prefix");
		if (globalResult.kind === "unique_prefix") expect(globalResult.scope).toBe("global");
		expect(globalLoads).toBe(1);
	});
});
