import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import {
	hasInteractiveEngineBootstrapArg,
	INTERACTIVE_ENGINE_BOOTSTRAP_FLAG,
	INTERACTIVE_ENGINE_BOOTSTRAP_VERSION,
	readInteractiveEngineBootstrap,
	removeOwnedInteractiveEngineBootstrap,
	takeInteractiveEngineBootstrapArg,
	writeInteractiveEngineBootstrap,
} from "../../packages/coding-agent/src/utils/interactive-engine-bootstrap.ts";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

/**
 * The engine's startup metadata cannot travel in the environment: under Bun a
 * child spawned without an explicit `env` inherits the runtime's launch-time
 * environment, so anything put there stays reachable by every descendant no
 * matter what the engine deletes from `process.env`. It travels in a 0600 file
 * whose path is a private CLI argument, read once and unlinked.
 *
 * Cleanup is ownership-scoped: the path is untrusted child input, so a reader
 * may unlink only that exact file, while recursive removal requires the handle
 * the writer received when it created the directory.
 */

test("a bootstrap record round-trips and the reader consumes only the named file", () => {
	const handle = writeInteractiveEngineBootstrap({
		hostPid: 4242,
		guardFile: "/tmp/atomic-engine-guardian-4242",
		apiKey: "sk-never-in-an-environment",
	});
	try {
		assert.ok(existsSync(handle.path));
		assert.deepEqual(readInteractiveEngineBootstrap(handle.path), {
			version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION,
			hostPid: 4242,
			guardFile: "/tmp/atomic-engine-guardian-4242",
			apiKey: "sk-never-in-an-environment",
		});
		assert.equal(existsSync(handle.path), false, "the record must not outlive the handshake");
		assert.equal(existsSync(handle.directory), true, "the reader must not remove a directory it does not own");
		assert.equal(readInteractiveEngineBootstrap(handle.path), undefined, "a consumed record cannot be replayed");
	} finally {
		removeOwnedInteractiveEngineBootstrap(handle);
	}
	assert.equal(existsSync(handle.directory), false, "the owner's handle removes the directory it created");
});

test("a bootstrap record is owner-only and its filename carries no secret", () => {
	const handle = writeInteractiveEngineBootstrap({
		hostPid: 1,
		guardFile: "/tmp/guard",
		apiKey: "sk-secret-material",
	});
	try {
		// POSIX mode bits do not exist on Windows: writeFileSync's mode option
		// maps only to the read-only attribute, and stat reports 0o666 for any
		// writable file. There the record's protection is the per-user temp
		// directory ACL, so only the POSIX platforms can assert owner-only bits.
		if (process.platform !== "win32") {
			assert.equal(statSync(handle.path).mode & 0o777, 0o600);
		}
		assert.ok(!handle.path.includes("sk-secret-material"));
		assert.ok(!handle.directory.includes("sk-secret-material"));
	} finally {
		removeOwnedInteractiveEngineBootstrap(handle);
	}
});

test("a bootstrap record without an API key omits the field", () => {
	const handle = writeInteractiveEngineBootstrap({ hostPid: 7, guardFile: "/tmp/guard-7" });
	try {
		const record = readInteractiveEngineBootstrap(handle.path);
		assert.equal(record?.apiKey, undefined);
		assert.ok(record && !("apiKey" in record));
	} finally {
		removeOwnedInteractiveEngineBootstrap(handle);
	}
});

test("a malformed or foreign-version record is rejected and still consumed", () => {
	for (const content of [
		"{ not json",
		JSON.stringify({ version: 99, hostPid: 1, guardFile: "/tmp/g" }),
		JSON.stringify({ version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION }),
	]) {
		const handle = writeInteractiveEngineBootstrap({ hostPid: 1, guardFile: "/tmp/guard" });
		try {
			writeFileSync(handle.path, content, "utf8");
			assert.equal(readInteractiveEngineBootstrap(handle.path), undefined, `accepted ${content}`);
			assert.equal(existsSync(handle.path), false, "a rejected record must still be unlinked");
		} finally {
			removeOwnedInteractiveEngineBootstrap(handle);
		}
	}
});

/**
 * Anyone can pass the private flag, so the reader must treat the path as hostile
 * input: it may unlink that file and nothing else. Recursively removing the
 * parent would let an arbitrary argv value delete an unrelated directory.
 */
test("an attacker-supplied bootstrap path never removes anything but that file", () => {
	const victim = mkdtempSync(join(tmpdir(), "atomic-bootstrap-victim-"));
	const sibling = join(victim, "important.txt");
	const nested = join(victim, "nested");
	mkdirSync(nested);
	writeFileSync(sibling, "keep me", "utf8");
	writeFileSync(join(nested, "deep.txt"), "keep me too", "utf8");

	// Missing file at an arbitrary path.
	assert.equal(readInteractiveEngineBootstrap(join(victim, "bootstrap.json")), undefined);
	assert.equal(existsSync(victim), true, "the parent directory must survive");
	assert.equal(readFileSync(sibling, "utf8"), "keep me", "a sibling file must survive");
	assert.equal(readFileSync(join(nested, "deep.txt"), "utf8"), "keep me too");

	// Malformed file at an arbitrary path: only that file goes away.
	const planted = join(victim, "planted.json");
	writeFileSync(planted, "{ not json", "utf8");
	assert.equal(readInteractiveEngineBootstrap(planted), undefined);
	assert.equal(existsSync(planted), false, "the named file is consumed");
	assert.equal(existsSync(victim), true, "the parent directory must survive");
	assert.equal(readFileSync(sibling, "utf8"), "keep me");
	assert.deepEqual(readdirSync(victim).sort(), ["important.txt", "nested"]);
});

