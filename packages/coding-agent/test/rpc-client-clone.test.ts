import { describe, expect, expectTypeOf, it } from "vitest";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.ts";

describe("RpcClient compaction surface", () => {
	it("types compact with the verbatim result and removes the legacy alias", () => {
		expectTypeOf<Awaited<ReturnType<RpcClient["compact"]>>>().toEqualTypeOf<VerbatimCompactionResult>();
		expect(["context", "Compact"].join("") in RpcClient.prototype).toBe(false);
	});

	it("does not accept the retired context compaction command", () => {
		const command: RpcCommand = { type: "compact" };
		expect(command.type).toBe("compact");
	});
});
