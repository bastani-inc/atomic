import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import {
	isDeniedSnapshotPath,
	SNAPSHOT_DENY_PATTERNS,
	SNAPSHOT_KEY_FILE_PATTERNS,
} from "../../packages/coding-agent/src/core/worktree-snapshot/policy.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

const PRIVATE_KEYS = [
	"id_rsa.key",
	"id_server.pem",
	"certs/id_client.pem",
	"id_token.p12",
	"keys/id_rsa.pfx",
	"id_rsa.bak",
] as const;

const marker = (path: string) => `PRIVATE-KEY-BYTES-${path.replace(/[^a-z0-9]/gi, "-")}`;

async function assertNoKeyBytes(blobs: MemorySnapshotBlobStore): Promise<void> {
	for (const hash of await blobs.listBlobHashes()) {
		assert.doesNotMatch(Buffer.from((await blobs.getBlob(hash))!).toString("latin1"), /PRIVATE-KEY-BYTES/);
	}
}

function snapshotOf(result: Awaited<ReturnType<typeof captureWorktreeSnapshot>>): WorktreeSnapshot {
	assert.equal(result.status, "captured");
	return (result as { snapshot: WorktreeSnapshot }).snapshot;
}

describe("the built-in deny list (#4245)", () => {
	test("private keys are denied whatever an id_ name suggests, and only .pub key files are kept", () => {
		const denied = [
			...PRIVATE_KEYS,
			"id_rsa",
			"id_ed25519",
			"keys/id_ecdsa_sk",
			"id_ed25519_sk.old",
			"id_mldsa44_ed25519",
			"id_rsa.pub.pem",
			"id_rsa.pub.key",
			"server.key",
			".env",
			"credentials.json",
		];
		const kept = [
			"id_rsa.pub",
			"keys/id_ed25519.pub",
			"id_ed25519-cert.pub",
			"id_utils.ts",
			"src/id_map.json",
			"notes.txt",
		];
		assert.deepEqual(
			denied.filter((path) => !isDeniedSnapshotPath(path)),
			[],
		);
		assert.deepEqual(
			kept.filter((path) => isDeniedSnapshotPath(path)),
			[],
		);
	});

	test("the always-denied list has no negation, so no rule can take a key-file extension back", () => {
		assert.deepEqual(
			SNAPSHOT_DENY_PATTERNS.filter((pattern) => pattern.startsWith("!")),
			[],
		);
		assert.equal(SNAPSHOT_KEY_FILE_PATTERNS.at(-1), "!id_*.pub", "only public keys are exempt last");
		for (const pattern of SNAPSHOT_DENY_PATTERNS.filter((candidate) => candidate.startsWith("*."))) {
			const extension = pattern.slice(1);
			for (const path of [`id_x${extension}`, `id_rsa.pub${extension}`, `nested/dir/id_rsa${extension}`]) {
				assert.equal(isDeniedSnapshotPath(path), true, path);
			}
		}
	});

	test("working-tree capture leaves out every private key, keeps the public one, and stores no key bytes", async () => {
		const { clone } = await sandbox.remoteWithClone();
		for (const path of PRIVATE_KEYS) sandbox.write(join(clone, path), `${marker(path)}\n`);
		sandbox.write(join(clone, "id_rsa.pub"), "ssh-ed25519 PUBLIC\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = snapshotOf(await captureWorktreeSnapshot(clone, { blobs }));
		assert.deepEqual(
			snapshot.omitted,
			[...PRIVATE_KEYS].sort().map((path) => ({ reason: "denied", path })),
		);
		assert.equal(await sandbox.git(clone, "cat-file", "-p", `${snapshot.tree}:id_rsa.pub`), "ssh-ed25519 PUBLIC");
		await assertNoKeyBytes(blobs);
	});

	test("unpushed history that adds a private key is never bundled, and names the key", async () => {
		const { clone } = await sandbox.remoteWithClone();
		for (const path of PRIVATE_KEYS) sandbox.write(join(clone, path), `${marker(path)}\n`);
		sandbox.write(join(clone, "id_rsa.pub"), "ssh-ed25519 PUBLIC\n");
		const commit = await sandbox.commitAll(clone, "add keys");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = snapshotOf(await captureWorktreeSnapshot(clone, { blobs }));
		assert.equal(snapshot.bundle, null);
		assert.deepEqual(snapshot.omitted, [
			{ reason: "unpushed-history-denied", commits: [commit], paths: [...PRIVATE_KEYS].sort() },
		]);
		await assertNoKeyBytes(blobs);
	});

	test("unpushed history that adds only a public key and an id_ source file is bundled", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "id_rsa.pub"), "ssh-ed25519 PUBLIC\n");
		sandbox.write(join(clone, "id_utils.ts"), "export const id = 1;\n");
		await sandbox.commitAll(clone, "add a public key and a source file");
		const snapshot = snapshotOf(await captureWorktreeSnapshot(clone, { blobs: new MemorySnapshotBlobStore() }));
		assert.notEqual(snapshot.bundle, null);
		assert.deepEqual(snapshot.omitted, []);
	});
});
