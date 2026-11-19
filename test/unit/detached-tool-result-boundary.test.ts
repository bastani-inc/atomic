import assert from "node:assert/strict";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import {
	harnessPool,
	persistedManager,
	untilStarted,
	waitForCiTurn,
	waitTool,
} from "../../packages/coding-agent/test/helpers/detached-tools.ts";
import {
	isReleasedReplyHandoffResult,
	releasedReplyHandoffResult,
} from "../../packages/intercom/released-reply-wait.ts";
import { recordStageWaitToolResults, stageWaitToolResults } from "../../packages/workflows/src/shared/stage-wait.ts";
import {
	TOOL_PAYLOAD_TRUNCATION_MARKER,
	TOOL_PAYLOAD_VALUE_LIMIT,
} from "../../packages/workflows/src/shared/tool-payload-bounds.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

async function detached(redispatch: boolean) {
	const tool = waitTool();
	const { manager, store } = await persistedManager();
	const first = await pool.harnessWith([tool.definition], manager);
	first.session.setToolDetachment({ afterMs: 0 });
	first.setResponses([waitForCiTurn("ci-1")]);
	await first.session.prompt("watch CI");
	const [original] = first.session.takeDetachedToolCalls();
	assert.ok(original);
	const owner = redispatch
		? await pool.harnessWith([tool.definition], await SessionManager.open(store, manager.getSessionId()))
		: first;
	const call = redispatch ? owner.session.redispatchDetachedToolCalls()[0]! : original;
	await untilStarted(tool, redispatch ? 2 : 1);
	if (redispatch) {
		tool.finish(0, "old call");
		await original.result;
	}
	return {
		owner,
		finish: (result: AgentToolResult) => {
			tool.finishWith(redispatch ? 1 : 0, result);
			return call.result;
		},
	};
}

for (const redispatch of [false, true]) {
	for (const consumer of ["resume", "stage record"] as const) {
		test(`unreadable detached content becomes one error for ${consumer} (redispatched=${redispatch}, #5486)`, async () => {
			const { owner, finish } = await detached(redispatch);
			const result = await finish({
				get content(): never {
					throw new Error("cannot read tool output");
				},
				details: undefined,
			});
			assert.equal(result.isError, true, "the handle itself offers a readable error");
			if (consumer === "stage record") {
				assert.deepEqual(
					recordStageWaitToolResults([result]).map((x) => [x.toolCallId, x.isError]),
					[["ci-1", true]],
				);
			} else {
				owner.setResponses([fauxAssistantMessage("done")]);
				await owner.session.resumeDetachedTurn([result]);
				const saved = owner.sessionManager.buildSessionProjection().messages.filter((m) => m.role === "toolResult");
				assert.deepEqual(
					saved.map((x) => [x.toolCallId, x.isError]),
					[["ci-1", true]],
				);
			}
		});
	}
}

for (const consumer of ["resume", "stage record"] as const) {
	test(`unserializable nested details become one error at ${consumer} (#5486)`, async () => {
		const { owner, finish } = await detached(false);
		const handed = await finish({
			content: [{ type: "text", text: "ok" }],
			details: {
				get missing(): never {
					throw new Error("details unavailable");
				},
			},
		});
		if (consumer === "stage record") {
			assert.deepEqual(
				recordStageWaitToolResults([handed]).map((x) => [x.toolCallId, x.isError]),
				[["ci-1", true]],
			);
		} else {
			owner.setResponses([fauxAssistantMessage("done")]);
			await owner.session.resumeDetachedTurn([handed]);
			await owner.session.resumeDetachedTurn([handed]);
			const saved = owner.sessionManager.buildSessionProjection().messages.filter((m) => m.role === "toolResult");
			assert.deepEqual(
				saved.map((x) => [x.toolCallId, x.isError]),
				[["ci-1", true]],
			);
		}
	});
}

function changingSibling() {
	const skip = Object.assign(() => {}, {
		toJSON() {
			Object.defineProperty(details, "status", { enumerable: false });
			return undefined;
		},
	});
	const details = { skip, status: "green" };
	return details;
}

