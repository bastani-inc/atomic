import { describe, expect, it, vi } from "vitest";

const undiciMock = vi.hoisted(() => ({
	EnvHttpProxyAgent: vi.fn(function EnvHttpProxyAgent(this: { options?: unknown }, options: unknown) {
		this.options = options;
	}),
	install: vi.fn(),
	setGlobalDispatcher: vi.fn(),
}));

vi.mock("undici", () => undiciMock);

describe("configureHttpDispatcher", () => {
	it("disables undici's default fixed connect timeout", async () => {
		const { configureHttpDispatcher } = await import("../src/core/http-dispatcher.ts");

		configureHttpDispatcher(123_456);

		expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledWith({
			allowH2: false,
			connectTimeout: 0,
			bodyTimeout: 123_456,
			headersTimeout: 123_456,
		});
		expect(undiciMock.setGlobalDispatcher).toHaveBeenCalledTimes(1);
	});
});
