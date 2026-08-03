import { describe, expect, it } from "vitest";
import {
	COMPACTION_AUTO_QUERY,
	normalizeCompactionParameters,
	normalizeCompactionQuery,
} from "../src/core/compaction/compaction-parameters.js";

describe("compaction query normalization", () => {
	it("keeps a long query whole so late constraints still steer retention", () => {
		const guard = "Do not author an RFC/spec or implement code changes.";
		const query = `${"objective detail ".repeat(1200)}${guard}`;
		expect(query.length).toBeGreaterThan(10_000);

		const normalized = normalizeCompactionQuery(query, COMPACTION_AUTO_QUERY);

		expect(normalized).toBe(query);
		expect(normalized).toContain(guard);
		expect(normalized).not.toContain("omitted from compaction query");
	});

	it("trims and falls back when the query is empty", () => {
		expect(normalizeCompactionQuery("  focus  ", "fallback")).toBe("focus");
		expect(normalizeCompactionQuery("   ", "fallback")).toBe("fallback");
		expect(normalizeCompactionQuery(undefined, "   ")).toBe(COMPACTION_AUTO_QUERY);
	});

	it("carries the whole query through parameter normalization", () => {
		const query = "a".repeat(5000);
		expect(normalizeCompactionParameters({ query }).query).toBe(query);
	});
});