const raw = (text: string) => (JSON as typeof JSON & { rawJSON: (json: string) => object }).rawJSON(text);
const wireCases: [string, () => unknown][] = [
	["an omitted conversion changing a selected sibling", changingSibling],
	["a raw JSON scalar", () => ({ n: raw("12") })],
	[
		"a getter and a keyed conversion",
		() => ({
			get color() {
				return {
					toJSON(key: string) {
						return key;
					},
				};
			},
		}),
	],
	["an omitted function and symbol", () => ({ fn: () => 1, s: Symbol("not on wire"), kept: true })],
	["undefined", () => undefined],
	["a bigint", () => ({ bad: 2n })],
	[
		"a sparse array",
		() => {
			const array: unknown[] = [];
			array.length = 1;
			array.push(undefined, Symbol("missing"), () => {}, raw("false"));
			return array;
		},
	],
	[
		"a cycle",
		() => {
			const list: unknown[] = [];
			list.push(list);
			return list;
		},
	],
];
for (const [label, make] of wireCases) {
	test(`stage checkpoint and SDK resume agree with native JSON for ${label} (#5486)`, async () => {
		let expected: { isError: boolean; details: unknown };
		try {
			expected = { isError: false, details: JSON.parse(JSON.stringify({ details: make() })).details };
		} catch {
			expected = { isError: true, details: undefined };
		}
		for (const stage of [false, true]) {
			const { owner, finish } = await detached(false);
			const answer = await finish({
				content: [{ type: "text", text: "ok" }],
				details: make() as AgentToolResult["details"],
			});
			const results = stage
				? stageWaitToolResults(JSON.parse(JSON.stringify(recordStageWaitToolResults([answer]))))
				: [answer];
			owner.setResponses([fauxAssistantMessage("done")]);
			await owner.session.resumeDetachedTurn(results);
			const saved = owner.sessionManager.buildSessionProjection().messages.filter((m) => m.role === "toolResult");
			assert.deepEqual(
				saved.map((m) => ({ isError: m.isError, details: m.details })),
				[expected],
				stage ? "stage checkpoint" : "SDK resume",
			);
		}
	});
}

function stageMetadata(details: unknown) {
	return recordStageWaitToolResults([
		{
			toolCallId: "ci-1",
			toolName: "ci",
			isError: false,
			result: { content: [], details: details as AgentToolResult["details"] },
		},
	])[0]!;
}

test("a fitting stage checkpoint needs no extra member lists or identity comparisons (#5691)", () => {
	const data = Array.from({ length: 2048 }, (_, i) => i % 10);
	const answer = {
		toolCallId: "ci",
		toolName: "watch",
		isError: false,
		result: { content: [], details: data, structuredContent: data },
	};
	const push = Array.prototype.push;
	const is = Object.is;
	let pushed = 0;
	let compared = 0;
	let record: ReturnType<typeof recordStageWaitToolResults>[number] | undefined;
	try {
		Array.prototype.push = function (...items) {
			pushed += items.length;
			return push.apply(this, items);
		};
		Object.is = (a, b) => {
			compared++;
			return is(a, b);
		};
		[record] = recordStageWaitToolResults([answer]);
	} finally {
		Array.prototype.push = push;
		Object.is = is;
	}
	assert.deepEqual(record?.details, data);
	assert.deepEqual(record?.structuredContent, data);
	assert.deepEqual([pushed, compared], [0, 0]);
});

test("stage checkpoints reject object proxies before enumerating any of their keys (#5486)", () => {
	let enumerations = 0;
	const proxy = new Proxy(
		{},
		{
			ownKeys() {
				enumerations++;
				return Array.from({ length: 100_000 }, (_, i) => String(i));
			},
		},
	);
	assert.equal(stageMetadata(proxy).isError, true);
	assert.equal(stageMetadata({ nested: proxy }).isError, true);
	let reads = 0;
	let conversions = 0;
	const converted = new Proxy(
		{
			toJSON: () => {
				conversions++;
				return "plain";
			},
		},
		{
			ownKeys() {
				enumerations++;
				return [];
			},
		},
	);
	let earlierReads = 0;
	assert.equal(
		stageMetadata({
			get first() {
				earlierReads++;
				return 1;
			},
			nested: converted,
		}).isError,
		true,
	);
	assert.deepEqual(
		[earlierReads, conversions],
		[0, 0],
		"reject a visible data-property proxy before reading any member",
	);
	const viaGetter = stageMetadata({
		get nested() {
			assert.equal(++reads, 1);
			return converted;
		},
	});
	assert.deepEqual([viaGetter.isError, viaGetter.details, reads, conversions], [false, { nested: "plain" }, 1, 1]);
	assert.equal(enumerations, 0);
});

