import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { TransitiveUsageAggregator } from "../../packages/coding-agent/src/core/transitive-usage.ts";

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

describe("transitive usage reconciliation ordering", () => {
	test("settled descendant reports cannot be downgraded by delayed interim updates", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "subagent", usage: usage(100, 10), settled: true });
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "subagent", usage: usage(10, 1), settled: false });
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.descendants.input, 100);
		assert.equal(result.descendants.cost.total, 10);
		assert.equal(result.complete, true);
	});

	test("older reconciliation results cannot overwrite newer completeness", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		const olderReconciliation = aggregator.beginReconciliation();
		const newerReconciliation = aggregator.beginReconciliation();
		aggregator.reconcile([], false, { reconciliationId: newerReconciliation });
		aggregator.reconcile([], true, { reconciliationId: olderReconciliation });
		assert.equal(aggregator.getTransitiveUsage().complete, false);
	});

	test("persisted reconciliation cannot roll back known settled usage", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "workflow-stage", usage: usage(100, 10), settled: true });
		const startedAtRevision = aggregator.getRevision();
		aggregator.reconcile([
			{ rootSessionId: "root", childRunId: "live", kind: "workflow-stage", usage: usage(20, 2), settled: true },
		], true, { startedAtRevision });
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.descendants.cost.total, 10);
		assert.equal(result.complete, true);
	});

	test("aliased interim reports cannot replace settled usage", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		aggregator.attributeDescendantUsage({
			rootSessionId: "root", childRunId: "durable", kind: "subagent", usage: usage(100, 10), settled: true, sessionFile: "/tmp/child.jsonl",
		});
		aggregator.attributeDescendantUsage({
			rootSessionId: "root", childRunId: "live", kind: "subagent", usage: usage(10, 1), settled: false, sessionFile: "/tmp/child.jsonl",
		});
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.descendants.cost.total, 10);
		assert.equal(result.complete, true);
		assert.equal(result.breakdown.length, 1);
	});

	test("larger aliased interim usage remains an unsettled lower bound", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "durable", kind: "workflow-stage", usage: usage(20, 2), settled: true, sessionFile: "/tmp/stage.jsonl" });
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "workflow-stage", usage: usage(30, 3), settled: false, sessionFile: "/tmp/stage.jsonl" });
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.descendants.cost.total, 3);
		assert.equal(result.complete, false);
	});

	test("aggregate aliases preserve the sum of disjoint settled contributions", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "a", kind: "subagent", usage: usage(20, 2), settled: true, sessionFile: "/tmp/a.jsonl" });
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "b", kind: "subagent", usage: usage(30, 3), settled: true, sessionFile: "/tmp/b.jsonl" });
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "parallel", kind: "subagent", usage: usage(10, 1), settled: false, sessionFiles: ["/tmp/a.jsonl", "/tmp/b.jsonl"] });
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.descendants.cost.total, 5);
		assert.equal(result.complete, true);
		assert.equal(result.breakdown.length, 1);
	});

	test("expanding settled alias coverage becomes incomplete until settled", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "a", kind: "subagent", usage: usage(20, 2), settled: true, sessionFile: "/tmp/a.jsonl" });
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "parallel", kind: "subagent", usage: usage(20, 2), settled: false, sessionFiles: ["/tmp/a.jsonl", "/tmp/b.jsonl"] });
		assert.equal(aggregator.getTransitiveUsage().complete, false);
	});

	test("complete per-file reconciliation settles a live multi-file aggregate", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		aggregator.attributeDescendantUsage({
			rootSessionId: "root", childRunId: "parallel", kind: "subagent", usage: usage(40, 4), settled: false,
			sessionFiles: ["/tmp/a.jsonl", "/tmp/b.jsonl"],
		});
		aggregator.reconcile([
			{ rootSessionId: "root", childRunId: "a", kind: "subagent", usage: usage(20, 2), settled: true, sessionFile: "/tmp/a.jsonl" },
			{ rootSessionId: "root", childRunId: "b", kind: "subagent", usage: usage(30, 3), settled: true, sessionFile: "/tmp/b.jsonl" },
		], true, { startedAtRevision: aggregator.getRevision() });
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.descendants.cost.total, 5);
		assert.equal(result.complete, true);
		assert.equal(result.breakdown.length, 1);
	});
});
