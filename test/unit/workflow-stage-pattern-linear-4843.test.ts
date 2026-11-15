import assert from "node:assert/strict";
import type net from "node:net";
import { describe, test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";
import { matchStagePathSegments as matchIntercom } from "../../packages/intercom/workflow-stage-path-matching.js";
import {
	MAX_WORKFLOW_STAGE_TARGET_LENGTH,
	MAX_WORKFLOW_STAGE_TARGET_SEGMENTS,
	parseWorkflowStageTarget,
	workflowStageTargetSizeError,
} from "../../packages/intercom/workflow-stage-target.js";
import { matchStagePathSegments as matchWorkflows } from "../../packages/workflows/src/shared/workflow-stage-path-matching.js";
import {
	MAX_WORKFLOW_STAGE_TARGET_LENGTH as MAX_LENGTH_FROM_WORKFLOWS,
	MAX_WORKFLOW_STAGE_TARGET_SEGMENTS as MAX_SEGMENTS_FROM_WORKFLOWS,
	parseWorkflowStageTarget as parseFromWorkflows,
} from "../../packages/workflows/src/shared/workflow-stage-target.js";

const ROOT_RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const TARGET_PREFIX = `workflow:${ROOT_RUN_ID}/`;
const MATCHERS = [
	["intercom", matchIntercom],
	["workflows", matchWorkflows],
] as const;

/** The pre-#4843 recursive matcher, kept verbatim as the differential reference. */
function referenceMatch(pattern: readonly string[], candidate: readonly string[]): boolean {
	const from = (p: number, c: number): boolean => {
		while (p < pattern.length) {
			const segment = pattern[p]!;
			if (segment === "**") {
				for (let skip = c; skip <= candidate.length; skip += 1) {
					if (from(p + 1, skip)) return true;
				}
				return false;
			}
			if (c >= candidate.length) return false;
			if (!referenceSegmentGlob(segment, candidate[c]!)) return false;
			p += 1;
			c += 1;
		}
		return c === candidate.length;
	};
	return from(0, 0);
}

function referenceSegmentGlob(pattern: string, value: string): boolean {
	const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${source}$`, "s").test(value);
}

/** mulberry32: a small deterministic PRNG so failures reproduce from the seed. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const CANDIDATE_SEGMENTS = ["a", "b", "ab", "ba", "", "aa"] as const;
const PATTERN_SEGMENTS = ["**", "**", "*", "a", "b", "a*", "*b", "a*b", "", "ab"] as const;

function pick<T>(random: () => number, values: readonly T[]): T {
	return values[Math.floor(random() * values.length)]!;
}

function randomSegments<T>(random: () => number, values: readonly T[], maxLength: number): T[] {
	const length = Math.floor(random() * (maxLength + 1));
	return Array.from({ length }, () => pick(random, values));
}

function sender(socket: net.Socket): BrokerConnectedSession {
	return {
		socket,
		info: {
			id: "sender-id",
			name: "planner",
			cwd: "/repo",
			model: "test-model",
			pid: 10,
			startedAt: 11,
			lastActivity: 12,
			group: `workflow:${ROOT_RUN_ID}`,
		},
	};
}

describe("workflow stage pattern matching cost (#4843)", () => {
	test("matches 80 `**` segments against a 6-segment path in linear time (#4843)", () => {
		// The pre-fix matcher needed over 20 s here; linear matching needs well under a millisecond.
		const GENEROUS_BOUND_MS = 50;
		const pattern = [...Array.from({ length: 80 }, () => "**"), "zz"];
		const candidate = ["a", "b", "c", "d", "e", "f"];
		for (const [name, match] of MATCHERS) {
			const started = performance.now();
			assert.equal(match(pattern, candidate), false, name);
			assert.equal(match([...pattern.slice(0, -1), "f"], candidate), true, name);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < GENEROUS_BOUND_MS, `${name} took ${elapsed.toFixed(1)} ms`);
		}
	});

	test("agrees with the recursive reference matcher on seeded random patterns (#4843)", () => {
		const random = seededRandom(4843);
		for (let iteration = 0; iteration < 5000; iteration += 1) {
			const pattern = randomSegments(random, PATTERN_SEGMENTS, 7);
			const candidate = randomSegments(random, CANDIDATE_SEGMENTS, 6);
			const expected = referenceMatch(pattern, candidate);
			for (const [name, match] of MATCHERS) {
				assert.equal(
					match(pattern, candidate),
					expected,
					`${name}: ${JSON.stringify(pattern)} vs ${JSON.stringify(candidate)}`,
				);
			}
		}
	});
});

describe("workflow stage target size limits (#4843)", () => {
	const targetWithSegments = (count: number): string =>
		`${TARGET_PREFIX}${Array.from({ length: count }, () => "**").join("/")}`;
	const targetWithLength = (length: number): string => `${TARGET_PREFIX}${"a".repeat(length - TARGET_PREFIX.length)}`;

	test("keeps both grammar mirrors on the same limits (#4843)", () => {
		assert.equal(MAX_SEGMENTS_FROM_WORKFLOWS, MAX_WORKFLOW_STAGE_TARGET_SEGMENTS);
		assert.equal(MAX_LENGTH_FROM_WORKFLOWS, MAX_WORKFLOW_STAGE_TARGET_LENGTH);
	});

	test("accepts a target at the segment limit and rejects one past it (#4843)", () => {
		const atLimit = targetWithSegments(MAX_WORKFLOW_STAGE_TARGET_SEGMENTS);
		const overLimit = targetWithSegments(MAX_WORKFLOW_STAGE_TARGET_SEGMENTS + 1);
		for (const parse of [parseWorkflowStageTarget, parseFromWorkflows]) {
			assert.equal(parse(atLimit)?.segments.length, MAX_WORKFLOW_STAGE_TARGET_SEGMENTS);
			assert.equal(parse(overLimit), undefined);
		}
		assert.equal(workflowStageTargetSizeError(atLimit), undefined);
		assert.match(
			workflowStageTargetSizeError(overLimit) ?? "",
			new RegExp(
				`${MAX_WORKFLOW_STAGE_TARGET_SEGMENTS + 1} segments.*at most ${MAX_WORKFLOW_STAGE_TARGET_SEGMENTS}`,
			),
		);
	});

	test("accepts a target at the length limit and rejects one past it (#4843)", () => {
		const atLimit = targetWithLength(MAX_WORKFLOW_STAGE_TARGET_LENGTH);
		const overLimit = targetWithLength(MAX_WORKFLOW_STAGE_TARGET_LENGTH + 1);
		assert.equal(atLimit.length, MAX_WORKFLOW_STAGE_TARGET_LENGTH);
		for (const parse of [parseWorkflowStageTarget, parseFromWorkflows]) {
			assert.notEqual(parse(atLimit), undefined);
			assert.equal(parse(overLimit), undefined);
		}
		assert.equal(workflowStageTargetSizeError(atLimit), undefined);
		assert.match(
			workflowStageTargetSizeError(overLimit) ?? "",
			new RegExp(`${MAX_WORKFLOW_STAGE_TARGET_LENGTH + 1} characters.*at most ${MAX_WORKFLOW_STAGE_TARGET_LENGTH}`),
		);
		assert.equal(workflowStageTargetSizeError(`session-${"a".repeat(2000)}`), undefined);
	});

	test("the broker refuses an oversized workflow target with the limit error before routing (#4843)", () => {
		const socket = {} as net.Socket;
		const sessions = new Map([["sender-id", sender(socket)]]);
		const target = targetWithSegments(MAX_WORKFLOW_STAGE_TARGET_SEGMENTS + 1);
		const routed: string[] = [];
		const writes: BrokerMessage[] = [];
		handleBrokerSend(
			socket,
			{ type: "send", to: target, message: { id: "huge", timestamp: 100, content: { text: "hi" } } },
			"sender-id",
			sessions,
			new DeliveredMessageCache(),
			(_target, value) => {
				writes.push(value);
				return true;
			},
			undefined,
			undefined,
			(input) => {
				routed.push(input.target);
				return true;
			},
		);
		assert.deepEqual(routed, []);
		assert.deepEqual(writes, [
			{ type: "delivery_failed", messageId: "huge", reason: workflowStageTargetSizeError(target) },
		]);
	});
});
