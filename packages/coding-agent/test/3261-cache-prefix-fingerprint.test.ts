import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	computeCachePrefixFingerprint,
	describeCachePrefixDifference,
	isCachePrefixFingerprint,
} from "../src/core/cache-prefix-fingerprint.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };

function basePayload(): Record<string, unknown> {
	return {
		model: "faux-1",
		system: "You are a test assistant.",
		tools: [{ name: "read", description: "read tool", input_schema: {} }],
		messages: [{ role: "user", content: "hello" }],
	};
}

describe("computeCachePrefixFingerprint / describeCachePrefixDifference (#3261)", () => {
	it("reports 'prefix unchanged' with no previous fingerprint", () => {
		const current = computeCachePrefixFingerprint(basePayload(), MODEL);
		assert.equal(describeCachePrefixDifference(undefined, current), "prefix unchanged");
	});

	it("reports 'model switched' when the model changes", () => {
		const previous = computeCachePrefixFingerprint(basePayload(), MODEL);
		const current = computeCachePrefixFingerprint(basePayload(), { ...MODEL, modelId: "faux-2" });
		assert.equal(describeCachePrefixDifference(previous, current), "model switched");
	});

	it("reports 'tool list changed: +mcp' when a tool named mcp is added", () => {
		const previous = computeCachePrefixFingerprint(basePayload(), MODEL);
		const withMcp = {
			...basePayload(),
			tools: [...(basePayload().tools as unknown[]), { name: "mcp", description: "mcp tool", input_schema: {} }],
		};
		const current = computeCachePrefixFingerprint(withMcp, MODEL);
		assert.equal(describeCachePrefixDifference(previous, current), "tool list changed: +mcp");
	});

	it("reports 'tool list changed: -mcp' when a tool named mcp is removed", () => {
		const withMcp = {
			...basePayload(),
			tools: [...(basePayload().tools as unknown[]), { name: "mcp", description: "mcp tool", input_schema: {} }],
		};
		const previous = computeCachePrefixFingerprint(withMcp, MODEL);
		const current = computeCachePrefixFingerprint(basePayload(), MODEL);
		assert.equal(describeCachePrefixDifference(previous, current), "tool list changed: -mcp");
	});

	it("reports 'tool list changed' when an existing tool's declaration hash changes (#3261)", () => {
		const previous = computeCachePrefixFingerprint(basePayload(), MODEL);
		const redefined = {
			...basePayload(),
			tools: [{ name: "read", description: "a very different description", input_schema: { extra: true } }],
		};
		const current = computeCachePrefixFingerprint(redefined, MODEL);
		assert.equal(describeCachePrefixDifference(previous, current), "tool list changed");
	});

	it("reports 'tool list changed' when the same tools are reordered (#3261)", () => {
		const first = { name: "read", description: "read tool", input_schema: {} };
		const second = { name: "mcp", description: "mcp tool", input_schema: {} };
		const previous = computeCachePrefixFingerprint({ ...basePayload(), tools: [first, second] }, MODEL);
		const current = computeCachePrefixFingerprint({ ...basePayload(), tools: [second, first] }, MODEL);
		assert.equal(describeCachePrefixDifference(previous, current), "tool list changed");
	});

	it("reports 'system prompt changed' when the system prompt text changes", () => {
		const previous = computeCachePrefixFingerprint(basePayload(), MODEL);
		const current = computeCachePrefixFingerprint({ ...basePayload(), system: "You are different." }, MODEL);
		assert.equal(describeCachePrefixDifference(previous, current), "system prompt changed");
	});

	it("reports 'request params changed' when a non-content field changes", () => {
		const previous = computeCachePrefixFingerprint({ ...basePayload(), temperature: 0.2 }, MODEL);
		const current = computeCachePrefixFingerprint({ ...basePayload(), temperature: 0.9 }, MODEL);
		assert.equal(describeCachePrefixDifference(previous, current), "request params changed");
	});

	it("reports 'message 14 rewritten' for a 1-based rewritten message at index 13", () => {
		const messages = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `turn ${i}` }));
		const previous = computeCachePrefixFingerprint({ ...basePayload(), messages }, MODEL);
		const rewritten = messages.map((message, index) =>
			index === 13 ? { ...message, content: "rewritten" } : message,
		);
		const current = computeCachePrefixFingerprint({ ...basePayload(), messages: rewritten }, MODEL);
		assert.equal(describeCachePrefixDifference(previous, current), "message 14 rewritten");
	});

	it("reports 'prefix unchanged' when only new messages are appended", () => {
		const previous = computeCachePrefixFingerprint(basePayload(), MODEL);
		const appended = {
			...basePayload(),
			messages: [...(basePayload().messages as unknown[]), { role: "assistant", content: "reply" }],
		};
		const current = computeCachePrefixFingerprint(appended, MODEL);
		assert.equal(describeCachePrefixDifference(previous, current), "prefix unchanged");
	});

	it("ignores Anthropic cache_control breakpoint markers at any depth", () => {
		const noBreakpoints = {
			...basePayload(),
			system: [{ type: "text", text: "You are a test assistant." }],
			tools: [{ name: "read", description: "read tool", input_schema: {} }],
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		};
		const previous = computeCachePrefixFingerprint(noBreakpoints, MODEL);
		const withBreakpoints = {
			...basePayload(),
			system: [{ type: "text", text: "You are a test assistant.", cache_control: { type: "ephemeral" } }],
			tools: [{ name: "read", description: "read tool", input_schema: {}, cache_control: { type: "ephemeral" } }],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
				},
			],
		};
		const current = computeCachePrefixFingerprint(withBreakpoints, MODEL);
		assert.equal(current.systemHash, previous.systemHash);
		assert.deepEqual(current.messageHashes, previous.messageHashes);
		assert.equal(current.tools[0]?.hash, previous.tools[0]?.hash);
	});

	it("never carries prompt content, tool schemas, or message content in the fingerprint", () => {
		const current = computeCachePrefixFingerprint(basePayload(), MODEL);
		const serialized = JSON.stringify(current);
		assert.ok(!serialized.includes("You are a test assistant."));
		assert.ok(!serialized.includes("hello"));
		assert.ok(!serialized.includes("read tool"));
		assert.ok(isCachePrefixFingerprint(current));
	});
});
