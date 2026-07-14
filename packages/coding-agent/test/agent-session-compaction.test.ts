import { describe, expect, it } from "vitest";
import { agentSessionCompactionMethods } from "../src/core/agent-session-compaction.ts";

describe("AgentSession compaction surface", () => {
	it("exposes compact as the only boundary-creating manual door", () => {
		expect(agentSessionCompactionMethods.compact).toBeTypeOf("function");
		expect(["context", "Compact"].join("") in agentSessionCompactionMethods).toBe(false);
		expect(agentSessionCompactionMethods._applyVerbatimCompaction).toBeTypeOf("function");
	});
});
