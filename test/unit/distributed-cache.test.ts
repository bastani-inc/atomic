import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { cacheFile } from "../distributed/harness/cache.mjs";
import { DistributedProvisionError } from "../distributed/harness/errors.mjs";

test("concurrent cache producers publish one complete immutable entry (#4331)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "distributed-cache-"));
	try {
		const path = join(dir, "artifact");
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const staging: string[] = [];
		const produce = (value: string) =>
			cacheFile(path, async (temporary) => {
				assert.equal(dirname(dirname(temporary)), dir);
				staging.push(temporary);
				writeFileSync(temporary, value);
				if (staging.length === 2) release();
				await barrier;
			});
		const results = await Promise.all([produce("first"), produce("second")]);
		assert.notEqual(staging[0], staging[1]);
		assert.deepEqual(results.sort(), [false, true]);
		const value = readFileSync(path, "utf8");
		assert.ok(value === "first" || value === "second");
		assert.equal(await cacheFile(path, async () => assert.fail("warm cache must not rebuild")), true);
		assert.equal(readFileSync(path, "utf8"), value);
		assert.deepEqual(readdirSync(dir), ["artifact"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("failed validation never publishes partial cache bytes and removes staging (#4331)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "distributed-cache-"));
	try {
		const cause = new DistributedProvisionError({ step: "validate", resource: "artifact" });
		await assert.rejects(
			cacheFile(join(dir, "artifact"), async (temporary) => {
				writeFileSync(temporary, "partial");
				throw cause;
			}),
			(error) => error === cause,
		);
		assert.deepEqual(readdirSync(dir), []);
		const cancelled = new DOMException("cancelled", "AbortError");
		await assert.rejects(
			cacheFile(join(dir, "artifact"), async () => {
				throw cancelled;
			}),
			(error) => error === cancelled,
		);
		assert.deepEqual(readdirSync(dir), []);
		await assert.rejects(
			cacheFile(join(dir, "artifact"), async (temporary) => {
				rmSync(dirname(temporary), { recursive: true });
				throw cause;
			}),
			(error) => error === cause,
		);
		assert.equal(cause.cleanupCause, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cache publication wraps filesystem failures without losing their cause (#4331)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "distributed-cache-"));
	try {
		await assert.rejects(
			cacheFile(join(dir, "artifact"), async () => {}),
			(error) => {
				assert.ok(error instanceof DistributedProvisionError);
				assert.equal(error.code, "provision-failed");
				assert.equal(error.fields.step, "publish cache entry");
				assert.ok(error.cause instanceof Error && "code" in error.cause);
				assert.equal(error.cause.code, "ENOENT");
				return true;
			},
		);
		assert.deepEqual(readdirSync(dir), []);
		writeFileSync(join(dir, "file"), "not a directory");
		await assert.rejects(
			cacheFile(join(dir, "file", "artifact"), async () => assert.fail("must fail before producing")),
			(error) => {
				assert.ok(error instanceof DistributedProvisionError);
				assert.equal(error.fields.step, "publish cache entry");
				assert.equal(error.cleanupCause, undefined);
				return true;
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
