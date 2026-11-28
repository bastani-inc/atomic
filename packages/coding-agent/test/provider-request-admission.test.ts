import assert from "node:assert/strict";
import type { Api, Context, Model, StreamOptions } from "@bastani/atomic-ai";
import { streamSimple } from "@bastani/atomic-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import {
	configureProviderRequestBudget,
	recordProviderRateLimit,
	setProviderRequestGate,
	tryAdmitProviderRequest,
} from "../src/core/provider-rate-limits.ts";
import { admitProviderStream, assistantRetryAttempt } from "../src/core/provider-request-admission.ts";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function testModel(api: Api): Model<Api> {
	return {
		api,
		provider: "test-provider",
		id: "test-model",
		name: "Test model",
		baseUrl: "https://test.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1000,
	};
}

async function runStream(model: Model<Api>, options: StreamOptions & { [assistantRetryAttempt]?: boolean }) {
	const admitted = await admitProviderStream(model, { apiKey: "test-key", maxRetries: 0, ...options }, false);
	return admitted.run(() => streamSimple(model, context, admitted.options)).result();
}

function blockedGate() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	setProviderRequestGate(() => {
		entered.resolve();
		return release.promise;
	});
	return { entered: entered.promise, release: release.resolve };
}

function observe(promise: Promise<unknown>) {
	const outcomes: unknown[] = [];
	const done = promise.then(
		(result) => outcomes.push(result),
		(error: unknown) => outcomes.push(error),
	);
	return { outcomes, done };
}

