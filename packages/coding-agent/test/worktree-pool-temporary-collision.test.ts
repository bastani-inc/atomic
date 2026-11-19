import assert from "node:assert/strict";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import {
	admitPooledWorktree,
	discardPooledWorktree,
	type PoolSlotRecord,
	repositoryIdOf,
} from "../src/core/worktree-snapshot/pool.js";

const uuids = vi.hoisted(() => ({
	/** The UUID every draw returns while set, as when two draws collide. */
	fixed: undefined as string | undefined,
	/** Called before each write of a file, with its path. */
	beforeWrite: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:crypto", async (original) => {
	const crypto = await original<typeof import("node:crypto")>();
	const randomUUID = () => (uuids.fixed ?? crypto.randomUUID()) as ReturnType<typeof crypto.randomUUID>;
	return { ...crypto, randomUUID, default: { ...crypto, randomUUID } };
});

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const writeFile: typeof fs.writeFile = (path, ...rest) => {
		uuids.beforeWrite?.(String(path));
		return fs.writeFile(path, ...rest);
	};
	return { ...fs, writeFile, default: { ...fs, writeFile } };
});

useTemporaryAgentDir();

const COLLIDING = "00000000-0000-4000-8000-0123456789ab";
const SENTINEL = "another holder's temporary record";
const remotes = ["https://example.com/acme/repo.git"];
const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };

let sandbox: GitSandbox;
let reader: number | undefined;

beforeEach(() => {
	sandbox = new GitSandbox();
});

afterEach(() => {
	uuids.fixed = undefined;
	uuids.beforeWrite = undefined;
	if (reader !== undefined) closeSync(reader);
	reader = undefined;
	sandbox.dispose();
});

/** Creates another holder's temporary record at the name a draw of {@link COLLIDING} gives slot 0, open for reading. */
function existingTemporary(storeDir: string): string {
	const file = join(storeDir, "pool", repositoryIdOf(remotes), "0.json");
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${COLLIDING}.tmp`;
	writeFileSync(temporary, SENTINEL);
	reader = openSync(temporary, "r");
	return temporary;
}

/** What the handle opened on the existing temporary record reads. */
function readThroughHandle(): string {
	const buffer = Buffer.alloc(4096);
	return buffer.subarray(0, readSync(reader!, buffer, 0, buffer.length, 0)).toString("utf8");
}

test("an admission whose temporary record name is taken leaves that file alone and takes a fresh name (#5824)", async () => {
	const storeDir = sandbox.path("store");
	const temporary = existingTemporary(storeDir);
	uuids.fixed = COLLIDING;
	uuids.beforeWrite = (path) => {
		// Only the first draw for the record's temporary name collides.
		if (path === temporary) uuids.fixed = undefined;
	};
	const owner = { kind: "session" as const, id: "new-holder" };
	const lease = await admitPooledWorktree({ storeDir, remotes, lastState: state, envHash: "env" }, owner);
	try {
		assert.equal(lease.slot, 0);
		assert.equal(readThroughHandle(), SENTINEL);
		assert.equal(readFileSync(temporary, "utf8"), SENTINEL);
		const file = join(dirname(temporary), "0.json");
		assert.deepEqual((JSON.parse(readFileSync(file, "utf8")) as PoolSlotRecord).holder, owner);
		assert.deepEqual(
			readdirSync(dirname(temporary)).filter((name) => name.endsWith(".tmp")),
			[`0.json.${COLLIDING}.tmp`],
		);
	} finally {
		await discardPooledWorktree(lease);
	}
});

test("an admission whose every temporary record name is taken fails without touching that file (#5824)", async () => {
	const storeDir = sandbox.path("store");
	const temporary = existingTemporary(storeDir);
	uuids.fixed = COLLIDING;
	await assert.rejects(
		admitPooledWorktree(
			{ storeDir, remotes, lastState: state, envHash: "env" },
			{ kind: "session", id: "new-holder" },
		),
		{ code: "EEXIST" },
	);
	assert.equal(readThroughHandle(), SENTINEL);
	assert.equal(readFileSync(temporary, "utf8"), SENTINEL);
	assert.equal(existsSync(join(dirname(temporary), "0.json")), false);
	assert.deepEqual(
		readdirSync(dirname(temporary)).filter((name) => name.startsWith("0.json")),
		[`0.json.${COLLIDING}.tmp`],
	);
});
