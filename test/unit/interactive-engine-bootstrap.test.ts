import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	INTERACTIVE_ENGINE_BOOTSTRAP_FLAG,
	INTERACTIVE_ENGINE_BOOTSTRAP_VERSION,
	hasInteractiveEngineBootstrapArg,
	readInteractiveEngineBootstrap,
	removeInteractiveEngineBootstrap,
	takeInteractiveEngineBootstrapArg,
	writeInteractiveEngineBootstrap,
} from "../../packages/coding-agent/src/utils/interactive-engine-bootstrap.ts";

/**
 * The engine's startup metadata cannot travel in the environment: under Bun a
 * child spawned without an explicit `env` inherits the runtime's launch-time
 * environment, so anything put there stays reachable by every descendant no
 * matter what the engine deletes from `process.env`. It travels in a 0600 file
 * whose path is a private CLI argument, read once and unlinked.
 */

test("a bootstrap record round-trips and is consumed on read", () => {
	const path = writeInteractiveEngineBootstrap({
		hostPid: 4242,
		guardFile: "/tmp/atomic-engine-guardian-4242",
		apiKey: "sk-never-in-an-environment",
	});
	assert.ok(existsSync(path));
	const record = readInteractiveEngineBootstrap(path);
	assert.deepEqual(record, {
		version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION,
		hostPid: 4242,
		guardFile: "/tmp/atomic-engine-guardian-4242",
		apiKey: "sk-never-in-an-environment",
	});
	assert.equal(existsSync(path), false, "the record must not outlive the handshake");
	assert.equal(existsSync(dirname(path)), false, "the private directory must be removed too");
	assert.equal(readInteractiveEngineBootstrap(path), undefined, "a consumed record cannot be replayed");
});

test("a bootstrap record is owner-only and its filename carries no secret", () => {
	const path = writeInteractiveEngineBootstrap({
		hostPid: 1,
		guardFile: "/tmp/guard",
		apiKey: "sk-secret-material",
	});
	try {
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.ok(!path.includes("sk-secret-material"));
	} finally {
		removeInteractiveEngineBootstrap(path);
	}
});

test("a bootstrap record without an API key omits the field", () => {
	const path = writeInteractiveEngineBootstrap({ hostPid: 7, guardFile: "/tmp/guard-7" });
	const record = readInteractiveEngineBootstrap(path);
	assert.equal(record?.apiKey, undefined);
	assert.ok(record && !("apiKey" in record));
});

test("a malformed or foreign-version record is rejected and still consumed", () => {
	for (const content of ["{ not json", JSON.stringify({ version: 99, hostPid: 1, guardFile: "/tmp/g" }), JSON.stringify({ version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION })]) {
		const path = writeInteractiveEngineBootstrap({ hostPid: 1, guardFile: "/tmp/guard" });
		writeFileSync(path, content, "utf8");
		assert.equal(readInteractiveEngineBootstrap(path), undefined, `accepted ${content}`);
		assert.equal(existsSync(path), false, "a rejected record must still be unlinked");
	}
});

test("a missing record reads as undefined without throwing", () => {
	assert.equal(readInteractiveEngineBootstrap(join("/tmp", "atomic-bootstrap-does-not-exist", "bootstrap.json")), undefined);
	removeInteractiveEngineBootstrap(undefined);
});

test("the private argument is stripped before normal CLI parsing", () => {
	const separate = takeInteractiveEngineBootstrapArg([
		"--mode", "rpc", INTERACTIVE_ENGINE_BOOTSTRAP_FLAG, "/tmp/b/bootstrap.json", "--approve",
	]);
	assert.deepEqual(separate.args, ["--mode", "rpc", "--approve"]);
	assert.equal(separate.path, "/tmp/b/bootstrap.json");

	const inline = takeInteractiveEngineBootstrapArg([`${INTERACTIVE_ENGINE_BOOTSTRAP_FLAG}=/tmp/c/bootstrap.json`, "--offline"]);
	assert.deepEqual(inline.args, ["--offline"]);
	assert.equal(inline.path, "/tmp/c/bootstrap.json");

	const absent = takeInteractiveEngineBootstrapArg(["--mode", "rpc"]);
	assert.deepEqual(absent.args, ["--mode", "rpc"]);
	assert.equal(absent.path, undefined);
	// A trailing flag with no value is not a bootstrap and must not be swallowed.
	assert.deepEqual(takeInteractiveEngineBootstrapArg([INTERACTIVE_ENGINE_BOOTSTRAP_FLAG]).args, [INTERACTIVE_ENGINE_BOOTSTRAP_FLAG]);
});

test("engine mode is selected by the bootstrap argument, which nothing inherits", () => {
	assert.equal(hasInteractiveEngineBootstrapArg(["--mode", "rpc", INTERACTIVE_ENGINE_BOOTSTRAP_FLAG, "/tmp/b.json"]), true);
	assert.equal(hasInteractiveEngineBootstrapArg(["--mode", "rpc"]), false);
	assert.equal(hasInteractiveEngineBootstrapArg([]), false);
});

test("the published path never exposes partially written content", () => {
	// Publication is temp-file + rename, so a reader polling for existence of the
	// final path can only ever observe complete JSON.
	for (let attempt = 0; attempt < 25; attempt += 1) {
		const path = writeInteractiveEngineBootstrap({ hostPid: attempt, guardFile: `/tmp/guard-${attempt}` });
		const raw = readFileSync(path, "utf8");
		assert.deepEqual(JSON.parse(raw), {
			version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION,
			hostPid: attempt,
			guardFile: `/tmp/guard-${attempt}`,
		});
		removeInteractiveEngineBootstrap(path);
	}
});
