import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	type CachePrefixFingerprint,
	computeCachePrefixFingerprint,
	describeCachePrefixDifference,
	isCachePrefixFingerprint,
	reconstructMessageHashes,
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

/** One step in a fingerprint chain: the fingerprint plus its full reconstructed message-hash list. */
interface ChainStep {
	fingerprint: CachePrefixFingerprint;
	messageHashes: string[];
}

function firstStep(payload: unknown, model = MODEL): ChainStep {
	const fingerprint = computeCachePrefixFingerprint(payload, model);
	return { fingerprint, messageHashes: reconstructMessageHashes(fingerprint, []) };
}

function nextStep(payload: unknown, previous: ChainStep, model = MODEL): ChainStep {
	const fingerprint = computeCachePrefixFingerprint(payload, model, previous.messageHashes);
	return { fingerprint, messageHashes: reconstructMessageHashes(fingerprint, previous.messageHashes) };
}

function diff(previous: ChainStep | undefined, current: ChainStep): string {
	return describeCachePrefixDifference(previous?.fingerprint, previous?.messageHashes ?? [], current.fingerprint);
}

describe("computeCachePrefixFingerprint / describeCachePrefixDifference (#3261)", () => {
	it("reports 'prefix unchanged' with no previous fingerprint", () => {
		const current = firstStep(basePayload());
		assert.equal(diff(undefined, current), "prefix unchanged");
	});

	it("reports 'model switched' when the model changes", () => {
		const previous = firstStep(basePayload());
		const current = nextStep(basePayload(), previous, { ...MODEL, modelId: "faux-2" });
		assert.equal(diff(previous, current), "model switched");
	});

	it("reports 'tool list changed: +mcp' when a tool named mcp is added", () => {
		const previous = firstStep(basePayload());
		const withMcp = {
			...basePayload(),
			tools: [...(basePayload().tools as unknown[]), { name: "mcp", description: "mcp tool", input_schema: {} }],
		};
		const current = nextStep(withMcp, previous);
		assert.equal(diff(previous, current), "tool list changed: +mcp");
	});

	it("reports 'tool list changed: -mcp' when a tool named mcp is removed", () => {
		const withMcp = {
			...basePayload(),
			tools: [...(basePayload().tools as unknown[]), { name: "mcp", description: "mcp tool", input_schema: {} }],
		};
		const previous = firstStep(withMcp);
		const current = nextStep(basePayload(), previous);
		assert.equal(diff(previous, current), "tool list changed: -mcp");
	});

	it("reports 'tool list changed' when an existing tool's declaration hash changes (#3261)", () => {
		const previous = firstStep(basePayload());
		const redefined = {
			...basePayload(),
			tools: [{ name: "read", description: "a very different description", input_schema: { extra: true } }],
		};
		const current = nextStep(redefined, previous);
		assert.equal(diff(previous, current), "tool list changed");
	});

	it("reports 'tool list changed' when the same tools are reordered (#3261)", () => {
		const first = { name: "read", description: "read tool", input_schema: {} };
		const second = { name: "mcp", description: "mcp tool", input_schema: {} };
		const previous = firstStep({ ...basePayload(), tools: [first, second] });
		const current = nextStep({ ...basePayload(), tools: [second, first] }, previous);
		assert.equal(diff(previous, current), "tool list changed");
	});

	it("reports 'system prompt changed' when the system prompt text changes", () => {
		const previous = firstStep(basePayload());
		const current = nextStep({ ...basePayload(), system: "You are different." }, previous);
		assert.equal(diff(previous, current), "system prompt changed");
	});

	it("reports 'request params changed' when a non-content field changes", () => {
		const previous = firstStep({ ...basePayload(), temperature: 0.2 });
		const current = nextStep({ ...basePayload(), temperature: 0.9 }, previous);
		assert.equal(diff(previous, current), "request params changed");
	});

	it("reports 'message 14 rewritten' for a 1-based rewritten message at index 13", () => {
		const messages = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `turn ${i}` }));
		const previous = firstStep({ ...basePayload(), messages });
		const rewritten = messages.map((message, index) =>
			index === 13 ? { ...message, content: "rewritten" } : message,
		);
		const current = nextStep({ ...basePayload(), messages: rewritten }, previous);
		assert.equal(diff(previous, current), "message 14 rewritten");
	});

	it("reports 'prefix unchanged' when only new messages are appended", () => {
		const previous = firstStep(basePayload());
		const appended = {
			...basePayload(),
			messages: [...(basePayload().messages as unknown[]), { role: "assistant", content: "reply" }],
		};
		const current = nextStep(appended, previous);
		assert.equal(diff(previous, current), "prefix unchanged");
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
		assert.deepEqual(current.messageChanges, previous.messageChanges);
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

	it("keeps an OpenAI Responses/Codex payload's prefix stable across append-only turns (#3261)", () => {
		const payload = {
			model: "gpt-5",
			instructions: "sys",
			input: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", name: "read" }],
			prompt_cache_key: "k",
		};
		const previous = firstStep(payload);
		const appended = { ...payload, input: [...payload.input, { role: "assistant", content: "x" }] };
		const current = nextStep(appended, previous);
		assert.equal(diff(previous, current), "prefix unchanged");
	});

	it("reports 'system prompt changed' for an OpenAI Responses/Codex instructions change (#3261)", () => {
		const payload = { model: "gpt-5", instructions: "sys", input: [{ role: "user", content: "hi" }] };
		const previous = firstStep(payload);
		const current = nextStep({ ...payload, instructions: "changed sys" }, previous);
		assert.equal(diff(previous, current), "system prompt changed");
	});

	it("reports 'message 1 rewritten' for an OpenAI Responses/Codex input rewrite (#3261)", () => {
		const payload = { model: "gpt-5", instructions: "sys", input: [{ role: "user", content: "hi" }] };
		const previous = firstStep(payload);
		const current = nextStep({ ...payload, input: [{ role: "user", content: "REWRITTEN" }] }, previous);
		assert.equal(diff(previous, current), "message 1 rewritten");
	});

	it("keeps a Google payload's prefix stable across append-only turns (#3261)", () => {
		const payload = {
			contents: [{ role: "user", parts: [{ text: "hi" }] }],
			config: { systemInstruction: "sys", tools: [{ functionDeclarations: [{ name: "read" }] }] },
		};
		const previous = firstStep(payload);
		const appended = { ...payload, contents: [...payload.contents, { role: "model", parts: [{ text: "x" }] }] };
		const current = nextStep(appended, previous);
		assert.equal(diff(previous, current), "prefix unchanged");
	});

	it("reports 'tool list changed: +search' for a Google function-declaration addition (#3261)", () => {
		const payload = {
			contents: [{ role: "user", parts: [{ text: "hi" }] }],
			config: { systemInstruction: "sys", tools: [{ functionDeclarations: [{ name: "read" }] }] },
		};
		const previous = firstStep(payload);
		const current = nextStep(
			{
				...payload,
				config: { ...payload.config, tools: [{ functionDeclarations: [{ name: "read" }, { name: "search" }] }] },
			},
			previous,
		);
		assert.equal(diff(previous, current), "tool list changed: +search");
	});

	it("reports 'tool list changed: +mcp' for a Bedrock toolConfig.tools addition (#3261)", () => {
		const payload = {
			modelId: "m",
			system: [{ text: "sys" }],
			messages: [{ role: "user", content: [{ text: "hi" }] }],
			toolConfig: { tools: [{ toolSpec: { name: "read" } }] },
		};
		const previous = firstStep(payload);
		const current = nextStep(
			{ ...payload, toolConfig: { tools: [...payload.toolConfig.tools, { toolSpec: { name: "mcp" } }] } },
			previous,
		);
		assert.equal(diff(previous, current), "tool list changed: +mcp");
	});

	it("reports 'system prompt changed' for a Chat Completions developer-role instruction change (#3261)", () => {
		const payload = {
			model: "m",
			messages: [
				{ role: "developer", content: "sys" },
				{ role: "user", content: "hi" },
			],
		};
		const previous = firstStep(payload);
		const current = nextStep(
			{ ...payload, messages: [{ role: "developer", content: "sys2" }, payload.messages[1]] },
			previous,
		);
		assert.equal(diff(previous, current), "system prompt changed");
	});

	it("ignores a Bedrock cachePoint marker that moves position between requests (#3261)", () => {
		const cachePoint = { cachePoint: { type: "default" } };
		const base = {
			modelId: "anthropic.claude",
			system: [{ text: "sys" }, cachePoint],
			inferenceConfig: { maxTokens: 8000 },
			toolConfig: { tools: [{ toolSpec: { name: "read" } }, cachePoint] },
		};
		const previous = firstStep({ ...base, messages: [{ role: "user", content: [{ text: "hi" }, cachePoint] }] });
		const current = nextStep(
			{
				...base,
				messages: [
					{ role: "user", content: [{ text: "hi" }] },
					{ role: "assistant", content: [{ text: "ok" }] },
					{ role: "user", content: [{ text: "next" }, cachePoint] },
				],
			},
			previous,
		);
		assert.equal(diff(previous, current), "prefix unchanged");
	});

	it("keeps the persisted fingerprint size bounded per request as a session grows to thousands of messages (#3261)", () => {
		let step: ChainStep | undefined;
		const sizes: number[] = [];
		for (let turnCount = 1; turnCount <= 2000; turnCount++) {
			const messages = Array.from({ length: turnCount }, (_, i) => ({ role: "user", content: `turn ${i}` }));
			step = step ? nextStep({ ...basePayload(), messages }, step) : firstStep({ ...basePayload(), messages });
			sizes.push(JSON.stringify(step.fingerprint).length);
		}
		// Every ordinary append-only turn adds exactly one message, so its persisted delta —
		// unlike a full per-request message-hash array — must stay a small constant, not grow
		// with total history length. The prior (unbounded) implementation measured ~20,754
		// bytes at 1,000 messages alone (per the #3261 review).
		const sizeAtTurn1000 = sizes[999];
		const sizeAtTurn2000 = sizes[1999];
		assert.ok(sizeAtTurn1000 < 500, `expected a small per-turn delta at turn 1000, got ${sizeAtTurn1000} bytes`);
		assert.ok(
			sizeAtTurn2000 < sizeAtTurn1000 * 2,
			`expected turn 2000's delta size (${sizeAtTurn2000}) not to have grown proportionally to history length since turn 1000 (${sizeAtTurn1000})`,
		);
	});

	it("reports the exact rewritten message index no matter how far back in a long history it is (#3261)", () => {
		let step: ChainStep | undefined;
		for (let turnCount = 1; turnCount <= 500; turnCount++) {
			const messages = Array.from({ length: turnCount }, (_, i) => ({ role: "user", content: `turn ${i}` }));
			step = step ? nextStep({ ...basePayload(), messages }, step) : firstStep({ ...basePayload(), messages });
		}
		assert.ok(step);
		const rewriteIndex = 13; // message 14, far outside any fixed recency window
		const rewrittenMessages = Array.from({ length: 500 }, (_, i) =>
			i === rewriteIndex ? { role: "user", content: "REWRITTEN" } : { role: "user", content: `turn ${i}` },
		);
		const rewritten = nextStep({ ...basePayload(), messages: rewrittenMessages }, step);
		assert.equal(diff(step, rewritten), `message ${rewriteIndex + 1} rewritten`);
	});

	it("keeps reporting 'prefix unchanged' for a pure append across a long chained history (#3261)", () => {
		let step: ChainStep | undefined;
		for (let turnCount = 1; turnCount <= 500; turnCount++) {
			const messages = Array.from({ length: turnCount }, (_, i) => ({ role: "user", content: `turn ${i}` }));
			step = step ? nextStep({ ...basePayload(), messages }, step) : firstStep({ ...basePayload(), messages });
		}
		assert.ok(step);
		const appendedMessages = [
			...Array.from({ length: 500 }, (_, i) => ({ role: "user", content: `turn ${i}` })),
			{ role: "assistant", content: "turn 500" },
		];
		const appended = nextStep({ ...basePayload(), messages: appendedMessages }, step);
		assert.equal(diff(step, appended), "prefix unchanged");
	});

	it("maps the Radius pi-messages payload instead of reading it as a request params change (#3261)", () => {
		const head = { role: "system", content: "You are a test assistant.", toolsAdded: [{ name: "read" }] };
		const radius = (messages: unknown[], tools = head.toolsAdded) => ({
			model: "m",
			context: { messages: [{ ...head, toolsAdded: tools }, ...messages] },
			options: { maxTokens: 100, cacheRetention: "short", sessionId: "s" },
		});
		const first = firstStep(radius([{ role: "user", content: "1" }]));
		const appended = nextStep(
			radius([
				{ role: "user", content: "1" },
				{ role: "user", content: "2" },
			]),
			first,
		);
		assert.equal(diff(first, appended), "prefix unchanged");
		const rewritten = nextStep(
			radius([
				{ role: "user", content: "X" },
				{ role: "user", content: "2" },
			]),
			first,
		);
		assert.equal(diff(first, rewritten), "message 1 rewritten");
		const withMcp = nextStep(radius([{ role: "user", content: "1" }], [{ name: "read" }, { name: "mcp" }]), first);
		assert.equal(diff(first, withMcp), "tool list changed: +mcp");
	});

	it("reports 'request shape unknown' for a payload without a recognized message list (#3261)", () => {
		const first = firstStep({ model: "m", prompt: { turns: ["1"] }, temperature: 0 });
		const next = nextStep({ model: "m", prompt: { turns: ["1", "2"] }, temperature: 0 }, first);
		assert.equal(diff(first, next), "request shape unknown");
	});

	it("ignores per-request output-token limits when attributing a miss (#3261)", () => {
		const messages = [
			{ role: "user", content: "1" },
			{ role: "user", content: "2" },
		];
		const first = firstStep({ ...basePayload(), messages, max_tokens: 4096 });
		const appended = nextStep(
			{ ...basePayload(), messages: [...messages, { role: "user", content: "3" }], max_tokens: 1200 },
			first,
		);
		assert.equal(diff(first, appended), "prefix unchanged");
		const rewritten = nextStep(
			{ ...basePayload(), messages: [{ role: "user", content: "X" }, messages[1]], max_tokens: 800 },
			first,
		);
		assert.equal(diff(first, rewritten), "message 1 rewritten");
		const bedrock = (maxTokens: number) => ({
			modelId: "m",
			messages,
			inferenceConfig: { maxTokens, temperature: 0 },
		});
		assert.equal(
			diff(firstStep(bedrock(4096)), nextStep(bedrock(900), firstStep(bedrock(4096)))),
			"prefix unchanged",
		);
	});

	it("keeps entry size independent of history length when message 1 is rewritten on every request (#3261)", () => {
		const sizes = new Map<number, number>();
		let step: ChainStep | undefined;
		for (let turnCount = 1; turnCount <= 2000; turnCount++) {
			const messages = Array.from({ length: turnCount }, (_, i) => ({
				role: "user",
				content: i === 0 ? `rewrite ${turnCount}` : `turn ${i}`,
			}));
			step = step ? nextStep({ ...basePayload(), messages }, step) : firstStep({ ...basePayload(), messages });
			sizes.set(turnCount, JSON.stringify(step.fingerprint).length);
			if (turnCount > 1) assert.equal(step.fingerprint.messageChanges.length, 2);
		}
		const at100 = sizes.get(100) ?? 0;
		const at2000 = sizes.get(2000) ?? 0;
		assert.ok(at2000 - at100 <= 8, `entry grew from ${at100} to ${at2000} bytes`);
	});

	it("recovers the exact rewritten index from persisted sparse entries alone, as on resume (#3261)", () => {
		const persisted: CachePrefixFingerprint[] = [];
		let step: ChainStep | undefined;
		for (let turnCount = 1; turnCount <= 300; turnCount++) {
			const messages = Array.from({ length: turnCount }, (_, i) => ({
				role: "user",
				content: i === 0 ? `rewrite ${turnCount}` : `turn ${i}`,
			}));
			step = step ? nextStep({ ...basePayload(), messages }, step) : firstStep({ ...basePayload(), messages });
			persisted.push(JSON.parse(JSON.stringify(step.fingerprint)) as CachePrefixFingerprint);
		}
		let hashes: string[] = [];
		for (const fingerprint of persisted) hashes = reconstructMessageHashes(fingerprint, hashes);
		assert.deepEqual(hashes, step?.messageHashes);
		const rewritten = Array.from({ length: 300 }, (_, i) => ({
			role: "user",
			content: i === 0 ? "rewrite 300" : i === 13 ? "CHANGED" : `turn ${i}`,
		}));
		const current = computeCachePrefixFingerprint({ ...basePayload(), messages: rewritten }, MODEL, hashes);
		assert.equal(describeCachePrefixDifference(persisted.at(-1), hashes, current), "message 14 rewritten");
	});
});
