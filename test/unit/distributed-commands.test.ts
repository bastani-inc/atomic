import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { azJson, redact, retrying, settleAll, shellQuote } from "../distributed/harness/commands.mjs";
import { DistributedCommandError, isDistributedCommandError } from "../distributed/harness/errors.mjs";

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

test("settleAll waits for every operation before failing with the first rejection", async () => {
	const finished: string[] = [];
	const slow = new Promise<void>((resolve) =>
		setTimeout(() => {
			finished.push("slow");
			resolve();
		}, 30),
	);
	const first = new Error("first");
	await assert.rejects(
		settleAll([Promise.reject(first), slow, Promise.reject(new Error("second"))]),
		(error) => error === first,
	);
	assert.deepEqual(finished, ["slow"]);
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

test("az output is parsed as JSON, empty output is null, and anything else is a typed failure", async () => {
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
