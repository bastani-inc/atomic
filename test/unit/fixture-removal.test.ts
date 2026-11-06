import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	FIXTURE_REMOVAL_MAX_ATTEMPTS,
	FixtureRemovalError,
	isFixtureRemovalError,
	removeFixtureTree,
	runThenRemoveFixtureTree,
} from "../helpers/fixture-removal.js";
import { sleep } from "../helpers/runtime.js";

const TREE = "C:\\fixture\\atomic-install-0\\payload";

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: unlink '${TREE}\\atomic.exe'`), { code, syscall: "unlink" });
}

interface Recorder {
	readonly removals: string[];
	readonly sleeps: number[];
	readonly warnings: string[];
	readonly options: {
		readonly remove: (path: string) => void;
		readonly sleep: (milliseconds: number) => void;
		readonly warn: (message: string) => void;
	};
}

function recorder(failures: readonly unknown[]): Recorder {
	const removals: string[] = [];
	const sleeps: number[] = [];
	const warnings: string[] = [];
	return {
		removals,
		sleeps,
		warnings,
		options: {
			remove: (path) => {
				const failure = failures[removals.length];
				removals.push(path);
				if (failure !== undefined) throw failure;
			},
			sleep: (milliseconds) => {
				sleeps.push(milliseconds);
			},
			warn: (message) => {
				warnings.push(message);
			},
		},
	};
}

function exhaustedFailures(): NodeJS.ErrnoException[] {
	return Array.from({ length: FIXTURE_REMOVAL_MAX_ATTEMPTS }, () => errno("EPERM"));
}

test("a removal that succeeds at once neither pauses nor warns (#4483)", () => {
	const run = recorder([]);
	assert.deepEqual(removeFixtureTree(TREE, run.options), { attempts: 1, retriedErrors: [] });
	assert.deepEqual(run.removals, [TREE]);
	assert.deepEqual(run.sleeps, []);
	assert.deepEqual(run.warnings, []);
});

test("EPERM, EBUSY and ENOTEMPTY are retried after a linear backoff and the recovery is reported once (#4483)", () => {
	const run = recorder([errno("EPERM"), errno("EBUSY"), errno("ENOTEMPTY")]);
	assert.deepEqual(removeFixtureTree(TREE, run.options), {
		attempts: 4,
		retriedErrors: ["EPERM", "EBUSY", "ENOTEMPTY"],
	});
	assert.deepEqual(run.removals, [TREE, TREE, TREE, TREE]);
	assert.deepEqual(run.sleeps, [50, 100, 150]);
	assert.deepEqual(run.warnings, [`Removed ${TREE} after 4 attempts; retried EPERM, EBUSY, ENOTEMPTY.`]);
});

test("a lock that outlives every attempt is a removal-exhausted FixtureRemovalError carrying the last failure (#4483)", () => {
	const failures = exhaustedFailures();
	const run = recorder(failures);
	assert.throws(
		() => removeFixtureTree(TREE, run.options),
		(error) => {
			assert.ok(error instanceof FixtureRemovalError);
			assert.equal(error.name, "FixtureRemovalError");
			assert.equal(error.code, "removal-exhausted");
			assert.equal(error.path, TREE);
			assert.equal(error.attempts, 20);
			assert.equal(error.errno, "EPERM");
			assert.equal(error.cause, failures[19]);
			assert.match(error.hint, /holds a file/u);
			return true;
		},
	);
	assert.equal(run.removals.length, 20, "the bound is exactly FIXTURE_REMOVAL_MAX_ATTEMPTS removals");
	assert.deepEqual(
		run.sleeps,
		Array.from({ length: 19 }, (_, index) => 50 * (index + 1)),
		"no pause follows the last attempt",
	);
	assert.deepEqual(run.warnings, []);
});

test("the attempt before the bound still recovers (#4483)", () => {
	const run = recorder(exhaustedFailures().slice(1));
	assert.equal(removeFixtureTree(TREE, run.options).attempts, 20);
	assert.equal(run.sleeps.length, 19);
	assert.equal(run.warnings.length, 1);
});

for (const [label, thrown, expectedErrno] of [
	["EACCES", errno("EACCES"), "EACCES"],
	["an Error without a code", new Error("disk vanished"), undefined],
	["a non-string code", Object.assign(new Error("odd"), { code: 5 }), undefined],
	["a thrown string", "EPERM", undefined],
	["null", null, undefined],
] as const) {
	test(`${label} is not a lock: removal-refused after one attempt, without a pause (#4483)`, () => {
		const run = recorder([thrown]);
		assert.throws(
			() => removeFixtureTree(TREE, run.options),
			(error) => {
				assert.ok(isFixtureRemovalError(error));
				assert.equal(error.code, "removal-refused");
				assert.equal(error.attempts, 1);
				assert.equal(error.errno, expectedErrno);
				assert.equal(error.cause, thrown);
				assert.match(error.hint, /not a transient Windows lock/u);
				return true;
			},
		);
		assert.equal(run.removals.length, 1);
		assert.deepEqual(run.sleeps, []);
	});
}

