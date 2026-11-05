import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { azJson, redact, retrying, runCommand, settleAll, shellQuote } from "../distributed/harness/commands.mjs";
import { DistributedCommandError, isDistributedCommandError } from "../distributed/harness/errors.mjs";

const posixOnly = test.skipIf(process.platform === "win32");

test("redaction removes registered secrets, JWTs, bearer headers and private keys", () => {
	const jwt = "eyJhbGciOiJFZERTQSJ9.eyJwIjp7fX0xxxx.c2lnbmF0dXJlLXZhbHVl";
	assert.equal(redact(`token=${jwt}`, []), "token=[redacted-jwt]");
	assert.equal(redact("Authorization: Bearer abc.def", []), "Authorization: Bearer [redacted]");
	assert.equal(redact("authorization:bearer xyz rest", []), "authorization:bearer [redacted] rest");
	assert.equal(redact("a s3cr3t-value b s3cr3t-value", ["s3cr3t-value"]), "a [redacted] b [redacted]");
	assert.equal(redact("short abc", ["abc"]), "short abc");
	assert.equal(redact("eight888 x", ["eight888"]), "[redacted] x");
	assert.equal(
		redact("-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY----- tail", []),
		"[redacted-private-key] tail",
	);
	assert.equal(
		redact("-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----", []),
		"[redacted-private-key]",
	);
	assert.equal(redact("eyJshort.a.b", []), "eyJshort.a.b");
	assert.equal(redact("plain", new Set(["unrelated-secret"])), "plain");
});

test("shell words are quoted only when they need it", () => {
	assert.equal(shellQuote("/opt/adt/node/bin/node"), "/opt/adt/node/bin/node");
	assert.equal(shellQuote("--namespace=smoke"), "--namespace=smoke");
	assert.equal(shellQuote("a@b:c,d+e%f"), "a@b:c,d+e%f");
	assert.equal(shellQuote("two words"), "'two words'");
	assert.equal(shellQuote("it's"), "'it'\\''s'");
	assert.equal(shellQuote(""), "''");
	assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
	assert.equal(shellQuote("a;b"), "'a;b'");
});

test("settleAll waits for every operation, fails with the first rejection and keeps the others", async () => {
	const finished: string[] = [];
	const slow = new Promise<void>((resolve) =>
		setTimeout(() => {
			finished.push("slow");
			resolve();
		}, 30),
	);
	const first = new Error("first");
	const second = new Error("second");
	await assert.rejects(settleAll([Promise.reject(first), slow, Promise.reject(second)]), (error) => {
		assert.equal(error, first);
		assert.deepEqual(Reflect.get(first, "concurrentFailures"), [second]);
		assert.ok(!Object.keys(first).includes("concurrentFailures"));
		return true;
	});
	assert.deepEqual(finished, ["slow"]);
	const alone = new Error("alone");
	await assert.rejects(settleAll([Promise.reject(alone), Promise.resolve(1)]), (error) => error === alone);
	assert.equal(Reflect.get(alone, "concurrentFailures"), undefined);
	assert.deepEqual(await settleAll<number | string>([Promise.resolve(1), Promise.resolve("two")]), [1, "two"]);
	assert.deepEqual(await settleAll([]), []);
});

test("retrying repeats only retryable failures, up to the attempt limit", async () => {
	let calls = 0;
	const retryable = () =>
		new DistributedCommandError({ tool: "ssh", operation: "o", exitCode: 255, signal: null, retryable: true });
	assert.equal(
		await retrying(
			async () => {
				calls++;
				if (calls < 3) throw retryable();
				return "done";
			},
			{ attempts: 5, delayMs: 1 },
		),
		"done",
	);
	assert.equal(calls, 3);
	calls = 0;
	await assert.rejects(
		retrying(
			async () => {
				calls++;
				throw retryable();
			},
			{ attempts: 2, delayMs: 1 },
		),
		(error) => isDistributedCommandError(error),
	);
	assert.equal(calls, 2);
	calls = 0;
	await assert.rejects(
		retrying(
			async () => {
				calls++;
				throw new Error("permanent");
			},
			{ attempts: 5, delayMs: 1 },
		),
		/permanent/,
	);
	assert.equal(calls, 1);
	const controller = new AbortController();
	controller.abort();
	calls = 0;
	await assert.rejects(
		retrying(
			async () => {
				calls++;
				throw retryable();
			},
			{ attempts: 5, delayMs: 1, signal: controller.signal },
		),
	);
	assert.equal(calls, 1);
});

posixOnly("az output is parsed as JSON, empty output is null, and anything else is a typed failure", async () => {
	const dir = mkdtempSync(join(tmpdir(), "adt-az-json-"));
	const script = (body: string) =>
		writeFileSync(join(dir, "az"), `#!/bin/sh\necho "$@" >> ${join(dir, "calls")}\n${body}\n`, { mode: 0o755 });
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	const context = { secrets: new Set<string>() };
	try {
		script("echo '[\"a\", 1]'");
		assert.deepEqual(await azJson(context, ["group", "list"], { operation: "list", timeoutMs: 20_000 }), ["a", 1]);
		assert.equal(readFileSync(join(dir, "calls"), "utf8").trim(), "group list -o json --only-show-errors");
		script("printf '  \\n'");
		assert.equal(await azJson(context, ["group", "exists"], { operation: "exists", timeoutMs: 20_000 }), null);
		script("echo 'not json'");
		await assert.rejects(azJson(context, ["vm", "show"], { operation: "show", timeoutMs: 20_000 }), (error) => {
			assert.ok(isDistributedCommandError(error));
			assert.deepEqual(Reflect.get(error as object, "fields"), {
				tool: "az",
				operation: "show",
				exitCode: 0,
				signal: null,
				detail: "output was not JSON",
			});
			assert.ok(Reflect.get(error as object, "cause") instanceof SyntaxError);
			return true;
		});
	} finally {
		process.env.PATH = path;
	}
});

