import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";

/**
 * Anthropic gates newer models on the `claude-cli/<version>` user agent alone. Sending a version
 * below a model's floor is rejected with `claude_code_version_too_old`, which is how OAuth
 * requests for `claude-fable-5-1` failed while this provider advertised `2.1.75`.
 *
 * These assertions run against the real SDK with an injected `fetch`, so they read the headers as
 * they go on the wire — after the SDK's `Headers` normalization collapses the case-sensitive
 * `User-Agent`/`user-agent` pair that `mergeClientHeaders` produces. That is strictly stronger
 * than inspecting `defaultHeaders`, because it also proves exactly one user agent is sent.
 *
 * The version is asserted by value rather than by importing the constant; importing it would make
 * the test tautological and it would keep passing at `2.1.75`.
 */

/** The lowest Claude Code version Anthropic accepts for `claude-fable-5-1`. */
const MINIMUM_CLAUDE_CODE_VERSION = [2, 1, 251] as const;

/** The stale version that Anthropic rejected with `claude_code_version_too_old`. */
const REJECTED_CLAUDE_CODE_VERSION = "2.1.75";

const CLAUDE_CLI_USER_AGENT = /^claude-cli\/(\d+)\.(\d+)\.(\d+)$/;

const context: Context = {
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

const fableModel: Model<"anthropic-messages"> = {
	id: "claude-fable-5-1",
	name: "Claude Fable 5.1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function sseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_ua", usage: { input_tokens: 1, output_tokens: 0 } },
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		})}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");

	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Runs one request through the real SDK and returns the headers it actually put on the wire. */
async function captureWireHeaders(apiKey: string): Promise<Headers> {
	let captured: Headers | undefined;
	const result = streamAnthropic(fableModel, context, {
		apiKey,
		fetch: async (input, init) => {
			captured = new Request(input, init).headers;
			return sseResponse();
		},
	});
	await result.result();
	if (!captured) throw new Error("the injected fetch was never called");
	return captured;
}

function parseVersion(userAgent: string): [number, number, number] {
	const match = CLAUDE_CLI_USER_AGENT.exec(userAgent);
	if (!match) throw new Error(`user agent is not a claude-cli version: ${userAgent}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
	for (let i = 0; i < minimum.length; i++) {
		const left = actual[i] ?? 0;
		const right = minimum[i] ?? 0;
		if (left !== right) return left > right;
	}
	return true;
}

describe("Anthropic OAuth Claude Code user agent", () => {
	it("advertises a Claude Code version new enough for Fable 5.1", async () => {
		const headers = await captureWireHeaders("sk-ant-oat01-test-token");

		// A single `claude-cli/x.y.z` value. Two user agents would be joined with ", " by
		// `Headers` and fail this match, so this also pins the single-header property.
		const userAgent = headers.get("user-agent");
		expect(userAgent).toMatch(CLAUDE_CLI_USER_AGENT);

		// Encodes the server contract rather than the current constant, so a future bump still passes.
		const version = parseVersion(userAgent ?? "");
		expect(isAtLeast(version, MINIMUM_CLAUDE_CODE_VERSION)).toBe(true);
	});

	it("no longer sends the version Anthropic rejected as too old", async () => {
		const headers = await captureWireHeaders("sk-ant-oat01-test-token");

		expect(headers.get("user-agent")).not.toBe(`claude-cli/${REJECTED_CLAUDE_CODE_VERSION}`);
	});

	it("keeps the Claude Code identity headers alongside the user agent", async () => {
		const headers = await captureWireHeaders("sk-ant-oat01-test-token");

		// The fix must not be a retreat from the Claude Code identity the OAuth path maintains:
		// dropping the `claude-cli` user agent would also make the gate error disappear.
		expect(headers.get("x-app")).toBe("cli");
		expect(headers.get("anthropic-beta")).toContain("claude-code-20250219");
		expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
		expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-test-token");
	});

	it("leaves the API-key path on the pi user agent", async () => {
		const headers = await captureWireHeaders("sk-ant-api03-test-key");

		// Only the OAuth branch impersonates Claude Code; the API-key branch must be untouched.
		expect(headers.get("user-agent")).not.toMatch(CLAUDE_CLI_USER_AGENT);
		expect(headers.get("x-app")).toBeNull();
	});
});