test("a lock error after retries that turns into another failure is refused at that attempt (#4483)", () => {
	const run = recorder([errno("EBUSY"), errno("EACCES")]);
	assert.throws(
		() => removeFixtureTree(TREE, run.options),
		(error) => isFixtureRemovalError(error) && error.code === "removal-refused" && error.attempts === 2,
	);
	assert.deepEqual(run.sleeps, [50]);
	assert.deepEqual(run.warnings, []);
});

test("the removal error message names the path, code, attempts, last error and next step (#4483)", () => {
	const error = new FixtureRemovalError(
		{ code: "removal-exhausted", path: TREE, attempts: 20, errno: "EPERM" },
		{ cause: errno("EPERM") },
	);
	assert.equal(
		error.message,
		`Fixture removal failed: ${TREE} (removal-exhausted) after 20 attempts, last error EPERM. A process or scanner still holds a file under it; find the holder (for example with Get-Process or handle.exe) and rerun.`,
	);
	const refused = new FixtureRemovalError(
		{ code: "removal-refused", path: TREE, attempts: 1, errno: undefined },
		{ cause: "gone" },
	);
	assert.match(refused.message, /\(removal-refused\) after 1 attempts, last error without a code\./u);
});

test("isFixtureRemovalError matches a FixtureRemovalError by name and code after it crossed a boundary (#4483)", () => {
	assert.equal(isFixtureRemovalError({ name: "FixtureRemovalError", code: "removal-exhausted" }), true);
	assert.equal(isFixtureRemovalError({ name: "FixtureRemovalError", code: "removal-refused" }), true);
	assert.equal(isFixtureRemovalError({ name: "FixtureRemovalError", code: "removal-failed" }), false);
	assert.equal(isFixtureRemovalError({ name: "Error", code: "removal-exhausted" }), false);
	assert.equal(isFixtureRemovalError(errno("EPERM")), false);
	assert.equal(isFixtureRemovalError(null), false);
	assert.equal(isFixtureRemovalError("FixtureRemovalError"), false);
});

test("a real tree is removed with the default remover, and a missing tree counts as removed (#4483)", () => {
	const tree = mkdtempSync(join(tmpdir(), "atomic-fixture-removal-"));
	mkdirSync(join(tree, "payload", "nested"), { recursive: true });
	writeFileSync(join(tree, "payload", "nested", "atomic.exe"), "fixture");
	assert.deepEqual(removeFixtureTree(tree), { attempts: 1, retriedErrors: [] });
	assert.equal(existsSync(tree), false);
	assert.deepEqual(removeFixtureTree(tree), { attempts: 1, retriedErrors: [] });
});

test("runThenRemoveFixtureTree returns the work's value and removes the tree after it (#4483)", () => {
	const order: string[] = [];
	const run = recorder([]);
	const value = runThenRemoveFixtureTree(
		TREE,
		() => {
			order.push("work");
			return "SCENARIO_OK";
		},
		{
			...run.options,
			remove: (path) => {
				order.push("remove");
				run.options.remove(path);
			},
		},
	);
	assert.equal(value, "SCENARIO_OK");
	assert.deepEqual(order, ["work", "remove"]);
});

test("a work failure is rethrown unchanged once the tree is removed (#4483)", () => {
	const primary = new assert.AssertionError({ message: "PowerShell fixture missing-cmd-pathext failed." });
	const run = recorder([errno("EPERM")]);
	assert.throws(
		() =>
			runThenRemoveFixtureTree(
				TREE,
				() => {
					throw primary;
				},
				run.options,
			),
		(error) => error === primary && !("cleanupCause" in primary),
	);
	assert.equal(run.removals.length, 2, "the tree is still removed, with retries, after a failure");
});

