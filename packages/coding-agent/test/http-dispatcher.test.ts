import { describe, expect, it } from "vitest";
import { createHttpDispatcherOptions } from "../src/core/http-dispatcher.ts";

describe("createHttpDispatcherOptions", () => {
	it("disables undici's default fixed connect timeout", () => {
		expect(createHttpDispatcherOptions(123_456)).toEqual({
			allowH2: false,
			connectTimeout: 0,
			bodyTimeout: 123_456,
			headersTimeout: 123_456,
		});
	});
});