test("boxed and plain oversized strings stop a checkpoint before it reads the next member (#5486)", () => {
	const huge = "x".repeat(20_000);
	for (const value of [huge, Object(huge)]) {
		let reads = 0;
		const answer = stageMetadata({
			large: value,
			get later() {
				reads++;
				throw new Error("past byte cutoff");
			},
		});
		assert.deepEqual([answer.isError, answer.details, reads], [false, TOOL_PAYLOAD_TRUNCATION_MARKER, 0]);
	}
	const expected = stageMetadata(huge).details;
	assert.equal(stageMetadata(Object(huge)).details, expected);
	let calls = 0;
	const shrinks = Object.assign(Object(huge), {
		[Symbol.toPrimitive]() {
			calls++;
			return "small";
		},
	});
	assert.deepEqual(
		[stageMetadata(shrinks).details, calls],
		[expected, 0],
		"accounting uses the intrinsic, not a user hook",
	);
});

test("boxed-string custom conversion runs once and its actual oversized output keeps a bounded prefix (#5486)", () => {
	let calls = 0;
	const actual = '🟢\\"tail'.repeat(10_000);
	const small = Object.assign(Object("seed"), {
		[Symbol.toPrimitive]() {
			calls++;
			return actual;
		},
	});
	const result = stageMetadata(small);
	assert.equal(calls, 1);
	assert.equal(result.isError, false);
	assert.ok(
		typeof result.details === "string" &&
			result.details.startsWith("🟢") &&
			result.details.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER),
	);
	assert.ok(actual.startsWith(result.details.slice(0, -TOOL_PAYLOAD_TRUNCATION_MARKER.length)));
	assert.ok(Buffer.byteLength(JSON.stringify(result.details)) <= TOOL_PAYLOAD_VALUE_LIMIT);
});

test("a 100,000-key plain object is truncated as a leaf without reading its values or losing its sibling (#5486)", () => {
	const wide: Record<string, unknown> = {};
	let reads = 0;
	Object.defineProperty(wide, "first", {
		enumerable: true,
		get() {
			reads++;
			throw new Error("past width cutoff");
		},
	});
	for (let i = 1; i < 100_000; i++) wide[`k${i}`] = i;
	const record = stageMetadata({ wide, after: "still here" });
	assert.deepEqual(
		[record.isError, record.details, reads],
		[false, { wide: TOOL_PAYLOAD_TRUNCATION_MARKER, after: "still here" }, 0],
	);
});

test("the checkpoint byte cutoff keeps a bounded string prefix and never repeats a getter or conversion (#5486)", () => {
	let conversions = 0;
	const huge = "🍀\n".repeat(TOOL_PAYLOAD_VALUE_LIMIT);
	const record = stageMetadata({
		toJSON(key: string) {
			assert.equal(key, "details");
			conversions++;
			return huge;
		},
	});
	assert.equal(conversions, 1);
	assert.equal(record.isError, false);
	assert.equal(typeof record.details, "string");
	assert.ok(String(record.details).startsWith("🍀\n"));
	assert.ok(String(record.details).endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER));
	assert.ok(Buffer.byteLength(JSON.stringify(record.details)) <= TOOL_PAYLOAD_VALUE_LIMIT);
	let reads = 0;
	const nested = stageMetadata({
		get large() {
			assert.equal(++reads, 1);
			return huge;
		},
	});
	assert.deepEqual([nested.isError, nested.details, reads], [false, TOOL_PAYLOAD_TRUNCATION_MARKER, 1]);
	const exact = "x".repeat(TOOL_PAYLOAD_VALUE_LIMIT - 2);
	assert.equal(stageMetadata(exact).details, exact);
});

