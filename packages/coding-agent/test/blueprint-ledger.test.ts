import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	type BlueprintLedger,
	blueprintDigest,
	ledgerPath,
	readLedger,
	repositoryKey,
	rootKey,
	updateLedger,
	workspaceKey,
} from "../src/core/resume/blueprint/ledger.ts";

let store: string;

beforeEach(() => {
	store = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-ledger-")));
});

afterEach(() => {
	rmSync(store, { recursive: true, force: true });
});

function framedHash(parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(`${part.length}:${part}`);
	return hash.digest("hex");
}

function writeLedgerFile(text: string): void {
	mkdirSync(join(store, "blueprint-builds"), { recursive: true });
	writeFileSync(ledgerPath(store), text);
}

const EMPTY: BlueprintLedger = { version: 1, workspaces: {}, roots: {} };

const VALID: BlueprintLedger = {
	version: 1,
	global: { digest: "g", status: "success", builtAt: "2026-01-01T00:00:00.000Z" },
	workspaces: { "abc:.": { digest: "d", status: "failed", builtAt: "2026-01-02T00:00:00.000Z", failedStep: "s" } },
	roots: { r: { state: "running", at: "2026-01-03T00:00:00.000Z" } },
};

describe("blueprint ledger digests and keys (#4588)", () => {
	test("a digest hashes the format version, directory, source and extra, each length-prefixed (#4588)", () => {
		assert.equal(
			blueprintDigest("services/api", "initialize: echo\n", "alias"),
			framedHash(["atomic-blueprint-v1", "services/api", "initialize: echo\n", "alias"]),
		);
		assert.equal(blueprintDigest("", "x"), framedHash(["atomic-blueprint-v1", "", "x", ""]));
		assert.equal(blueprintDigest("d", "x"), blueprintDigest("d", "x", ""));
		assert.notEqual(blueprintDigest("d", "x"), blueprintDigest("d", "x", "alias"));
		assert.match(blueprintDigest("d", "x"), /^[0-9a-f]{64}$/u);
	});

	test("a digest cannot be forged by moving text across the field boundaries (#4588)", () => {
		assert.notEqual(blueprintDigest("ab", "c"), blueprintDigest("a", "bc"));
		assert.notEqual(blueprintDigest("a", "bc", ""), blueprintDigest("a", "b", "c"));
		assert.notEqual(blueprintDigest("1", "2:x"), blueprintDigest("1:2", "x"));
	});

	test("a digest follows each of its inputs (#4588)", () => {
		const base = blueprintDigest("dir", "source", "extra");
		assert.notEqual(blueprintDigest("other", "source", "extra"), base);
		assert.notEqual(blueprintDigest("dir", "other", "extra"), base);
		assert.notEqual(blueprintDigest("dir", "source", "other"), base);
		assert.equal(blueprintDigest("dir", "source", "extra"), base);
	});

	test("a repository key is the first 16 hex digits of the identity's hash (#4588)", () => {
		assert.equal(
			repositoryKey("https://example.test/a.git"),
			framedHash(["https://example.test/a.git"]).slice(0, 16),
		);
		assert.equal(repositoryKey("x").length, 16);
		assert.notEqual(repositoryKey("a"), repositoryKey("b"));
	});

	test("a workspace key is the repository key and the directory, with . for the root (#4588)", () => {
		const prefix = repositoryKey("id");
		assert.equal(workspaceKey("id", ""), `${prefix}:.`);
		assert.equal(workspaceKey("id", "services/api"), `${prefix}:services/api`);
		assert.equal(workspaceKey("id", "."), `${prefix}:.`);
		assert.notEqual(workspaceKey("other", ""), workspaceKey("id", ""));
	});

	test("a root key is the first 16 hex digits of the resolved root's hash (#4588)", () => {
		const root = join(store, "worktree");
		assert.equal(rootKey(root), framedHash([root]).slice(0, 16));
		assert.equal(rootKey(root).length, 16);
		assert.equal(rootKey(`${root}/sub/..`), rootKey(root));
		assert.equal(rootKey("relative/dir"), framedHash([resolve("relative/dir")]).slice(0, 16));
		assert.notEqual(rootKey(join(store, "a")), rootKey(join(store, "b")));
	});

	test("the ledger lives at blueprint-builds/ledger.json in the store (#4588)", () => {
		assert.equal(ledgerPath("/store"), join("/store", "blueprint-builds", "ledger.json"));
	});
});

describe("reading the blueprint ledger (#4588)", () => {
	test("a missing ledger, store or ledger directory is an empty ledger (#4588)", async () => {
		assert.deepEqual(await readLedger(store), EMPTY);
		assert.deepEqual(await readLedger(join(store, "does", "not", "exist")), EMPTY);
	});

	test("a ledger this version wrote is returned as it was written (#4588)", async () => {
		writeLedgerFile(JSON.stringify(VALID));
		assert.deepEqual(await readLedger(store), VALID);
	});

	test("a corrupt ledger is an empty one (#4588)", async () => {
		for (const text of ["", "{", "not json", '{"version": 1, "workspaces": {']) {
			writeLedgerFile(text);
			assert.deepEqual(await readLedger(store), EMPTY, JSON.stringify(text));
		}
	});

	test("JSON that is not a ledger is an empty one, whichever part is wrong (#4588)", async () => {
		const notLedgers = [
			"null",
			"5",
			'"text"',
			"true",
			"[]",
			"{}",
			'{"version": 2, "workspaces": {}, "roots": {}}',
			'{"version": "1", "workspaces": {}, "roots": {}}',
			'{"workspaces": {}, "roots": {}}',
			'{"version": 1, "roots": {}}',
			'{"version": 1, "workspaces": null, "roots": {}}',
			'{"version": 1, "workspaces": "x", "roots": {}}',
			'{"version": 1, "workspaces": 5, "roots": {}}',
			'{"version": 1, "workspaces": {}}',
			'{"version": 1, "workspaces": {}, "roots": null}',
			'{"version": 1, "workspaces": {}, "roots": "x"}',
			'{"version": 1, "workspaces": {}, "roots": 5}',
		];
		for (const text of notLedgers) {
			writeLedgerFile(text);
			assert.deepEqual(await readLedger(store), EMPTY, text);
		}
	});

	test("a ledger that cannot be read for another reason than being absent is an error (#4588)", async () => {
		mkdirSync(ledgerPath(store), { recursive: true });
		await assert.rejects(readLedger(store), (error: NodeJS.ErrnoException) => error.code === "EISDIR");
	});
});