posixOnly("commands log redacted lines, honour cwd and report signals, long stderr and elapsed time", async () => {
	const dir = mkdtempSync(join(tmpdir(), "adt-run-"));
	const log = join(dir, "commands.log");
	const context = { log, secrets: new Set(["very-secret-value"]) };
	const node = process.execPath;
	const here = await runCommand(context, node, ["-e", "process.stdout.write(process.cwd())"], {
		operation: "cwd",
		timeoutMs: 20_000,
		cwd: dir,
	});
	assert.equal(here.stdout, realpathSync(dir));
	assert.ok(here.elapsedMs >= 0 && here.elapsedMs < 20_000);
	await runCommand(context, node, ["-e", "process.stderr.write('  very-secret-value  ')"], {
		operation: "noisy",
		timeoutMs: 20_000,
	});
	const lines = readFileSync(log, "utf8").trimEnd().split("\n");
	assert.match(
		lines[0],
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \$ \S+ -e process\.stdout\.write\(process\.cwd\(\)\) {2}# cwd$/,
	);
	assert.match(lines[1], /^\S+ = \S+ cwd exit=0 \d+ms$/);
	assert.match(lines[3], /^\S+ = \S+ noisy exit=0 \d+ms$/);
	assert.equal(lines[4], "  stderr: [redacted]");
	await assert.rejects(
		runCommand(context, node, ["-e", "process.kill(process.pid, 'SIGKILL')"], {
			operation: "killed",
			timeoutMs: 20_000,
			allowExitCodes: [0],
		}),
		(error) => {
			assert.deepEqual(Reflect.get(error as object, "fields"), {
				tool: node,
				operation: "killed",
				exitCode: null,
				signal: "SIGKILL",
				detail: "",
			});
			return true;
		},
	);
	assert.match(readFileSync(log, "utf8"), / killed exit=SIGKILL \d+ms/);
	await assert.rejects(
		runCommand(context, node, ["-e", "console.error('x'.repeat(1000)); process.exit(1)"], {
			operation: "long",
			timeoutMs: 20_000,
		}),
		(error) => {
			assert.equal(String(Reflect.get(error as object, "fields").detail).length, 400);
			return true;
		},
	);
	const slowStarted = performance.now();
	await assert.rejects(
		runCommand(context, node, ["-e", "setTimeout(() => {}, 60000)"], { operation: "slow", timeoutMs: 100 }),
		(error) => {
			const elapsedMs = Number(Reflect.get(error as object, "fields").elapsedMs);
			assert.ok(elapsedMs >= 95 && elapsedMs <= performance.now() - slowStarted + 5, String(elapsedMs));
			return true;
		},
	);
	await runCommand(context, node, ["-e", "process.exit(0)"], {
		operation: "ignores stdin",
		timeoutMs: 20_000,
		input: "x".repeat(8 * 1024 * 1024),
	});
	assert.match(readFileSync(log, "utf8"), /stdin of \S+ ignores stdin closed early: EPIPE/);
	assert.equal(redact("Authorization: Bearer   spaced-token-value", []), "Authorization: Bearer   [redacted]");
});

posixOnly("a timeout kills the command's whole process group, so a wrapper's child cannot hold it open", async () => {
	const context = { secrets: new Set<string>() };
	const started = performance.now();
	await assert.rejects(
		runCommand(context, "sh", ["-c", "sleep 30; true"], { operation: "wrapped", timeoutMs: 300 }),
		(error) => {
			assert.equal(Reflect.get(error as object, "code"), "timeout");
			return true;
		},
	);
	assert.ok(performance.now() - started < 10_000);
	const controller = new AbortController();
	const reason = new DOMException("stop", "AbortError");
	const pending = runCommand(context, "sh", ["-c", "sleep 30; true"], {
		operation: "wrapped abort",
		timeoutMs: 20_000,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(reason), 200);
	await assert.rejects(pending, (error) => error === reason);
	assert.ok(performance.now() - started < 20_000);
});

test("the command log omits empty stderr, bounds long stderr, and records a kill that found nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "adt-log-"));
	const log = join(dir, "commands.log");
	const context = { log, secrets: new Set<string>() };
	const node = process.execPath;
	const before = performance.now();
	const quiet = await runCommand(context, node, ["-e", "process.stderr.write('   ')"], {
		operation: "quiet",
		timeoutMs: 20_000,
	});
	assert.ok(quiet.elapsedMs <= performance.now() - before + 5);
	await runCommand(context, node, ["-e", "process.stderr.write('y'.repeat(5000))"], {
		operation: "loud",
		timeoutMs: 20_000,
	});
	const lines = readFileSync(log, "utf8").trimEnd().split("\n");
	assert.match(lines[1], /^\S+ = \S+ quiet exit=0 \d+ms$/);
	assert.equal(lines[4], `  stderr: ${"y".repeat(2000)}`);
	const controller = new AbortController();
	const pending = runCommand(context, "/nonexistent/adt-tool", [], {
		operation: "gone",
		timeoutMs: 20_000,
		signal: controller.signal,
	});
	controller.abort(new DOMException("stop", "AbortError"));
	await assert.rejects(pending);
	assert.match(
		readFileSync(log, "utf8"),
		/kill of \/nonexistent\/adt-tool gone found no process group: ERR_INVALID_ARG_TYPE/,
	);
});
