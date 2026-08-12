/**
 * Runner-level coverage of the verification aggregation in
 * `adversarial-verification`: parse loss, the indeterminate quorum retry and
 * its exhaustion, the unconditional veto, and the reported round score.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import adversarialVerification from "../../packages/workflows/builtin/adversarial-verification.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

const ACCEPT = JSON.stringify({ decision: "accept", rationale: "all evidence passed", remaining_work: [] });
const UNPARSEABLE = "the model narrated instead of calling structured_output";

function verifierReport(
	verdict: "pass" | "fail",
	findings: readonly string[] = [],
	vetoes: readonly string[] = [],
): string {
	return JSON.stringify({
		verdict,
		evidence: ["checked"],
		blocking_findings: [...findings],
		veto_findings: [...vetoes],
	});
}

/** Attempt index of a `verifier-<repairs>-<attempt>-<n>` node name. */
function attemptOf(name: string): string {
	return name.split("-")[2] ?? "";
}

async function withTempCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await mkdtemp(join(tmpdir(), "adversarial-aggregation-test-"));
	try {
		return await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function assignCwd<T extends object>(ctx: T, cwd: string): T {
	Object.defineProperty(ctx, "cwd", { value: cwd, enumerable: true });
	return ctx;
}

test("accepts despite one unparseable verifier report", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{ task: "verify this", verifier_count: 5, max_repairs: 2 },
				{
					task: (name) =>
						name === "verifier-0-0-5"
							? UNPARSEABLE
							: name.startsWith("verifier-")
								? verifierReport("pass")
								: name.startsWith("reducer-")
									? ACCEPT
									: undefined,
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		// The dropped report lowers neither the score nor the verdict.
		assert.equal(result.approved, true);
		assert.equal(result.repairs_completed, 0);
		assert.equal(result.verification_score, 1);
		assert.equal(ctx.calls.parallel.length, 1);
	});
});

test("retries the round rather than repairing when reports fail the quorum", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{ task: "verify this", verifier_count: 5, max_repairs: 2 },
				{
					task: (name) =>
						name.startsWith("verifier-")
							? attemptOf(name) === "0" && name !== "verifier-0-0-1" && name !== "verifier-0-0-2"
								? UNPARSEABLE
								: verifierReport("pass")
							: name.startsWith("reducer-")
								? ACCEPT
								: undefined,
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		assert.equal(result.approved, true);
		// A parse-quorum failure is a harness problem, so it costs no repair.
		assert.equal(result.repairs_completed, 0);
		assert.equal(ctx.calls.parallel.length, 2);
		// Fresh node names keep the retried round acyclic.
		assert.deepEqual(ctx.calls.parallel[0], [
			"verifier-0-0-1",
			"verifier-0-0-2",
			"verifier-0-0-3",
			"verifier-0-0-4",
			"verifier-0-0-5",
		]);
		assert.deepEqual(ctx.calls.parallel[1], [
			"verifier-0-1-1",
			"verifier-0-1-2",
			"verifier-0-1-3",
			"verifier-0-1-4",
			"verifier-0-1-5",
		]);
		assert.equal(new Set([...ctx.calls.parallel.flat()]).size, 10);
		// The indeterminate round never reached a reducer, so `reducer-0` is
		// still dispatched exactly once.
		assert.equal(ctx.calls.task.filter((name) => name === "reducer-0").length, 1);
		assert.equal(
			ctx.calls.task.some((name) => name.startsWith("repair-")),
			false,
		);
	});
});

