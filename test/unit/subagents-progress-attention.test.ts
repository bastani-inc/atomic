import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { describe, test } from "vitest";
import { nextLongRunningTrigger } from "../../packages/subagents/src/runs/shared/long-running-guard.js";
import {
	classify_trend as classifySubagentTrend,
	FLAT_LOW_SCORE_CEILING,
	PROGRESS_ATTENTION_THRESHOLD_FRACTION,
} from "../../packages/subagents/src/runs/shared/progress-trend.js";
import {
	DEFAULT_CONTROL_CONFIG,
	deriveActivityState,
	resolveControlConfig,
} from "../../packages/subagents/src/runs/shared/subagent-control.js";
import type { ResolvedControlConfig } from "../../packages/subagents/src/shared/types-results.js";
import { moduleDir } from "../helpers/runtime.js";

const TREND_CASES = [
	{ expected: "rising", name: "rising boundary", series: [1, 1, 1, 2.5, 2.5, 2.5] },
	{ expected: "regressing", name: "regressing boundary", series: [2.5, 2.5, 2.5, 1, 1, 1] },
	{ expected: "flat", name: "alternating noise", series: [6, 10, 6, 10, 6, 10] },
	{ expected: "flat", name: "short series", series: [5, 6, 7] },
	{ expected: "flat", name: "paper low and flat failure", series: [5, 5, 6, 5, 5, 6] },
];
const repoRoot = join(moduleDir(import.meta.url), "../..");
const PROGRESS_CONSUMER_SOURCES = [
	"packages/subagents/src/runs/shared/progress-trend.ts",
	"packages/subagents/src/runs/shared/subagent-control.ts",
	"packages/subagents/src/runs/shared/long-running-guard.ts",
] as const;
const TREND_DERIVED_IDENTIFIERS = new Set([
	"TrendResult",
	"trend",
	"progressScores",
	"score",
	"scores",
	"scoreIteration",
	"score_progress",
	"classify_trend",
	"progressAwareThreshold",
	"hasProgressAttentionSignal",
]);
const TERMINAL_STATUS_LITERALS = new Set([
	"complete",
	"completed",
	"failed",
	"failure",
	"cancelled",
	"canceled",
	"aborted",
	"stopped",
	"terminated",
]);

type SourceNode = { readonly type: string; readonly [key: string]: unknown };

function isNode(value: unknown): value is SourceNode {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function children(node: SourceNode): SourceNode[] {
	const result: SourceNode[] = [];
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const entry of value) if (isNode(entry)) result.push(entry);
		} else if (isNode(value)) {
			result.push(value);
		}
	}
	return result;
}

function hasTrendDerivedIdentifier(node: SourceNode): boolean {
	if (node.type === "Identifier" && TREND_DERIVED_IDENTIFIERS.has(String(node.name))) return true;
	return children(node).some((child) => hasTrendDerivedIdentifier(child));
}

function hasTerminalStatusLiteral(node: SourceNode): boolean {
	if (node.type === "StringLiteral" && TERMINAL_STATUS_LITERALS.has(String(node.value))) return true;
	return children(node).some((child) => hasTerminalStatusLiteral(child));
}

function propertyName(node: SourceNode | undefined): string | undefined {
	if (node === undefined) return undefined;
	if (node.type === "Identifier") return String(node.name);
	if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value);
	return undefined;
}

const ASSIGNMENT_OPERATORS = new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"<<=",
	">>=",
	">>>=",
	"|=",
	"^=",
	"&=",
]);

function isStatusAssignment(node: SourceNode): boolean {
	if (node.type !== "AssignmentExpression" || !ASSIGNMENT_OPERATORS.has(String(node.operator))) return false;
	const left = node.left as SourceNode;
	if (left.type === "Identifier") return String(left.name) === "status";
	return left.type === "MemberExpression" && propertyName(left.property as SourceNode | undefined) === "status";
}

