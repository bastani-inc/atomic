import { describe, expect, it } from "vitest";
import { createRpcClientProcessEnvironment } from "../src/modes/rpc/rpc-client-process.ts";

describe("Node compile cache child environment", () => {
	it("preserves an explicit cache directory for the isolated engine", () => {
		const env = createRpcClientProcessEnvironment(undefined, {
			NODE_COMPILE_CACHE: "C:\\atomic-cache",
			PATH: "fixture-path",
		});

		expect(env.NODE_COMPILE_CACHE).toBe("C:\\atomic-cache");
		expect(env.PATH).toBe("fixture-path");
	});

	it("preserves the Node coverage-safe compile-cache opt-out", () => {
		const env = createRpcClientProcessEnvironment(undefined, {
			NODE_DISABLE_COMPILE_CACHE: "1",
		});

		expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
	});
});
