import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { parseJsonChain, serializeJsonChain } from "../../packages/subagents/src/agents/chain-serializer.js";
import { ChainOutputValidationError, validateChainOutputBindings } from "../../packages/subagents/src/runs/shared/chain-outputs.js";
import {
	DynamicFanoutError,
	collectDynamicResults,
	materializeDynamicParallelStep,
	resolveJsonPointer,
	validateDynamicCollection,
} from "../../packages/subagents/src/runs/shared/dynamic-fanout.js";
import type { ChainStep } from "../../packages/subagents/src/shared/settings.js";
import type { ChainOutputMap, SingleResult } from "../../packages/subagents/src/shared/types.js";

const outputs: ChainOutputMap = {
	targets: {
		text: "{\"items\":[{\"path\":\"src/a.ts\"},{\"path\":\"src/b.ts\"}]}",
		structured: { items: [{ path: "src/a.js" }, { path: "src/b.js" }] },
		agent: "scout",
		stepIndex: 0,
	},
};

describe("dynamic fanout helpers", () => {
	test("resolves JSON Pointers and materializes item templates", () => {
		assert.deepEqual(resolveJsonPointer({ items: [1, 2] }, "/items/1", "path"), 2);
		const step: ChainStep = {
			expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {target.path}", label: "Review {target.path}" },
			collect: { as: "reviews" },
		};
		const materialized = materializeDynamicParallelStep(step, outputs, 1);
		assert.deepEqual(materialized.items.map((item) => item.key), ["src/a.js", "src/b.js"]);
		assert.deepEqual(materialized.parallel.map((task) => task.task), ["Review src/a.js", "Review src/b.js"]);
		assert.deepEqual(materialized.parallel.map((task) => task.label), ["Review src/a.js", "Review src/b.js"]);
	});

	test("rejects missing structured sources, over-limit arrays, duplicate keys, colliding ids, and bad templates", () => {
		const base: ChainStep = {
			expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {target.path}" },
			collect: { as: "reviews" },
		};
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, expand: { ...base.expand, maxItems: 1 } }, outputs, 1),
			/exceeding maxItems/,
		);
		assert.throws(
			() => materializeDynamicParallelStep(base, { targets: { text: "plain", agent: "scout", stepIndex: 0 } }, 1),
			/requires structured output/,
		);
		assert.throws(
			() => materializeDynamicParallelStep(base, { targets: { ...outputs.targets, structured: { items: [{ path: "x" }, { path: "x" }] } } }, 1),
			/duplicate item key/,
		);
		assert.throws(
			() => materializeDynamicParallelStep(base, { targets: { ...outputs.targets, structured: { items: [{ path: "a/b" }, { path: "a-b" }] } } }, 1),
			/colliding item id/,
		);
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, parallel: { agent: "reviewer", task: "Review {other.path}" } }, outputs, 1),
			/Unsupported template reference/,
		);
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, parallel: { agent: "reviewer", task: "Review {target[path]}" } }, outputs, 1),
			/Invalid item reference/,
		);
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, parallel: { agent: "reviewer", task: "Review {target.path" } }, outputs, 1),
			/Invalid item reference/,
		);
	});

	test("allows config maxItems defaults and handles empty arrays deterministically", () => {
		const base: ChainStep = {
			expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path" },
			parallel: { agent: "reviewer", task: "Review {target.path}" },
			collect: { as: "reviews" },
		};
		const materialized = materializeDynamicParallelStep(base, outputs, 1, { maxItems: 4 });
		assert.equal(materialized.parallel.length, 2);
		assert.doesNotThrow(() => validateChainOutputBindings([
			{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
			base,
		], { maxItems: 4 }));
		const empty = materializeDynamicParallelStep(base, { targets: { ...outputs.targets, structured: { items: [] } } }, 1, { maxItems: 4 });
		assert.equal(empty.parallel.length, 0);
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, expand: { ...base.expand, onEmpty: "fail" } }, { targets: { ...outputs.targets, structured: { items: [] } } }, 1, { maxItems: 4 }),
			/source array is empty/,
		);
	});

	test("ignores legacy acceptance fields on dynamic fanout configs", () => {
		const removedGateField = "accept" + "ance";
		const legacyStep = {
			expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {target.path}", [removedGateField]: { level: "checked" } },
			collect: { as: "reviews" },
			[removedGateField]: { level: "checked" },
		};

		assert.doesNotThrow(() => validateChainOutputBindings([
			{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
			legacyStep,
		]));
		const materialized = materializeDynamicParallelStep(legacyStep, outputs, 1);
		assert.equal(removedGateField in materialized.parallel[0]!, false);
	});

	test("JSON chain rewrites strip legacy acceptance fields", () => {
		const removedGateField = "accept" + "ance";
		const chain = parseJsonChain(JSON.stringify({
			name: "legacy-cleanup",
			description: "Legacy cleanup",
			chain: [
				{ agent: "scout", task: "Return targets", [removedGateField]: { level: "checked" } },
				{ parallel: [{ agent: "reviewer", task: "Review", [removedGateField]: "reviewed" }] },
			],
		}), "project", "legacy-cleanup.chain.json");

		const serialized = serializeJsonChain(chain);
		assert.doesNotMatch(serialized, new RegExp(`\"${removedGateField}\"`));
	});

	test("rejects malformed dynamic-like shapes before they can run as static parallel", () => {
		const malformed = [
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: [{ agent: "reviewer", task: "Review" }],
				collect: { as: "reviews" },
			},
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item.path}" },
			},
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item.path}" },
				collect: { as: "reviews" },
				when: "later",
			},
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item.path}", as: "child" },
				collect: { as: "reviews" },
			},
		] as ChainStep[];

		for (const step of malformed) {
			assert.throws(
				() => validateChainOutputBindings([{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } }, step]),
				ChainOutputValidationError,
			);
		}
	});

	test("validates source ordering and collect name collisions", () => {
		const chain: ChainStep[] = [
			{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item.path}" },
				collect: { as: "targets" },
			},
		];
		assert.throws(() => validateChainOutputBindings(chain), ChainOutputValidationError);
		assert.throws(
			() => validateChainOutputBindings([chain[1]!]),
			/unknown output 'targets'/,
		);
	});

	test("collects ordered child result records and validates aggregate schema", () => {
		const step: ChainStep = {
			expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {item.path}" },
			collect: { as: "reviews" },
		};
		const materialized = materializeDynamicParallelStep(step, outputs, 1);
		const result = (agent: string, structuredOutput: unknown): SingleResult => ({
			agent,
			task: "t",
			exitCode: 0,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			finalOutput: "ok",
			structuredOutput,
		});
		const collected = collectDynamicResults(step, materialized.items, [result("reviewer", { ok: "a" }), result("reviewer", { ok: "b" })]);
		assert.deepEqual(collected.map((item) => item.key), ["src/a.js", "src/b.js"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		assert.doesNotThrow(() => validateDynamicCollection({ type: "array", minItems: 2 }, collected));
		assert.throws(() => validateDynamicCollection({ type: "object" }, collected), DynamicFanoutError);
	});
});