function isTerminalSink(node: SourceNode): boolean {
	if (node.type === "ThrowStatement") return true;
	if (isStatusAssignment(node)) return true;
	if (node.type === "CallExpression") {
		const callee = node.callee as SourceNode;
		if (
			callee.type === "MemberExpression" &&
			propertyName(callee.object as SourceNode | undefined) === "ctx" &&
			propertyName(callee.property as SourceNode | undefined) === "exit"
		) {
			return true;
		}
	}
	if (node.type === "ObjectProperty" && propertyName(node.key as SourceNode | undefined) === "status") return true;
	if (node.type === "VariableDeclarator" && propertyName(node.id as SourceNode | undefined) === "status") {
		return node.init !== undefined;
	}
	if (node.type === "ReturnStatement") {
		const argument = node.argument as SourceNode | undefined;
		return argument !== undefined && argument.type !== "ObjectExpression" && hasTerminalStatusLiteral(argument);
	}
	return false;
}

function containsNode(root: SourceNode | undefined, target: SourceNode): boolean {
	return root === target || (root !== undefined && children(root).some((child) => containsNode(child, target)));
}

const FUNCTION_BOUNDARIES = new Set([
	"ArrowFunctionExpression",
	"ClassMethod",
	"ClassPrivateMethod",
	"FunctionDeclaration",
	"FunctionExpression",
	"ObjectMethod",
]);

function hasTrendControl(sink: SourceNode, ancestors: readonly SourceNode[]): boolean {
	if (sink.type === "ReturnStatement") {
		const argument = sink.argument as SourceNode | undefined;
		if (argument !== undefined && argument.type !== "ObjectExpression" && hasTrendDerivedIdentifier(argument))
			return true;
	} else if (sink.type === "ObjectProperty" || sink.type === "VariableDeclarator") {
		const value = (sink.type === "ObjectProperty" ? sink.value : sink.init) as SourceNode | undefined;
		if (value !== undefined && hasTrendDerivedIdentifier(value)) return true;
	} else if (hasTrendDerivedIdentifier(sink)) {
		return true;
	}
	for (const current of ancestors) {
		if (current.type === "IfStatement" && hasTrendDerivedIdentifier(current.test as SourceNode)) {
			if (
				containsNode(current.consequent as SourceNode, sink) ||
				containsNode(current.alternate as SourceNode | undefined, sink)
			)
				return true;
		}
		if (
			current.type === "ConditionalExpression" &&
			hasTrendDerivedIdentifier(current.test as SourceNode) &&
			(containsNode(current.consequent as SourceNode, sink) || containsNode(current.alternate as SourceNode, sink))
		) {
			return true;
		}
		if (
			current.type === "LogicalExpression" &&
			hasTrendDerivedIdentifier(current.left as SourceNode) &&
			containsNode(current.right as SourceNode, sink)
		) {
			return true;
		}
		if (current.type === "SwitchStatement" && hasTrendDerivedIdentifier(current.discriminant as SourceNode))
			return true;
		if (FUNCTION_BOUNDARIES.has(current.type)) break;
	}
	return false;
}

function assertNoTrendTerminalPath(relativePath: (typeof PROGRESS_CONSUMER_SOURCES)[number]): void {
	const source = readFileSync(join(repoRoot, relativePath), "utf8");
	const root = parse(source, { sourceType: "module", plugins: ["typescript", "decorators"] })
		.program as unknown as SourceNode;
	const violations: string[] = [];
	const visit = (node: SourceNode, ancestors: readonly SourceNode[]): void => {
		// This executable source guard must fail if progress evidence is wired into a terminal/status path.
		if (isTerminalSink(node) && hasTrendControl(node, ancestors)) {
			const line = (node.loc as { start?: { line?: number } } | undefined)?.start?.line ?? "?";
			violations.push(`${relativePath}:${line}`);
		}
		for (const child of children(node)) visit(child, [node, ...ancestors]);
	};
	visit(root, []);
	assert.deepEqual(violations, [], `${relativePath} has a trend-derived terminal/status path`);
}

function controlConfig(progressScores?: number[]): ResolvedControlConfig {
	return {
		...DEFAULT_CONTROL_CONFIG,
		...(progressScores === undefined ? {} : { progressScores }),
		notifyOn: [...DEFAULT_CONTROL_CONFIG.notifyOn],
		notifyChannels: [...DEFAULT_CONTROL_CONFIG.notifyChannels],
	};
}