describe("updating the blueprint ledger (#4588)", () => {
	test("an update starts from the empty ledger, creates the store and returns what it wrote (#4588)", async () => {
		const seen: BlueprintLedger[] = [];
		const next = await updateLedger(join(store, "nested", "store"), (ledger) => {
			seen.push(ledger);
			return VALID;
		});
		assert.deepEqual(seen, [EMPTY]);
		assert.equal(next, VALID);
		assert.deepEqual(await readLedger(join(store, "nested", "store")), VALID);
	});

	test("an update keeps what earlier updates wrote and replaces a corrupt ledger (#4588)", async () => {
		await updateLedger(store, () => VALID);
		await updateLedger(store, (ledger) => ({
			...ledger,
			roots: { ...ledger.roots, other: { state: "success", at: "2026-02-01T00:00:00.000Z" } },
		}));
		const ledger = await readLedger(store);
		assert.deepEqual(ledger.global, VALID.global);
		assert.deepEqual(ledger.workspaces, VALID.workspaces);
		assert.deepEqual(Object.keys(ledger.roots), ["r", "other"]);
		writeLedgerFile("{corrupt");
		const seen: BlueprintLedger[] = [];
		await updateLedger(store, (current) => {
			seen.push(current);
			return VALID;
		});
		assert.deepEqual(seen, [EMPTY]);
		assert.deepEqual(await readLedger(store), VALID);
	});

	test("the file is indented JSON with a trailing newline and no temporary file is left behind (#4588)", async () => {
		await updateLedger(store, () => VALID);
		assert.equal(readFileSync(ledgerPath(store), "utf8"), `${JSON.stringify(VALID, null, 2)}\n`);
		assert.deepEqual(readdirSync(join(store, "blueprint-builds")), ["ledger.json"]);
	});

	test.skipIf(process.platform === "win32")("the ledger file is readable by its owner only (#4588)", async () => {
		await updateLedger(store, () => VALID);
		assert.equal(statSync(ledgerPath(store)).mode & 0o777, 0o600);
	});

	test("a failing update writes nothing (#4588)", async () => {
		await assert.rejects(
			updateLedger(store, () => {
				throw new Error("stop");
			}),
			/stop/u,
		);
		assert.deepEqual(readdirSync(join(store, "blueprint-builds")), []);
	});

	test("updates asked for at the same time all apply, one after the other, and leave no lock or temporary file (#4588)", async () => {
		const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
		const results = await Promise.all(
			names.map((name) =>
				updateLedger(store, (current) => ({
					...current,
					roots: { ...current.roots, [name]: { state: "success", at: name } },
				})),
			),
		);
		assert.deepEqual(Object.keys((await readLedger(store)).roots).sort(), names);
		assert.deepEqual(
			results.map((ledger) => Object.keys(ledger.roots).length),
			[1, 2, 3, 4, 5, 6, 7, 8],
		);
		assert.deepEqual(readdirSync(join(store, "blueprint-builds")), ["ledger.json"]);
	});

	test("two updates in the same millisecond keep both entries (#4588)", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			await Promise.all(
				["x", "y"].map((name) =>
					updateLedger(store, (current) => ({
						...current,
						roots: { ...current.roots, [name]: { state: "failed", at: name } },
					})),
				),
			);
		} finally {
			now.mockRestore();
		}
		assert.deepEqual(Object.keys((await readLedger(store)).roots).sort(), ["x", "y"]);
	});

	test("an update waits for a lock another process holds and applies once it is released (#4588)", async () => {
		mkdirSync(join(store, "blueprint-builds"), { recursive: true });
		const release = await lockfile.lock(join(store, "blueprint-builds"), {
			realpath: false,
			lockfilePath: `${ledgerPath(store)}.lock`,
		});
		let settled = false;
		const pending = updateLedger(store, () => VALID).then(() => {
			settled = true;
		});
		await new Promise((resolveWait) => setTimeout(resolveWait, 150));
		assert.equal(settled, false);
		assert.equal(existsSync(ledgerPath(store)), false);
		await release();
		await pending;
		assert.deepEqual(await readLedger(store), VALID);
	});

	test("an update that cannot take the lock rejects with the lock's error and writes nothing (#4588)", async () => {
		mkdirSync(join(store, "blueprint-builds"), { recursive: true });
		const release = await lockfile.lock(join(store, "blueprint-builds"), {
			realpath: false,
			lockfilePath: `${ledgerPath(store)}.lock`,
		});
		const sleep = vi.spyOn(globalThis, "setTimeout");
		try {
			sleep.mockImplementation(((handler: () => void) => {
				handler();
				return 0 as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout);
			await assert.rejects(
				updateLedger(store, () => VALID),
				(error: unknown) => (error as NodeJS.ErrnoException).code === "ELOCKED",
			);
		} finally {
			sleep.mockRestore();
			await release();
		}
		assert.equal(existsSync(ledgerPath(store)), false);
	});
});
