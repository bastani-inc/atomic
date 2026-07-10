import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { TransitiveUsageAggregator, collectDescendantUsageReports, emptyUsage } from "../../packages/coding-agent/src/core/transitive-usage.ts";
import { getUsageLine } from "../../packages/coding-agent/src/modes/interactive/components/footer.ts";
import { liveSubagentDetails, reportSubagentStarted, reportSubagentUsageForRoot, usageFromResults, usageRollupFromResults } from "../../packages/subagents/src/shared/usage-rollup.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { makeUsageRollupPort } from "../../packages/workflows/src/extension/workflow-ports.ts";
import { compactForegroundDetails } from "../../packages/subagents/src/shared/utils.ts";
initTheme("dark", false);
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

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("TransitiveUsageAggregator", () => {
	test("keyed upsert prevents double-counting", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "child", kind: "subagent", usage: usage(20, 2), settled: true });
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "child", kind: "subagent", usage: usage(20, 2), settled: true });
		assert.equal(aggregator.getTransitiveUsage().total.cost.total, 3);
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "child", kind: "subagent", usage: usage(30, 3), settled: true });
		assert.equal(aggregator.getTransitiveUsage().total.cost.total, 4);
	});

	test("wrong-root reports are rejected", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
		assert.equal(aggregator.attributeDescendantUsage({ rootSessionId: "other", childRunId: "child", kind: "subagent", usage: usage(20, 2), settled: true }), false);
		assert.equal(aggregator.getTransitiveUsage().descendants.cost.total, 0);
	});

	test("cost buckets remain visible when cost total is unavailable", () => {
		const bucketOnly = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: Number.NaN } } satisfies Usage;
		const aggregator = new TransitiveUsageAggregator("root", () => bucketOnly);
		assert.equal(aggregator.getTransitiveUsage().total.cost.total, 1);
	});

	test("self and descendants stay separated while composing subagent and workflow-stage descendants", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "subagent-run", kind: "subagent", usage: usage(20, 2), settled: true });
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "workflow-stage-session", kind: "workflow-stage", usage: usage(30, 3), settled: true });
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.self.cost.total, 1);
		assert.equal(result.descendants.cost.total, 5);
		assert.equal(result.total.cost.total, 6);
		assert.equal(result.breakdown.length, 2);
	});

	test("pending initial reconciliation marks totals incomplete", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1), undefined, { initialComplete: false });
		assert.equal(aggregator.getTransitiveUsage().complete, false);
		aggregator.reconcile([], true);
		assert.equal(aggregator.getTransitiveUsage().complete, true);
	});

	test("incomplete reconciliation preserves live reports not found durably", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "subagent", usage: usage(20, 2), settled: true });
		aggregator.reconcile([], false);
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.complete, false);
		assert.equal(result.descendants.cost.total, 2);
	});

	test("complete reconciliation preserves live unsettled reports not found durably", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "async-live", kind: "subagent", usage: usage(0, 0), settled: false });
		aggregator.reconcile([], true);
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.complete, false);
		assert.deepEqual(result.breakdown.map((entry) => entry.childRunId), ["async-live"]);
	});

	test("unsettled same-child reports cannot reduce live descendant totals", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "subagent", usage: usage(100, 10), settled: false });
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "subagent", usage: usage(10, 0), settled: false });
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.descendants.input, 100);
		assert.equal(result.descendants.cost.total, 10);
		assert.equal(result.complete, false);
	});

	test("stale complete reconciliation preserves settled reports attributed after walk started", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
		const startedAtRevision = aggregator.getRevision();
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "workflow-live", kind: "workflow-stage", usage: usage(20, 2), settled: true });
		aggregator.reconcile([{ rootSessionId: "root", childRunId: "workflow-live", kind: "workflow-stage", usage: usage(5, 0.5), settled: true }], true, { startedAtRevision });
		assert.equal(aggregator.getTransitiveUsage().descendants.cost.total, 2);

		aggregator.reconcile([], true, { startedAtRevision });
		assert.equal(aggregator.getTransitiveUsage().descendants.cost.total, 2);

		const freshStartedAtRevision = aggregator.getRevision();
		aggregator.reconcile([], true, { startedAtRevision: freshStartedAtRevision });
		assert.equal(aggregator.getTransitiveUsage().descendants.cost.total, 0);
	});

	test("incomplete reconciliation aliases live run-id reports by session file", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
		aggregator.attributeDescendantUsage({
			rootSessionId: "root",
			childRunId: "live-run",
			kind: "subagent",
			usage: usage(20, 2),
			settled: true,
			sessionFile: "/tmp/child-session.jsonl",
		});
		aggregator.reconcile([
			{
				rootSessionId: "root",
				childRunId: "durable-session-id",
				kind: "subagent",
				usage: usage(20, 2),
				settled: true,
				sessionFile: "/tmp/child-session.jsonl",
			},
		], false);
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.complete, false);
		assert.equal(result.descendants.cost.total, 2);
		assert.deepEqual(result.breakdown.map((entry) => entry.childRunId), ["durable-session-id"]);
	});

	test("incomplete reconciliation aliases parallel rollups by sessionFiles", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(10, 1));
		aggregator.attributeDescendantUsage({
			rootSessionId: "root",
			childRunId: "parallel-run",
			kind: "subagent",
			usage: usage(40, 4),
			settled: true,
			sessionFiles: ["/tmp/a.jsonl", "/tmp/b.jsonl"],
		});
		aggregator.reconcile([
			{
				rootSessionId: "root",
				childRunId: "session-a",
				kind: "subagent",
				usage: usage(20, 2),
				settled: true,
				sessionFile: "/tmp/a.jsonl",
			},
		], false);
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.complete, false);
		assert.equal(result.descendants.cost.total, 2);
		assert.deepEqual(result.breakdown.map((entry) => entry.childRunId), ["session-a"]);
	});
});