/** The same guarantee through the real CLI entry point, not just the helper. */
test("the CLI consumes a hostile --internal-engine-bootstrap path without touching its parent", async () => {
	const victim = mkdtempSync(join(tmpdir(), "atomic-bootstrap-cli-victim-"));
	const sibling = join(victim, "important.txt");
	writeFileSync(sibling, "keep me", "utf8");
	const result = spawnSyncCollect(
		[
			bunExecutable(),
			join(moduleDir(import.meta.url), "..", "..", "packages", "coding-agent", "src", "cli.ts"),
			"--version",
			INTERACTIVE_ENGINE_BOOTSTRAP_FLAG,
			join(victim, "bootstrap.json"),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.equal(existsSync(victim), true, "the CLI removed a directory it does not own");
	assert.equal(readFileSync(sibling, "utf8"), "keep me");
	assert.deepEqual(readdirSync(victim), ["important.txt"]);
});

test("a failed publication leaves no temporary file, no directory, and no secret", () => {
	// Scope the observed temp root: under vitest other test files run in
	// parallel and create their own atomic-engine-bootstrap-* directories in the
	// shared tmpdir, so a before/after snapshot of the real tmpdir races.
	const scoped = mkdtempSync(join(tmpdir(), "atomic-bootstrap-scope-"));
	const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
	process.env.TMPDIR = scoped;
	process.env.TMP = scoped;
	process.env.TEMP = scoped;
	try {
		const unwritable = {
			toJSON(): never {
				throw new Error("serialization failed");
			},
		};
		assert.throws(
			() =>
				writeInteractiveEngineBootstrap({
					hostPid: 1,
					guardFile: "/tmp/guard",
					apiKey: unwritable as unknown as string,
				}),
			/serialization failed/,
		);
		assert.deepEqual(readdirSync(scoped), [], "a failed publication must not leave its owned directory behind");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(scoped, { recursive: true, force: true });
	}
});

test("a missing record reads as undefined without throwing", () => {
	assert.equal(
		readInteractiveEngineBootstrap(join(tmpdir(), "atomic-bootstrap-does-not-exist", "bootstrap.json")),
		undefined,
	);
	removeOwnedInteractiveEngineBootstrap(undefined);
});

test("the private argument is stripped before normal CLI parsing", () => {
	const separate = takeInteractiveEngineBootstrapArg([
		"--mode",
		"rpc",
		INTERACTIVE_ENGINE_BOOTSTRAP_FLAG,
		"/tmp/b/bootstrap.json",
		"--approve",
	]);
	assert.deepEqual(separate.args, ["--mode", "rpc", "--approve"]);
	assert.equal(separate.path, "/tmp/b/bootstrap.json");

	const inline = takeInteractiveEngineBootstrapArg([
		`${INTERACTIVE_ENGINE_BOOTSTRAP_FLAG}=/tmp/c/bootstrap.json`,
		"--offline",
	]);
	assert.deepEqual(inline.args, ["--offline"]);
	assert.equal(inline.path, "/tmp/c/bootstrap.json");

	const absent = takeInteractiveEngineBootstrapArg(["--mode", "rpc"]);
	assert.deepEqual(absent.args, ["--mode", "rpc"]);
	assert.equal(absent.path, undefined);
	// A trailing flag with no value is not a bootstrap and must not be swallowed.
	assert.deepEqual(takeInteractiveEngineBootstrapArg([INTERACTIVE_ENGINE_BOOTSTRAP_FLAG]).args, [
		INTERACTIVE_ENGINE_BOOTSTRAP_FLAG,
	]);
});

test("engine mode is selected by the bootstrap argument, which nothing inherits", () => {
	assert.equal(
		hasInteractiveEngineBootstrapArg(["--mode", "rpc", INTERACTIVE_ENGINE_BOOTSTRAP_FLAG, "/tmp/b.json"]),
		true,
	);
	assert.equal(hasInteractiveEngineBootstrapArg(["--mode", "rpc"]), false);
	assert.equal(hasInteractiveEngineBootstrapArg([]), false);
});

test("the published path never exposes partially written content", () => {
	// Publication is temp-file + rename, so a reader polling for existence of the
	// final path can only ever observe complete JSON.
	for (let attempt = 0; attempt < 25; attempt += 1) {
		const handle = writeInteractiveEngineBootstrap({ hostPid: attempt, guardFile: `/tmp/guard-${attempt}` });
		assert.deepEqual(JSON.parse(readFileSync(handle.path, "utf8")), {
			version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION,
			hostPid: attempt,
			guardFile: `/tmp/guard-${attempt}`,
		});
		assert.equal(existsSync(`${handle.path}.tmp`), false, "the temporary sibling must not survive");
		assert.equal(dirname(handle.path), handle.directory);
		removeOwnedInteractiveEngineBootstrap(handle);
	}
});