describe("subagents progress attention", () => {
	test("classifies improving, regressing and inconclusive progress scores", () => {
		for (const { series, expected, name } of TREND_CASES)
			assert.equal(classifySubagentTrend(series).trend, expected, name);
	});

	test("progress control config preserves score-series precedence and ordering", () => {
		const globalScores = [12, 11, 10];
		const overrideScores = [5, 5, 6];
		const resolved = resolveControlConfig({ progressScores: globalScores }, { progressScores: overrideScores });
		assert.deepEqual(resolved.progressScores, overrideScores);
		assert.notStrictEqual(resolved.progressScores, overrideScores);
		assert.deepEqual(resolveControlConfig({ progressScores: globalScores }).progressScores, globalScores);
		assert.deepEqual(resolveControlConfig(undefined, { progressScores: [] }).progressScores, []);
	});

	test("progress trend raises attention priority without creating a failure state", () => {
		const baseline = controlConfig();
		const lowFlat = controlConfig([5, 5, 6, 5, 5, 6]);
		const startedAt = 1_000_000;
		const baselineState = deriveActivityState({ config: baseline, startedAt, now: startedAt + 31_000 });
		const raisedState = deriveActivityState({ config: lowFlat, startedAt, now: startedAt + 31_000 });
		assert.equal(baselineState, undefined);
		assert.equal(raisedState, "needs_attention");
		assert.equal(FLAT_LOW_SCORE_CEILING, 8);
		assert.equal(PROGRESS_ATTENTION_THRESHOLD_FRACTION, 0.5);
		assert.notEqual(raisedState, "failed");
	});

	test("progress trend preserves every prior wall-clock attention signal", () => {
		const baseline = controlConfig();
		const progress = controlConfig([10, 10, 10, 5, 5, 5]);
		const startedAt = 2_000_000;
		for (const elapsedMs of [60_001, 120_000, 240_000, 300_000]) {
			assert.equal(
				deriveActivityState({ config: progress, startedAt, now: startedAt + elapsedMs }),
				deriveActivityState({ config: baseline, startedAt, now: startedAt + elapsedMs }),
				`needs-attention wall-clock row ${elapsedMs}`,
			);
		}
		for (const elapsedMs of [240_000, 300_000]) {
			assert.equal(
				nextLongRunningTrigger(progress, { startedAt, now: startedAt + elapsedMs, turns: 0, tokens: 0 }),
				nextLongRunningTrigger(baseline, { startedAt, now: startedAt + elapsedMs, turns: 0, tokens: 0 }),
				`active-long-running wall-clock row ${elapsedMs}`,
			);
		}
		assert.equal(
			nextLongRunningTrigger(progress, { startedAt, now: startedAt, turns: 3, tokens: 0 }),
			nextLongRunningTrigger(baseline, { startedAt, now: startedAt, turns: 3, tokens: 0 }),
		);
		assert.equal(
			nextLongRunningTrigger(progress, { startedAt, now: startedAt, turns: 0, tokens: 3 }),
			nextLongRunningTrigger(baseline, { startedAt, now: startedAt, turns: 0, tokens: 3 }),
		);
	});

	test("progress trend source has no terminal or status path", () => {
		for (const relativePath of PROGRESS_CONSUMER_SOURCES) assertNoTrendTerminalPath(relativePath);
	});

	test("progress trend evidence is actionless and cannot mutate run status", () => {
		const config = controlConfig([5, 5, 6, 5, 5, 6]);
		const before = JSON.stringify(config);
		const trend = classifySubagentTrend(config.progressScores ?? []);
		const state = deriveActivityState({ config, startedAt: 3_000_000, now: 3_031_000 });
		assert.deepEqual(Object.keys(trend), ["trend", "evidence"]);
		assert.equal("action" in trend, false);
		assert.equal("failed" in trend, false);
		assert.ok(state === undefined || state === "active_long_running" || state === "needs_attention");
		assert.equal(JSON.stringify(config), before);
	});
});
