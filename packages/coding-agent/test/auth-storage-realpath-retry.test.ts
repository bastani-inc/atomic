import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage-backends.js";

type RealpathOverride = (path: string, call: number) => string;

const realpath = vi.hoisted(() => ({ override: undefined as RealpathOverride | undefined, calls: 0 }));
const resolved = realpath;

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof nodeFs>();
	const realpathSync = Object.assign(
		(path: nodeFs.PathLike) => {
			realpath.calls += 1;
			return realpath.override ? realpath.override(String(path), realpath.calls) : actual.realpathSync(path);
		},
		{ native: actual.realpathSync.native },
	) as typeof actual.realpathSync;
	// The asynchronous lock resolves with the callback form, which matches realpathSync's result on every platform.
	const realpathCallback = Object.assign(
		(path: nodeFs.PathLike, callback: (error: NodeJS.ErrnoException | null, resolvedPath?: string) => void) => {
			realpath.calls += 1;
			if (!realpath.override) return actual.realpath(path, callback);
			let resolvedPath: string;
			try {
				resolvedPath = realpath.override(String(path), realpath.calls);
			} catch (error) {
				queueMicrotask(() => callback(error as NodeJS.ErrnoException));
				return;
			}
			queueMicrotask(() => callback(null, resolvedPath));
		},
		{ native: actual.realpath.native },
	) as typeof actual.realpath;
	return { ...actual, realpathSync, realpath: realpathCallback };
});

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const realpath = (async (path: nodeFs.PathLike) => {
		resolved.calls += 1;
		return resolved.override ? resolved.override(String(path), resolved.calls) : actual.realpath(path);
	}) as typeof actual.realpath;
	return { ...actual, realpath, default: { ...actual, realpath } };
});

const RUNAWAY_CALLS = 50;

function errorWithCode(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

/** Fails every call with `error`, and with a different error if a caller retries without bound. */
function alwaysFailing(error: () => unknown): RealpathOverride {
	return (_path, call) => {
		if (call > RUNAWAY_CALLS) throw errorWithCode("ERUNAWAY");
		throw error();
	};
}

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("resolving the auth file's real path (pi #11655)", () => {
	let directory: string;
	let authPath: string;
	let backend: FileAuthStorageBackend;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "atomic-auth-realpath-"));
		authPath = join(directory, "auth.json");
		writeFileSync(authPath, "{}");
		backend = new FileAuthStorageBackend(authPath, [authPath]);
		realpath.calls = 0;
	});

	afterEach(() => {
		realpath.override = undefined;
		rmSync(directory, { recursive: true, force: true });
	});

	function lockWithoutWriting(): void {
		backend.withLock((current) => ({ result: current }));
	}

	function caught(run: () => void): unknown {
		try {
			run();
		} catch (error) {
			return error;
		}
		return "did not throw";
	}

	it("retries an ENOENT from realpath while the auth file still exists", () => {
		realpath.override = (path, call) => {
			if (call <= 2) throw errorWithCode("ENOENT");
			return nodeFs.realpathSync.native(path);
		};

		lockWithoutWriting();

		assert.equal(realpath.calls, 3);
	});

	it("gives up on a persistent ENOENT after 20 attempts and reports it", () => {
		realpath.override = alwaysFailing(() => errorWithCode("ENOENT"));

		const error = caught(lockWithoutWriting);

		assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
		assert.equal(realpath.calls, 20);
	});

	it("reports an error other than ENOENT without retrying", () => {
		realpath.override = alwaysFailing(() => errorWithCode("EACCES"));

		const error = caught(lockWithoutWriting);

		assert.equal((error as NodeJS.ErrnoException).code, "EACCES");
		assert.equal(realpath.calls, 1);
	});

	it("reports an ENOENT for a file that no longer exists without retrying", () => {
		realpath.override = (path) => {
			rmSync(path, { force: true });
			throw errorWithCode("ENOENT");
		};

		const error = caught(() => backend.deleteProvider("anthropic"));

		assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
		assert.equal(realpath.calls, 1);
	});

	it("does not mistake a thrown plain object with a code for an error to retry", () => {
		const thrown = { code: "ENOENT" };
		realpath.override = alwaysFailing(() => thrown);

		assert.equal(caught(lockWithoutWriting), thrown);
		assert.equal(realpath.calls, 1);
	});

	it("rethrows a thrown null as is", () => {
		realpath.override = alwaysFailing(() => null);

		assert.equal(caught(lockWithoutWriting), null);
		assert.equal(realpath.calls, 1);
	});

	posixOnly("locks the resolved path exactly, so a synchronous lock is not resolved a second time", () => {
		const aliasPath = join(directory, "alias.json");
		symlinkSync(authPath, aliasPath);
		realpath.override = (_path, call) => (call === 1 ? aliasPath : nodeFs.realpathSync.native(_path));
		let lockedAlias = false;
		let lockedTarget = false;

		backend.withLock((current) => {
			lockedAlias = existsSync(`${aliasPath}.lock`);
			lockedTarget = existsSync(`${authPath}.lock`);
			return { result: current };
		});

		assert.equal(lockedAlias, true);
		assert.equal(lockedTarget, false);
	});

	posixOnly("locks the resolved path exactly, so an asynchronous lock is not resolved a second time", async () => {
		const aliasPath = join(directory, "alias.json");
		symlinkSync(authPath, aliasPath);
		realpath.override = (_path, call) => (call === 1 ? aliasPath : nodeFs.realpathSync.native(_path));
		let lockedAlias = false;
		let lockedTarget = false;

		await backend.withLockAsync(async (current) => {
			lockedAlias = existsSync(`${aliasPath}.lock`);
			lockedTarget = existsSync(`${authPath}.lock`);
			return { result: current };
		});

		assert.equal(lockedAlias, true);
		assert.equal(lockedTarget, false);
	});

	posixOnly("takes a provider lock beside the real file under a hash of the provider name", async () => {
		const aliasPath = join(directory, "alias.json");
		symlinkSync(authPath, aliasPath);
		const viaAlias = new FileAuthStorageBackend(aliasPath, [aliasPath]);
		const hash = createHash("sha256").update("anthropic").digest("hex");
		const real = nodeFs.realpathSync.native(authPath);
		let held = false;

		await viaAlias.modifyProviderAsync("anthropic", async (current) => {
			held = existsSync(`${real}.${hash}.lock`);
			return current;
		});

		assert.equal(held, true);
	});
});
