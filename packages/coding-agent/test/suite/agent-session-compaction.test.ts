import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { VerbatimCompactionResult } from "../../src/core/compaction/index.ts";

describe("AgentSession compact API typing", () => {
	it("returns the verbatim result shape", () => {
		type Result = Awaited<ReturnType<AgentSession["compact"]>>;
		const accept = (result: Result): VerbatimCompactionResult => result;
		expect(typeof accept).toBe("function");
	});
});
