// Self-test for trial-outcome.mjs: node --test research/evidence/postgres-adapter/trial-outcome.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { trialOutcome, waitForReady, watchExits } from "./trial-outcome.mjs";

const node = (code) => spawn(process.execPath, ["-e", code], { stdio: "ignore" });

test("a host that exits before it is ready fails the wait instead of hanging it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trial-outcome-"));
	try {
		const { states } = watchExits([node("process.exit(3)")]);
		const reason = await waitForReady([join(dir, "ready-0")], states, Date.now() + 10_000);
		assert.match(reason, /h0 exited before it was ready \(code 3/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readiness has a deadline", async () => {
	const child = node("setTimeout(() => {}, 10_000)");
	const { states } = watchExits([child]);
	try {
		assert.match(await waitForReady(["/nonexistent/ready-0"], states, Date.now() + 200), /h0 not ready in time/);
	} finally {
		child.kill("SIGKILL");
	}
});

test("a completed run fails when a host exited non-zero or wrote no result", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trial-outcome-"));
	try {
		const files = [join(dir, "result-0.json"), join(dir, "result-1.json")];
		writeFileSync(files[0], "{}");
		const { exits, states } = watchExits([node("process.exit(0)"), node("process.exit(1)")]);
		await Promise.all(exits);
		const outcome = trialOutcome("completed", states, files);
		assert.equal(outcome.status, "failed");
		assert.match(outcome.failure, /h1 exited with code 1/);
		assert.match(outcome.failure, /h1 wrote no result file/);
		writeFileSync(files[1], "{}");
		assert.deepEqual(trialOutcome("completed", [states[0], states[0]], files), { status: "completed" });
		assert.deepEqual(trialOutcome("stalled", states, files), { status: "stalled" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