describe("collectDescendantUsageReports", () => {
	test("discovers subagent session roots and workflow stage-end usage", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-transitive-"));
		try {
			const rootPath = join(dir, "root.jsonl");
			const subRoot = join(dir, basename(rootPath, ".jsonl"), "run-a");
			mkdirSync(subRoot, { recursive: true });
			const childPath = join(subRoot, "session.jsonl");
			writeSession(rootPath, "root-id", [customStageEnd("stage-session", usage(30, 3), join(dir, "stage.jsonl"))]);
			writeSession(childPath, "child-session", [assistantEntry(usage(20, 2))]);
			const result = await collectDescendantUsageReports({
				root: { path: rootPath, id: "root-id", cwd: dir, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" },
				rootSessionId: "root-id",
				listSessions: async () => [],
			});
			assert.equal(result.complete, true);
			assert.equal(result.reports.reduce((sum, report) => sum + report.usage.cost.total, 0), 5);
			assert.deepEqual(new Set(result.reports.map((report) => report.childRunId)), new Set(["child-session", "stage-session"]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("excludes inherited fork transcript usage from descendant session files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-transitive-fork-"));
		try {
			const rootPath = join(dir, "root.jsonl");
			const parentPath = join(dir, "parent.jsonl");
			const subRoot = join(dir, basename(rootPath, ".jsonl"), "run-fork");
			mkdirSync(subRoot, { recursive: true });
			const childPath = join(subRoot, "session.jsonl");
			const inherited = assistantEntry(usage(100, 10));
			writeSession(parentPath, "parent-id", [inherited]);
			writeSession(rootPath, "root-id", []);
			writeSession(childPath, "child-id", [inherited, assistantEntry(usage(20, 2))], parentPath);
			const result = await collectDescendantUsageReports({
				root: { path: rootPath, id: "root-id", cwd: dir, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" },
				rootSessionId: "root-id",
				listSessions: async () => [],
			});
			assert.equal(result.reports.find((report) => report.childRunId === "child-id")?.usage.cost.total, 2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("workflow stage-end transitive usage suppresses covered nested session files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-transitive-stage-cover-"));
		try {
			const rootPath = join(dir, "root.jsonl");
			const stagePath = join(dir, basename(rootPath, ".jsonl"), "stage.jsonl");
			const nestedRoot = join(dirname(stagePath), basename(stagePath, ".jsonl"), "run-nested");
			mkdirSync(nestedRoot, { recursive: true });
			writeSession(rootPath, "root-id", [customStageEnd("stage-session", usage(30, 3), stagePath)]);
			writeSession(stagePath, "stage-session", [assistantEntry(usage(10, 1))]);
			writeSession(join(nestedRoot, "session.jsonl"), "nested-child", [assistantEntry(usage(20, 2))]);
			const result = await collectDescendantUsageReports({
				root: { path: rootPath, id: "root-id", cwd: dir, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" },
				rootSessionId: "root-id",
				listSessions: async () => [],
			});
			assert.equal(result.reports.reduce((sum, report) => sum + report.usage.cost.total, 0), 3);
			assert.deepEqual(result.reports.map((report) => report.childRunId), ["stage-session"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("persisted incomplete workflow stage usage restores as unsettled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-transitive-stage-incomplete-"));
		try {
			const rootPath = join(dir, "root.jsonl");
			writeSession(rootPath, "root-id", [customStageEnd("stage-session", usage(30, 3), join(dir, "stage.jsonl"), false)]);
			const result = await collectDescendantUsageReports({
				root: { path: rootPath, id: "root-id", cwd: dir, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" },
				rootSessionId: "root-id",
				listSessions: async () => [],
			});
			assert.equal(result.reports[0]?.settled, false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("subagent transitive usage rollup", () => {
	test("prefers file-derived sub-subagent usage over direct scalar fallback", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-transitive-"));
		try {
			const rootPath = join(dir, "session.jsonl");
			const nestedRoot = join(dir, basename(rootPath, ".jsonl"), "run-b");
			mkdirSync(nestedRoot, { recursive: true });
			writeSession(rootPath, "subagent-root", [assistantEntry(usage(10, 1))]);
			writeSession(join(nestedRoot, "session.jsonl"), "sub-subagent", [assistantEntry(usage(20, 2))]);
			const total = usageFromResults([{ agent: "worker", task: "task", exitCode: 0, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 }, sessionFile: rootPath }]);
			assert.equal(total.cost.total, 3);
			assert.equal(total.input, 30);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("file-derived fork rollup excludes inherited parent usage and keeps nested descendants", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-fork-"));
		try {
			const parentPath = join(dir, "parent.jsonl");
			const rootPath = join(dir, "session.jsonl");
			const nestedRoot = join(dir, basename(rootPath, ".jsonl"), "run-b");
			mkdirSync(nestedRoot, { recursive: true });
			const inherited = assistantEntry(usage(100, 10));
			writeSession(parentPath, "parent-id", [inherited]);
			writeSession(rootPath, "subagent-root", [inherited, assistantEntry(usage(10, 1))], parentPath);
			writeSession(join(nestedRoot, "session.jsonl"), "sub-subagent", [assistantEntry(usage(20, 2))]);
			const total = usageFromResults([{ agent: "worker", task: "task", exitCode: 0, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 }, sessionFile: rootPath }]);
			assert.equal(total.cost.total, 3);
			assert.equal(total.input, 30);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("file-derived workflow stage rollup suppresses covered nested descendants", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-stage-cover-"));
		try {
			const rootPath = join(dir, "session.jsonl");
			const stagePath = join(dir, basename(rootPath, ".jsonl"), "stage.jsonl");
			const nestedRoot = join(dirname(stagePath), basename(stagePath, ".jsonl"), "run-nested");
			mkdirSync(nestedRoot, { recursive: true });
			writeSession(rootPath, "subagent-root", [customStageEnd("stage-session", usage(30, 3), stagePath)]);
			writeSession(stagePath, "stage-session", [assistantEntry(usage(10, 1))]);
			writeSession(join(nestedRoot, "session.jsonl"), "nested-child", [assistantEntry(usage(20, 2))]);
			const rollup = usageRollupFromResults([{ agent: "worker", task: "task", exitCode: 0, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 }, sessionFile: rootPath }]);
			assert.equal(rollup.usage.cost.total, 3);
			assert.equal(rollup.complete, true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("file-derived incomplete workflow stage rollup marks subagent rollup incomplete", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-stage-incomplete-"));
		try {
			const rootPath = join(dir, "session.jsonl");
			writeSession(rootPath, "subagent-root", [customStageEnd("stage-session", usage(30, 3), join(dir, "stage.jsonl"), false)]);
			const rollup = usageRollupFromResults([{ agent: "worker", task: "task", exitCode: 0, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 }, sessionFile: rootPath }]);
			assert.equal(rollup.complete, false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("direct-only fallback is marked incomplete and emitted unsettled", () => {
		const details = { mode: "single" as const, runId: "run-1", results: [{ agent: "worker", task: "task", exitCode: 0, usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 1 } }] };
		const rollup = usageRollupFromResults(details.results);
		assert.equal(rollup.complete, false);
		const emitted: unknown[] = [];
		reportSubagentUsageForRoot({ events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) } } as never, "root", { ...details, transitiveUsage: rollup.usage, transitiveUsageComplete: rollup.complete });
		assert.equal((emitted[0] as { settled?: boolean }).settled, false);
	});

	test("foreground compaction preserves fallback incompleteness for reporting", () => {
		const missingSessionFile = join(tmpdir(), `missing-subagent-${crypto.randomUUID()}.jsonl`);
		const compacted = compactForegroundDetails({
			mode: "single",
			runId: "run-compact",
			results: [{
				agent: "worker",
				task: "task",
				exitCode: 0,
				usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.7, turns: 1 },
				sessionFile: missingSessionFile,
			}],
		});
		assert.equal(compacted.transitiveUsageComplete, false);
		assert.deepEqual(compacted.transitiveUsageSessionFiles, [missingSessionFile]);
		const emitted: unknown[] = [];
		reportSubagentUsageForRoot({ events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) } } as never, "root", compacted);
		assert.equal((emitted[0] as { settled?: boolean }).settled, false);
	});

	test("live subagent tool updates compute unsettled transitive usage", () => {
		const details = liveSubagentDetails({
			details: { mode: "single", runId: "run-live", results: [{ agent: "worker", task: "task", exitCode: 0, usage: { input: 12, output: 3, cacheRead: 2, cacheWrite: 1, cost: 1.25, turns: 1 } }] },
		});
		assert.equal(details?.runId, "run-live");
		assert.equal(details?.transitiveUsage?.input, 12);
		assert.equal(details?.transitiveUsage?.output, 3);
		assert.equal(details?.transitiveUsage?.cost.total, 1.25);
		assert.equal(details?.transitiveUsageComplete, false);
	});

	test("live subagent tool updates keep scalar usage as a floor over stale session files", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-live-subagent-floor-"));
		try {
			const sessionFile = join(dir, "session.jsonl");
			writeSession(sessionFile, "stale-session", [assistantEntry(usage(2, 0))]);
			const details = liveSubagentDetails({
				details: { mode: "single", runId: "run-live", results: [{ agent: "worker", task: "task", exitCode: 0, sessionFile, usage: { input: 12, output: 3, cacheRead: 2, cacheWrite: 1, cost: 1.25, turns: 1 } }] },
			});
			assert.equal(details?.transitiveUsage?.input, 12);
			assert.equal(details?.transitiveUsage?.output, 3);
			assert.equal(details?.transitiveUsage?.cacheRead, 2);
			assert.equal(details?.transitiveUsage?.cacheWrite, 1);
			assert.equal(details?.transitiveUsage?.cost.total, 1.25);
			assert.equal(details?.transitiveUsageComplete, false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("async start emits an unsettled zero-usage descendant report", () => {
		const emitted: unknown[] = [];
		reportSubagentStarted({ events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) } } as never, "root", { id: "async-1", asyncDir: "/tmp/async-1" });
		assert.equal((emitted[0] as { childRunId?: string }).childRunId, "async-1");
		assert.equal((emitted[0] as { settled?: boolean }).settled, false);
		assert.equal((emitted[0] as { usage?: Usage }).usage?.cost.total, 0);
		assert.equal("sessionFile" in (emitted[0] as Record<string, unknown>), false);
	});
});

describe("workflow usage rollup port", () => {
	test("uses root accessor, stage session id key, and propagated settled flag", () => {
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const port = makeUsageRollupPort({
			getSessionId: () => "root-session",
			events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
		} as never);
		port?.emitStageRollup("stage-id", usage(7, 0.7), { sessionId: "stage-session", sessionFile: "/tmp/stage.jsonl", settled: false });
		assert.equal(emitted[0]?.event, "usage:descendant-rollup");
		assert.equal(emitted[0]?.payload["rootSessionId"], "root-session");
		assert.equal(emitted[0]?.payload["childRunId"], "stage-session");
		assert.equal(emitted[0]?.payload["settled"], false);
	});

	test("does not emit live workflow rollups without a stage session id", () => {
		const emitted: unknown[] = [];
		const port = makeUsageRollupPort({ getSessionId: () => "root", events: { emit: (_event: string, payload: Record<string, unknown>) => emitted.push(payload) } } as never);
		port?.emitStageRollup("stage-id", usage(7, 0.7), { sessionId: "" });
		assert.equal(emitted.length, 0);
	});
});

describe("footer transitive cost rendering", () => {
	test("transitive totals render cost with no ~ prefix and include descendant tokens in badges; context percent stays self-only", () => {
		const selfUsage = usage(12, 1);
		const transitive = {
			self: selfUsage,
			descendants: usage(1_000, 2.5),
			total: usage(1_012, 3.5),
			complete: false,
			breakdown: [],
		};
		const session = {
			state: { model: { contextWindow: 100 } },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getEntries: () => [{ type: "message", message: { role: "assistant", usage: selfUsage } }],
			},
			getContextUsage: () => ({ tokens: 12, contextWindow: 100, percent: 12 }),
			getTransitiveUsage: () => transitive,
		};
		const rendered = stripAnsi(getUsageLine(session as never, false, 120));
		// Token badge reflects the TRANSITIVE total (self 12 + descendants 1000 = 1012), not self-only.
		assert.match(rendered, /↑1\.0k/);
		assert.match(rendered, /\$3\.500/);
		// The approximate marker was dropped: the figure is always slightly behind the provider anyway.
		assert.doesNotMatch(rendered, /~/);
		// Context window percent is a per-session metric and stays self-only.
		assert.match(rendered, /12\.0%\/100/);
		assert.doesNotMatch(rendered, /1012%/);
	});

	test("zero-cost non-subscription totals render no dollar segment and no ~ marker", () => {
		const session = {
			state: { model: { contextWindow: 200 } },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ tokens: 0, contextWindow: 200, percent: 0 }),
			getTransitiveUsage: () => ({ self: emptyUsage(), descendants: emptyUsage(), total: emptyUsage(), complete: false, breakdown: [] }),
		};
		const rendered = stripAnsi(getUsageLine(session as never, false, 120));
		assert.doesNotMatch(rendered, /\$/);
		assert.doesNotMatch(rendered, /~/);
		assert.match(rendered, /0\.0%\/200/);
	});

	test("zero-priced token usage still renders an explicit dollar segment", () => {
		const tokensOnly = usage(25, 0);
		const session = {
			state: { model: { contextWindow: 200 } },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ tokens: 25, contextWindow: 200, percent: 12.5 }),
			getTransitiveUsage: () => ({ self: emptyUsage(), descendants: tokensOnly, total: tokensOnly, complete: false, breakdown: [] }),
		};
		const rendered = stripAnsi(getUsageLine(session as never, false, 120));
		assert.match(rendered, /\$0\.000/);
	});

	test("descendant tokens and cost appear in badges even when self usage is zero", () => {
		const session = {
			state: { model: { contextWindow: 200 } },
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ tokens: 50, contextWindow: 200, percent: 25 }),
			getTransitiveUsage: () => ({ self: emptyUsage(), descendants: usage(900, 9), total: usage(900, 9), complete: true, breakdown: [] }),
		};
		const rendered = stripAnsi(getUsageLine(session as never, false, 120));
		assert.match(rendered, /\$9\.000/);
		assert.match(rendered, /25\.0%\/200/);
		// Descendant tokens are now surfaced in the transitive badge.
		assert.match(rendered, /↑900/);
	});
});

function sessionHeader(id: string, parentSession?: string) {
	return { type: "session", id, cwd: process.cwd(), timestamp: new Date().toISOString(), ...(parentSession ? { parentSession } : {}) };
}

function assistantEntry(entryUsage: Usage) {
	return { type: "message", id: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: "assistant", usage: entryUsage, content: [] } };
}

function customStageEnd(sessionId: string, entryUsage: Usage, sessionFile: string, usageComplete?: boolean) {
	return { type: "custom", id: crypto.randomUUID(), timestamp: new Date().toISOString(), customType: "workflow.stage.end", data: { stageId: "stage-a", sessionId, sessionFile, usage: entryUsage, ...(usageComplete !== undefined ? { usageComplete } : {}) } };
}

function writeSession(path: string, id: string, entries: object[], parentSession?: string) {
	writeFileSync(path, [sessionHeader(id, parentSession), ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}
