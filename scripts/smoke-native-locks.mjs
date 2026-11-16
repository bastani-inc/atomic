#!/usr/bin/env node
/**
 * Release smoke for the native advisory lock and no-replace rename (#5193): run with node or bun against a built
 * binding, as `smoke-native-locks.mjs <binding>`, where <binding> is the @bastani/atomic-natives package directory or
 * one platform's `.node` file. Exits non-zero, before anything is published, when the binding takes a lock another
 * holder keeps, keeps a lock its killed holder held, or renames over something.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, ...rest] = process.argv.slice(2);

if (mode === "--hold") {
	// The child: takes the lock and holds it until it is killed.
	const [binding, lockFile] = rest;
	// Kept reachable: a collected lock closes its file, which releases it.
	globalThis.heldLock = createRequire(import.meta.url)(resolve(binding)).tryAdvisoryLock(lockFile, 0);
	if (globalThis.heldLock === null) throw new Error("the holder could not take a free lock");
	process.stdout.write("held\n");
	setInterval(() => {}, 60_000);
} else {
	await smoke(mode);
}

/** Starts another process that holds the lock of `lockFile`; resolves once it does. */
function anotherProcessHolds(binding, lockFile) {
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--hold", binding, lockFile], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const exited = new Promise((done) => child.once("exit", done));
	const held = new Promise((done, fail) => {
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output.includes("held")) done();
		});
		child.once("exit", (code) => fail(new Error(`the holder exited (${code}) before it held the lock`)));
	});
	return { child, exited, held };
}

async function smoke(binding) {
	if (binding === undefined)
		throw new Error("usage: smoke-native-locks.mjs <binding package directory or .node file>");
	const native = createRequire(import.meta.url)(resolve(binding));
	const scratch = mkdtempSync(join(tmpdir(), "atomic-native-locks-smoke-"));
	try {
		const lockFile = join(scratch, "settings.json.lock.takeover.lock");

		// One holder at a time in this process: a second open file is refused until the first releases.
		const first = native.tryAdvisoryLock(lockFile, 0);
		assert.notEqual(first, null, "tryAdvisoryLock refused a free lock");
		const started = Date.now();
		assert.equal(native.tryAdvisoryLock(lockFile, 100), null, "tryAdvisoryLock took a held lock");
		assert.ok(Date.now() - started >= 80, "tryAdvisoryLock did not wait as long as it was given");
		first.release();
		first.release();
		const again = native.tryAdvisoryLock(lockFile, 0);
		assert.notEqual(again, null, "tryAdvisoryLock refused a released lock");
		again.release();

		// Another process's lock is refused while it runs and released by the kernel once it is killed.
		const holder = anotherProcessHolds(binding, lockFile);
		await holder.held;
		assert.equal(native.tryAdvisoryLock(lockFile, 0), null, "tryAdvisoryLock took another process's lock");
		holder.child.kill("SIGKILL");
		await holder.exited;
		const afterKill = native.tryAdvisoryLock(lockFile, 10_000);
		assert.notEqual(afterKill, null, "the lock of a killed holder was not released");
		afterKill.release();

		// A rename onto a free path moves; onto anything there, it moves nothing and replaces nothing.
		const movedDirectory = join(scratch, "lock.dead");
		const freeDirectory = join(scratch, "lock");
		mkdirSync(movedDirectory);
		assert.equal(native.renameNoReplace(movedDirectory, freeDirectory), true, "renameNoReplace refused a free path");
		assert.ok(!existsSync(movedDirectory) && existsSync(freeDirectory), "renameNoReplace did not move the directory");
		mkdirSync(movedDirectory);
		assert.equal(
			native.renameNoReplace(movedDirectory, freeDirectory),
			false,
			"renameNoReplace replaced a directory",
		);
		assert.ok(existsSync(movedDirectory) && existsSync(freeDirectory), "a refused directory rename moved something");
		const movedFile = join(scratch, "claim.json.dead");
		const takenFile = join(scratch, "claim.json");
		writeFileSync(movedFile, "moved");
		writeFileSync(takenFile, "live");
		assert.equal(native.renameNoReplace(movedFile, takenFile), false, "renameNoReplace replaced a file");
		assert.equal(readFileSync(takenFile, "utf8"), "live", "a refused file rename replaced the file");
		assert.equal(readFileSync(movedFile, "utf8"), "moved", "a refused file rename moved the file");
		rmSync(takenFile);
		assert.equal(native.renameNoReplace(movedFile, takenFile), true, "renameNoReplace refused a free file path");
		assert.equal(readFileSync(takenFile, "utf8"), "moved");

		console.log(`native advisory lock and no-replace rename work (${process.platform}-${process.arch})`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
