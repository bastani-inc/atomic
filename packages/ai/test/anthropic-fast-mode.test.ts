import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

interface CapturedRequest {
	headers: Headers;
	body: Record<string, unknown>;
}

function sseResponse(speed: "fast" | "standard" | undefined): Response {
	const usage = {
		input_tokens: 1_000_000,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		...(speed === undefined ? {} : { speed }),
	};
	const events = [
		{
			event: "message_start",
			data: { type: "message_start", message: { id: "msg_fast", model: "claude-opus-5-5", usage } },
		},
		{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } },
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { ...usage, output_tokens: 1_000_000 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function capturingFetch(
	captured: CapturedRequest[],
	speed: "fast" | "standard" | undefined,
): typeof globalThis.fetch {
	return async (_input, init) => {
		captured.push({
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		});
		return sseResponse(speed);
	};
}

function fastVariant(baseId: "claude-opus-5-5" | "claude-opus-5" | "claude-opus-4-8"): Model<"anthropic-messages"> {
	const base = getModel("anthropic", baseId);
	return {
		...base,
		id: `${baseId}-fast`,
		name: `${base.name} (fast)`,
		fastRoute: { baseModelId: baseId, upstreamModelId: baseId, speed: "fast" },
	};
}

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });

describe("Anthropic fast mode", () => {
	it("sends the base model with speed fast and the fast-mode beta while recording the -fast identity", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamAnthropic(fastVariant("claude-opus-5-5"), context, {
			apiKey: "sk-ant-api-test",
			fetch: capturingFetch(captured, "fast"),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured).toHaveLength(1);
		expect(captured[0]?.body.model).toBe("claude-opus-5-5");
		expect(captured[0]?.body.speed).toBe("fast");
		expect(captured[0]?.headers.get("anthropic-beta")?.split(",")).toContain("fast-mode-2026-02-01");
		expect(result.model).toBe("claude-opus-5-5-fast");
		expect(result.responseModel).toBeUndefined();
	});

	it("keeps the fast-mode beta for OAuth subscription requests", async () => {
		const captured: CapturedRequest[] = [];
		await streamAnthropic(fastVariant("claude-opus-5"), context, {
			apiKey: "sk-ant-oat-test",
			fetch: capturingFetch(captured, "fast"),
		}).result();

		const betas = captured[0]?.headers.get("anthropic-beta")?.split(",") ?? [];
		expect(betas).toContain("oauth-2025-04-20");
		expect(betas).toContain("fast-mode-2026-02-01");
		expect(captured[0]?.body.speed).toBe("fast");
	});

	it("sends neither speed nor the fast-mode beta for the normal model", async () => {
		const captured: CapturedRequest[] = [];
		await streamAnthropic(getModel("anthropic", "claude-opus-5-5"), context, {
			apiKey: "sk-ant-api-test",
			fetch: capturingFetch(captured, undefined),
		}).result();

		expect(captured[0]?.body.model).toBe("claude-opus-5-5");
		expect("speed" in (captured[0]?.body ?? {})).toBe(false);
		expect(captured[0]?.headers.get("anthropic-beta") ?? "").not.toContain("fast-mode");
	});

	// Opus 5.5 standard: $4 input / $20 output. Fast mode: $8 / $40.
	// https://platform.claude.com/docs/en/build-with-claude/fast-mode#pricing
	it("prices a fast response at the fast-mode rates", async () => {
		const result = await streamAnthropic(fastVariant("claude-opus-5-5"), context, {
			apiKey: "sk-ant-api-test",
			fetch: capturingFetch([], "fast"),
		}).result();

		expect(result.usage.cost.input).toBeCloseTo(8, 10);
		expect(result.usage.cost.output).toBeCloseTo(40, 10);
		expect(result.usage.cost.total).toBeCloseTo(48, 10);
	});

	it("prices at standard rates when the response reports standard speed", async () => {
		const result = await streamAnthropic(fastVariant("claude-opus-4-8"), context, {
			apiKey: "sk-ant-api-test",
			fetch: capturingFetch([], "standard"),
		}).result();

		expect(result.usage.cost.input).toBeCloseTo(5, 10);
		expect(result.usage.cost.output).toBeCloseTo(25, 10);
	});

	it("does not reprice a normal model", async () => {
		const result = await streamAnthropic(getModel("anthropic", "claude-opus-5-5"), context, {
			apiKey: "sk-ant-api-test",
			fetch: capturingFetch([], "standard"),
		}).result();

		expect(result.usage.cost.total).toBeCloseTo(24, 10);
	});

	it.each([
		["model", (payload: Record<string, unknown>) => ({ ...payload, model: "claude-opus-4-8" })],
		["speed", (payload: Record<string, unknown>) => ({ ...payload, speed: "standard" })],
	] as const)("refuses a payload hook that rewrites the route-owned %s", async (field, rewrite) => {
		const captured: CapturedRequest[] = [];
		const result = await streamAnthropic(fastVariant("claude-opus-5-5"), context, {
			apiKey: "sk-ant-api-test",
			fetch: capturingFetch(captured, "fast"),
			onPayload: (payload) => rewrite(payload as Record<string, unknown>),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(`changed ${field}`);
		expect(result.errorMessage).toContain('"anthropic/claude-opus-5-5"');
		expect(captured).toHaveLength(0);
	});
});