test("stage checkpoints preserve JSON conversions at the containing field, object key and array index (#5486)", () => {
	const under = (expected: string, value: unknown) => ({
		toJSON(key: string) {
			assert.equal(key, expected);
			return value;
		},
	});
	const metadata = {
		details: under("details", {
			color: under("color", "blue"),
			omit: under("omit", undefined),
			list: [under("0", undefined), under("1", "one")],
		}),
		structuredContent: under("structuredContent", "done"),
	};
	const input = {
		toolCallId: "ci-1",
		toolName: "ci",
		isError: false,
		result: { content: [], ...metadata } as unknown as AgentToolResult,
	};
	const [record] = recordStageWaitToolResults([input]);
	assert.equal(record?.isError, false);
	assert.deepEqual(
		{ details: record?.details, structuredContent: record?.structuredContent },
		JSON.parse(JSON.stringify(metadata)),
	);
});

test("stage recording keeps JSON wrapper values and own metadata keys, and rejects an unrepresentable boxed bigint (#5486)", () => {
	const record = (details: unknown) =>
		recordStageWaitToolResults([
			{
				toolCallId: "ci-1",
				toolName: "ci",
				isError: false,
				result: { content: [], details: details as AgentToolResult["details"] },
			},
		])[0]!;
	const list = new Proxy(["item"], {
		get(target, key, receiver) {
			return key === "length" ? "1" : Reflect.get(target, key, receiver);
		},
	});
	const valid = { count: Object(3), enabled: Object(false), label: Object("CI"), list, ["__proto__"]: "metadata" };
	assert.deepEqual(record(valid).details, JSON.parse(JSON.stringify(valid)));
	assert.equal(record({ count: Object(3n) }).isError, true);
});

test("a cyclic result fails once after checkpointing and resuming its stage (#5486)", async () => {
	const { owner, finish } = await detached(false);
	const details: { self?: typeof details } = {};
	details.self = details;
	const answer = await finish({ content: [{ type: "text", text: "ok" }], details });
	const records = recordStageWaitToolResults([answer]);
	const restored = stageWaitToolResults(JSON.parse(JSON.stringify(records)));
	owner.setResponses([fauxAssistantMessage("done")]);
	await owner.session.resumeDetachedTurn(restored);
	const saved = owner.sessionManager.buildSessionProjection().messages.filter((m) => m.role === "toolResult");
	assert.deepEqual(
		saved.map((m) => [m.toolCallId, m.isError]),
		[["ci-1", true]],
	);
});

test("detachment reads stateful content and its text only once before handing it to the host (#5486)", async () => {
	const { owner, finish } = await detached(false);
	let contentReads = 0,
		textReads = 0;
	const result = await finish({
		get content() {
			assert.equal(++contentReads, 1);
			return [
				{
					type: "text" as const,
					get text() {
						assert.equal(++textReads, 1);
						return "safe";
					},
				},
			];
		},
		details: undefined,
	});
	assert.equal(result.isError, false);
	assert.deepEqual(recordStageWaitToolResults([result])[0]?.content, [{ type: "text", text: "safe" }]);
	owner.setResponses([fauxAssistantMessage("done")]);
	await owner.session.resumeDetachedTurn([result]);
	assert.deepEqual([contentReads, textReads], [1, 1]);
});

test("an SDK host can resume an unreadable result from across a process boundary (#5486)", async () => {
	const { owner, finish } = await detached(false);
	const handed = await finish({ content: [], details: undefined });
	const raw = {
		...handed,
		get result(): never {
			throw new Error("external payload unavailable");
		},
	};
	owner.setResponses([fauxAssistantMessage("done")]);
	await owner.session.resumeDetachedTurn([raw]);
	const saved = owner.sessionManager.buildSessionProjection().messages.filter((m) => m.role === "toolResult");
	assert.deepEqual(
		saved.map((x) => [x.toolCallId, x.isError]),
		[["ci-1", true]],
	);
});

test("a plain host result keeps its identity and the Intercom release marker (#5486)", async () => {
	const { finish } = await detached(false);
	const original = releasedReplyHandoffResult();
	const handed = await finish(original);
	assert.equal(handed.result, original);
	assert.ok(isReleasedReplyHandoffResult(handed.result.details));
});
