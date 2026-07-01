import { describe, expect, it } from "vitest";
import { createHttpDispatcherOptions } from "../src/core/http-dispatcher.ts";

describe("createHttpDispatcherOptions", () => {
	it("disables undici's default fixed connect timeout", () => {
		const options = createHttpDispatcherOptions(123_456);
		expect(options.allowH2).toBe(false);
		expect(options.connectTimeout).toBe(0);
		expect(options.bodyTimeout).toBe(123_456);
		expect(options.headersTimeout).toBe(123_456);
		// v0.80.3: attach undici error-suppressing factories so mid-stream
		// client errors do not crash the process.
		expect(typeof options.clientFactory).toBe("function");
		expect(typeof options.factory).toBe("function");
	});
});
