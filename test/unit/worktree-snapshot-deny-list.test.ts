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
} from "../../packages/coding-agent/src/core/worktree-snapshot/policy.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

describe("the built-in deny list (#4245)", () => {
	test("SSH and TLS private keys are denied whatever their name, while public keys and source files are kept", () => {
		const denied = [
			"id_rsa",
			"id_ed25519",
			"keys/id_ecdsa_sk",
			"id_rsa.key",
			"id_server.pem",
			"certs/id_client.pem",
			"id_token.p12",
			"keys/id_x.pfx",
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
			"denied paths",
		);
		assert.deepEqual(
			kept.filter((path) => isDeniedSnapshotPath(path)),
			[],
			"kept paths",
		);
	});

	test("every key-file extension stays denied on a name that starts with id_", () => {
		const extensions = SNAPSHOT_DENY_PATTERNS.filter((pattern) => /^\*\.[a-z0-9]+$/.test(pattern));
		assert.deepEqual(extensions, ["*.pem", "*.key", "*.p12", "*.pfx"]);
		for (const pattern of extensions) {
			for (const path of [`id_x${pattern.slice(1)}`, `nested/dir/id_rsa${pattern.slice(1)}`]) {
				assert.equal(isDeniedSnapshotPath(path), true, path);
			}
		}
	});

	test("a private key named id_*.pem is left out of capture and of the unpushed bundle", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "certs", "id_client.pem"), "PRIVATE-PEM-MARKER\n");
		const blobs = new MemorySnapshotBlobStore();
		const working = await captureWorktreeSnapshot(clone, { blobs });
		assert.equal(working.status, "captured");
		assert.deepEqual((working as { snapshot: WorktreeSnapshot }).snapshot.omitted, [
			{ reason: "denied", path: "certs/id_client.pem" },
		]);
		sandbox.write(join(clone, "id_rsa.key"), "PRIVATE-KEY-MARKER\n");
		const commit = await sandbox.commitAll(clone, "add keys");
		const history = await captureWorktreeSnapshot(clone, { blobs });
		assert.equal(history.status, "captured");
		const snapshot = (history as { snapshot: WorktreeSnapshot }).snapshot;
		assert.equal(snapshot.bundle, null);
		assert.deepEqual(snapshot.omitted, [
			{ reason: "unpushed-history-denied", commits: [commit], paths: ["certs/id_client.pem", "id_rsa.key"] },
		]);
		for (const hash of await blobs.listBlobHashes()) {
			assert.doesNotMatch(Buffer.from((await blobs.getBlob(hash))!).toString("latin1"), /PRIVATE-(PEM|KEY)-MARKER/);
		}
	});
});