test("rejects with an infrastructure rationale after the indeterminate retry budget", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{ task: "verify this", verifier_count: 3, max_repairs: 2 },
				{
					task: (name) =>
						name.startsWith("verifier-") ? UNPARSEABLE : name.startsWith("reducer-") ? ACCEPT : undefined,
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		assert.equal(result.approved, false);
		assert.equal(result.repairs_completed, 0);
		assert.equal(result.verification_score, 0);
		assert.equal(ctx.calls.parallel.length, 2);
		// The rejection names verification infrastructure, not candidate quality.
		assert.match(result.result, /verification infrastructure failure/i);
		assert.match(result.result, /not a judgment about candidate quality/i);
		assert.match(result.result, /0 of 3 verifier reports parsed/);
		assert.equal(
			ctx.calls.task.some((name) => name.startsWith("reducer-") || name.startsWith("repair-")),
			false,
		);
		assert.deepEqual(result.remaining_work, [
			"Independent verification produced no usable quorum of parseable verifier reports.",
		]);
	});
});

test("overrides a reducer accept when a verifier vetoes", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{ task: "verify this", verifier_count: 3, max_repairs: 0 },
				{
					task: (name) =>
						name === "verifier-0-0-2"
							? verifierReport("pass", ["prefers a helper"], ["deletes production rows without a backup"])
							: name.startsWith("verifier-")
								? verifierReport("pass")
								: name.startsWith("reducer-")
									? ACCEPT
									: undefined,
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		// Every verifier passed and the reducer accepted; the veto alone blocks.
		assert.equal(result.approved, false);
		assert.equal(result.verification_score, 1);
		assert.match(result.result, /unconditional veto finding/);
		assert.equal(result.remaining_work[0], "deletes production rows without a backup");
		assert.ok(result.remaining_work.includes("prefers a helper"));
	});
});

test("repairs rather than rejecting when a veto lands with repair budget left", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{ task: "verify this", verifier_count: 2, max_repairs: 1 },
				{
					task: (name) =>
						name === "verifier-0-0-1"
							? verifierReport("pass", [], ["leaks an API key into the log"])
							: name.startsWith("verifier-")
								? verifierReport("pass")
								: name.startsWith("reducer-")
									? ACCEPT
									: undefined,
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		assert.equal(result.approved, true);
		// The veto forced one repair round; the repaired round then passed.
		assert.equal(result.repairs_completed, 1);
		assert.ok(ctx.calls.task.includes("repair-1"));
		assert.deepEqual(ctx.calls.parallel[1], ["verifier-1-0-1", "verifier-1-0-2"]);
	});
});

test("reports the round mean as verification_score", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{ task: "verify this", verifier_count: 4, max_repairs: 0 },
				{
					task: (name) =>
						name === "verifier-0-0-4"
							? verifierReport("fail", ["one dissent"])
							: name.startsWith("verifier-")
								? verifierReport("pass")
								: name.startsWith("reducer-")
									? ACCEPT
									: undefined,
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		// 3 ÷ 4 = 0.75 sits exactly on the pass threshold, so one dissent no
		// longer blocks a four-verifier round.
		assert.equal(result.verification_score, 0.75);
		assert.equal(result.approved, true);
		assert.deepEqual(result.remaining_work, []);
	});
});

test("blocks a below-threshold round the reducer would have accepted", async () => {
	await withTempCwd(async (cwd) => {
		const ctx = assignCwd(
			makeMockCtx(
				{ task: "verify this", verifier_count: 3, max_repairs: 0 },
				{
					task: (name) =>
						name === "verifier-0-0-3"
							? verifierReport("fail", ["no evidence for the migration claim"])
							: name.startsWith("verifier-")
								? verifierReport("pass")
								: name.startsWith("reducer-")
									? ACCEPT
									: undefined,
				},
			),
			cwd,
		);
		const result = await adversarialVerification.run(ctx);
		// 2 ÷ 3 is below 0.75, so the shipped default still requires 3 of 3.
		assert.equal(result.approved, false);
		assert.ok(Math.abs(result.verification_score - 2 / 3) < 1e-12);
		assert.match(result.result, /below the pass threshold/);
		assert.deepEqual(result.remaining_work, ["no evidence for the migration claim"]);
	});
});
