import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/utils/management-http.ts";

afterEach(() => vi.restoreAllMocks());

describe("fetchWithRetry", () => {
	it("retries transient transport failures", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ ok: true }));

		const response = await fetchWithRetry("https://example.test");

		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("shares one timeout budget across attempts", async () => {
		const signals: AbortSignal[] = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			if (signals.length === 1) throw new Error("fetch failed");
			return Response.json({ ok: true });
		});

		const response = await fetchWithRetry("https://example.test", undefined, { timeoutMs: 1000 });

		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(signals[0]).toBe(signals[1]);
	});

	it("retries transient HTTP responses and returns the successful response", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(Response.json({ ok: true }));

		const response = await fetchWithRetry("https://example.test");

		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await expect(fetchWithRetry("https://example.test", { signal: controller.signal })).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("waits retryDelayMs before each retry and hands the callback what failed", async () => {
		const transportError = new Error("fetch failed");
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "0" } }))
			.mockRejectedValueOnce(transportError)
			.mockResolvedValueOnce(Response.json({ ok: true }));
		const calls: { attempt: number; status?: number; error?: unknown }[] = [];
		const started = Date.now();

		const response = await fetchWithRetry("https://example.test", undefined, {
			retryDelayMs: (attempt, retryResponse, error) => {
				calls.push({ attempt, status: retryResponse?.status, error });
				return 25;
			},
		});

		expect(response.ok).toBe(true);
		expect(calls).toEqual([
			{ attempt: 0, status: 503, error: undefined },
			{ attempt: 1, status: undefined, error: transportError },
		]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(45);
	});

	it("ends the loop with the callback's own error when it throws", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 503 }));
		const stop = new Error("stop here");

		await expect(
			fetchWithRetry("https://example.test", undefined, {
				retryDelayMs: () => {
					throw stop;
				},
			}),
		).rejects.toBe(stop);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("abandons a retry wait when the caller aborts, surfacing the caller's reason", async () => {
		const controller = new AbortController();
		const reason = new Error("caller gave up");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 503 }));
		setTimeout(() => controller.abort(reason), 10);

		await expect(
			fetchWithRetry("https://example.test", { signal: controller.signal }, { retryDelayMs: () => 10_000 }),
		).rejects.toBe(reason);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
