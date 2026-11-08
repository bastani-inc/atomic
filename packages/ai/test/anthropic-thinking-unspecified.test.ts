import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const sent = vi.hoisted(() => ({ params: undefined as Record<string, unknown> | undefined }));

vi.mock("@anthropic-ai/sdk", () => {
	function endOfTurn(): Response {
		const events = [
			{ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		withOptions() {
			return this;
		}
		beta = {
			messages: {
				create: (params: Record<string, unknown>) => {
					sent.params = params;
					return { asResponse: async () => endOfTurn() };
				},
			},
		};
	}

	return { default: FakeAnthropic };
});

const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });

beforeEach(() => {
	vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "fdrl_test");
	vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", "org-test");
	vi.stubEnv("ANTHROPIC_IDENTITY_TOKEN_FILE", "/tmp/identity.jwt");
});

afterEach(() => {
	vi.unstubAllEnvs();
	sent.params = undefined;
});

describe("Anthropic requests that leave thinking unspecified (#4545)", () => {
	it.each<[string, Model<"anthropic-messages">, string | undefined]>([
		["a managed-effort model, at the default high marker", getModel("anthropic", "claude-opus-5-5"), "high"],
		["an adaptive model, with no effort", getModel("anthropic", "claude-opus-4-8"), undefined],
	])("keeps the API default for %s when a low-level request passes no options", async (_case, model, marker) => {
		const reply = await streamAnthropic(model, context).result();

		expect(reply.stopReason, reply.errorMessage).toBe("stop");
		const messages = sent.params?.messages as Array<{ role: string; output_config?: { effort: string } }>;
		expect(messages.at(-1)?.output_config?.effort).toBe(marker);
		expect(sent.params?.thinking).not.toEqual({ type: "disabled" });
		expect(reply.diagnostics ?? []).toEqual([]);
	});
});