describe("provider request admission (#6790)", () => {
	afterEach(() => {
		setProviderRequestGate(undefined);
		vi.useRealTimers();
	});

	it.each(["openai-completions", "google-generative-ai"])(
		"does not wait for an uncooperative %s gate after Esc (#6790)",
		async (api) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const gate = blockedGate();
			const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 500 }));
			const run = observe(runStream(testModel(api), { signal: controller.signal, fetch }));
			try {
				await gate.entered;
				controller.abort(new Error("Esc"));
				await vi.advanceTimersByTimeAsync(0);
				assert.equal(run.outcomes.length, 1, "admission is still waiting for the gate");
			} finally {
				gate.release();
				await run.done;
				assert.equal(fetch.mock.calls.length, 0);
			}
		},
	);

	it.each(["openai-completions", "google-generative-ai"])(
		"ends an uncooperative %s gate at an active retry deadline (#6790)",
		async (api) => {
			vi.useFakeTimers();
			const gate = blockedGate();
			const onExpired = vi.fn();
			const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 500 }));
			const run = observe(
				runStream(testModel(api), {
					retryDeadline: { at: performance.now() + 25, onExpired },
					[assistantRetryAttempt]: true,
					fetch,
				}),
			);
			try {
				await gate.entered;
				await vi.advanceTimersByTimeAsync(24);
				assert.equal(run.outcomes.length, 0);
				await vi.advanceTimersByTimeAsync(1);
				assert.equal(run.outcomes.length, 1, "admission outlived the retry deadline");
				assert.equal(onExpired.mock.calls.length, 1);
			} finally {
				gate.release();
				await run.done;
				assert.equal(fetch.mock.calls.length, 0);
			}
		},
	);

	it("bounds an initial gate independently of the HTTP request timeout (#6790)", async () => {
		vi.useFakeTimers();
		const gate = blockedGate();
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 500 }));
		const run = observe(runStream(testModel("google-generative-ai"), { timeoutMs: 25, fetch }));
		try {
			await gate.entered;
			await vi.advanceTimersByTimeAsync(25);
			assert.equal(run.outcomes.length, 0, "the HTTP timer started before admission");
			await vi.advanceTimersByTimeAsync(600_000 - 25);
			assert.equal(run.outcomes.length, 1, "the gate outlived the default admission limit");
			assert.match(String(run.outcomes[0]), /admission timed out/);
		} finally {
			gate.release();
			await run.done;
			assert.equal(fetch.mock.calls.length, 0);
		}
	});

	it("ends an SDK retry's gate wait at the running deadline without timing out its initial request (#6790)", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const release = Promise.withResolvers<void>();
		let admissions = 0;
		setProviderRequestGate(() => {
			if (++admissions > 1) return release.promise;
		});
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
			async () =>
				new Response(JSON.stringify({ error: { message: "transient" } }), {
					status: 500,
					headers: { "retry-after-ms": "5", "content-type": "application/json" },
				}),
		);
		const run = observe(
			runStream(testModel("openai-completions"), {
				signal: controller.signal,
				retryDeadline: performance.now() + 25,
				maxRetries: 1,
				fetch,
			}),
		);
		try {
			await vi.advanceTimersByTimeAsync(24);
			assert.equal(admissions, 2);
			assert.equal(run.outcomes.length, 0);
			await vi.advanceTimersByTimeAsync(1);
			assert.equal(run.outcomes.length, 1, "SDK retry admission outlived the retry deadline");
		} finally {
			controller.abort();
			release.resolve();
			await run.done;
			assert.equal(fetch.mock.calls.length, 1);
		}
	});

	it.each(["Esc", "request deadline", "observation deadline"] as const)(
		"does not get stuck reading a throttle response after %s (#6790)",
		async (endBy) => {
			vi.useFakeTimers();
			let readingBody: ReadableStreamDefaultController<Uint8Array> | undefined;
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>({
				start: (controller) => {
					readingBody = controller;
				},
				cancel: () => {
					cancelled = true;
				},
			});
			const controller = new AbortController();
			const model = testModel("openai-completions");
			const status = endBy === "request deadline" ? 402 : 429;
			const admitted = await admitProviderStream(
				model,
				{
					signal: controller.signal,
					timeoutMs: endBy === "observation deadline" ? 60_000 : 25,
					fetch: async () => new Response(body, { status, headers: { "retry-after": "60" } }),
				},
				false,
			);
			const run = observe(admitted.run(() => admitted.options.fetch!(model.baseUrl, { signal: controller.signal })));
			try {
				await vi.advanceTimersByTimeAsync(0);
				if (endBy === "Esc") controller.abort(new Error("Esc"));
				await vi.advanceTimersByTimeAsync(endBy === "request deadline" ? 25 : endBy === "Esc" ? 0 : 500);
				assert.equal(run.outcomes.length, 1, `response observation outlived ${endBy}`);
				const outcome = run.outcomes[0];
				if (endBy === "Esc") assert.equal(outcome, controller.signal.reason);
				else {
					assert.ok(outcome instanceof Response);
					assert.equal(outcome.status, status);
					assert.equal(outcome.headers.get("retry-after"), "60");
					assert.equal(await outcome.text(), "");
				}
				assert.equal(cancelled, true);
			} finally {
				if (!cancelled) readingBody?.close();
				await run.done;
			}
		},
	);

	it.each(["cooldown", "local budget"])(
		"ends an admission %s wait at an active retry deadline (#6790)",
		async (limit) => {
			vi.useFakeTimers();
			const model = testModel("google-generative-ai");
			if (limit === "cooldown") {
				recordProviderRateLimit(
					model.provider,
					{ status: 429, headers: new Headers({ "retry-after": "60" }) },
					model.id,
				);
			} else {
				configureProviderRequestBudget(model.provider, { maxRequests: 1, intervalMs: 60_000 });
				assert.equal(tryAdmitProviderRequest(model.provider, model.id), 0);
			}
			const controller = new AbortController();
			const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 500 }));
			const run = observe(
				runStream(model, {
					signal: controller.signal,
					retryDeadline: performance.now() + 25,
					[assistantRetryAttempt]: true,
					fetch,
				}),
			);
			try {
				await vi.advanceTimersByTimeAsync(24);
				assert.equal(run.outcomes.length, 0);
				await vi.advanceTimersByTimeAsync(1);
				assert.equal(run.outcomes.length, 1, "admission outlived the retry deadline");
			} finally {
				controller.abort();
				await run.done;
				assert.equal(fetch.mock.calls.length, 0);
			}
		},
	);
});