test("when the tree cannot be removed after a work failure, the work failure is thrown with the removal error as cleanupCause (#4483)", () => {
	const primary = new assert.AssertionError({ message: "PowerShell fixture missing-cmd-pathext failed." });
	const run = recorder(exhaustedFailures());
	assert.throws(
		() =>
			runThenRemoveFixtureTree(
				TREE,
				() => {
					throw primary;
				},
				run.options,
			),
		(error) => {
			assert.equal(error, primary);
			assert.ok("cleanupCause" in primary);
			assert.ok(isFixtureRemovalError(primary.cleanupCause));
			assert.equal(primary.cleanupCause.code, "removal-exhausted");
			assert.equal(primary.cleanupCause.attempts, 20);
			return true;
		},
	);
});

test("a thrown non-Error and the removal failure are both kept in an AggregateError (#4483)", () => {
	const run = recorder([errno("EACCES")]);
	assert.throws(
		() =>
			runThenRemoveFixtureTree(
				TREE,
				() => {
					throw "fixture aborted";
				},
				run.options,
			),
		(error) => {
			assert.ok(error instanceof AggregateError);
			assert.equal(error.errors[0], "fixture aborted");
			assert.ok(isFixtureRemovalError(error.errors[1]));
			assert.equal(error.errors[1].code, "removal-refused");
			assert.match(error.message, /removing .+ failed too/u);
			return true;
		},
	);
});

test("a removal failure after successful work is thrown as the FixtureRemovalError (#4483)", () => {
	const run = recorder([errno("EACCES")]);
	assert.throws(
		() => runThenRemoveFixtureTree(TREE, () => "SCENARIO_OK", run.options),
		(error) => isFixtureRemovalError(error) && error.code === "removal-refused" && error.path === TREE,
	);
});

const windowsTest = process.platform === "win32" ? test : test.skip;
const REAL_IMAGE_LOCK_TIMEOUT_MS = 90_000;
const HOLDER_START_DEADLINE_MS = 60_000;

windowsTest(
	"a running image from the tree blocks one removal attempt but not the retried removal once it exits (#4483)",
	async () => {
		const control = mkdtempSync(join(tmpdir(), "atomic-fixture-removal-control-"));
		const tree = mkdtempSync(join(tmpdir(), "atomic-fixture-removal-image-"));
		try {
			const image = join(tree, "payload", "atomic.exe");
			mkdirSync(join(tree, "payload"));
			copyFileSync(process.execPath, image);
			const ready = join(control, "ready");
			const release = join(control, "release");
			const holderScript = join(control, "holder.cjs");
			writeFileSync(
				holderScript,
				[
					'const { existsSync, writeFileSync } = require("node:fs");',
					`writeFileSync(${JSON.stringify(ready)}, "");`,
					`const poll = setInterval(() => { if (existsSync(${JSON.stringify(release)})) clearInterval(poll); }, 20);`,
				].join("\n"),
			);
			const holder = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${image}" "${holderScript}""`], {
				windowsVerbatimArguments: true,
				stdio: "ignore",
			});
			const holderExit = new Promise<number | null>((resolve) => holder.once("exit", resolve));
			for (let waited = 0; !existsSync(ready); waited += 25) {
				assert.ok(waited < HOLDER_START_DEADLINE_MS, "the image copy never started");
				await sleep(25);
			}

			assert.throws(
				() => rmSync(tree, { recursive: true, force: true }),
				(error) => error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EBUSY"),
				"a single removal attempt must fail while the image runs",
			);

			const warnings: string[] = [];
			const removal = removeFixtureTree(tree, {
				sleep: (milliseconds) => {
					writeFileSync(release, "");
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
				},
				warn: (message) => {
					warnings.push(message);
				},
			});
			assert.ok(removal.attempts >= 2, `the removal was not retried: ${JSON.stringify(removal)}`);
			assert.ok(
				removal.retriedErrors.every((code) => code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY"),
				`unexpected retried errors: ${removal.retriedErrors.join(", ")}`,
			);
			assert.equal(existsSync(tree), false);
			assert.equal(warnings.length, 1);
			assert.equal(await holderExit, 0);
		} finally {
			writeFileSync(join(control, "release"), "");
			rmSync(control, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
			rmSync(tree, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		}
	},
	REAL_IMAGE_LOCK_TIMEOUT_MS,
);
