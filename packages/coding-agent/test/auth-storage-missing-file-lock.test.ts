import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, it } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

const BACKEND_MODULE = fileURLToPath(new URL("../src/core/auth-storage.ts", import.meta.url));

let directory: string;
let authPath: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-auth-missing-")));
	authPath = join(directory, "auth.json");
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

/** Another process saves `key` to auth.json, and says whether it did. */
function anotherProcessSaves(key: string): boolean {
	const script = `
		import { FileAuthStorageBackend } from ${JSON.stringify(BACKEND_MODULE)};
		const backend = new FileAuthStorageBackend(${JSON.stringify(authPath)}, [${JSON.stringify(authPath)}]);
		try {
			backend.withLock((current) => {
				const data = JSON.parse(current ?? "{}");
				data[${JSON.stringify(key)}] = { type: "api_key", key: ${JSON.stringify(key)} };
				return { result: undefined, next: JSON.stringify(data) };
			});
			console.log("saved");
		} catch (error) {
			console.log(error.code ?? error.message);
		}
	`;
	const result = spawnSync("bun", ["--eval", script], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim() === "saved";
}

it("holds the auth.json lock while saving the first credential, so another process's save is never lost (#5161)", () => {
	let otherSaved: boolean | undefined;
	new FileAuthStorageBackend(authPath, [authPath]).withLock((current) => {
		assert.equal(current, undefined, "auth.json does not exist yet");
		otherSaved = anotherProcessSaves("other");
		const data = JSON.parse(current ?? "{}") as Record<string, unknown>;
		data.mine = { type: "api_key", key: "mine" };
		return { result: undefined, next: JSON.stringify(data) };
	});
	const saved = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
	if (otherSaved) assert.ok("other" in saved, "a save another process made is kept");
	assert.equal(otherSaved, false, "another process waits for the lock instead of saving beside this one");
	assert.deepEqual(Object.keys(saved), ["mine"]);
	assert.equal(anotherProcessSaves("other"), true);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(authPath, "utf8")) as object).sort(), ["mine", "other"]);
});

it("leaves an existing auth.json as it is when it makes sure the file exists (#5161)", async (context) => {
	if (process.platform === "win32") context.skip();
	writeFileSync(authPath, JSON.stringify({ kept: { type: "api_key", key: "kept" } }));
	chmodSync(authPath, 0o640);
	await new FileAuthStorageBackend(authPath, [authPath]).withLockAsync(async (current) => ({
		result: undefined,
		next: current,
	}));
	assert.equal(statSync(authPath).mode & 0o777, 0o640, "an existing file's mode is not changed");
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(authPath, "utf8")) as object), ["kept"]);
});

it("reports an auth.json that cannot be resolved, rather than locking a name beside it (#5161)", (context) => {
	if (process.platform === "win32") context.skip();
	symlinkSync(authPath, authPath);
	const backend = new FileAuthStorageBackend(authPath, [authPath]);
	assert.throws(
		() => backend.withLock(() => ({ result: undefined, next: undefined })),
		(error: NodeJS.ErrnoException) => error.code === "ELOOP",
	);
});
