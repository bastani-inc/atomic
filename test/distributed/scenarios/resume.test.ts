/**
 * Resume on another node: a session recorded on node A, which is then killed and whose checkout is gone, continues on
 * other nodes from the shared database. Each node is its own process with its own HOME and agent directory, and reaches
 * the database through PgBouncer.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { treeDigest } from "../../helpers/tree-digest.js";
import { GitSandbox } from "../../helpers/worktree-snapshot.js";
import { Cluster, repoRoot } from "../harness/cluster.js";
import { bunOnly, gitKillingTheFirstRestore, portableGitArchive, provisioningTools } from "../harness/git.js";
import { distributedSkipReason, recordEvent } from "../harness/topology.js";

const SCENARIO = "resume";
const driver = join(repoRoot, "test/fixtures/multinode-resume-node.ts");
/** The lookup deadline of the partitioned resume: long enough to start Bun and load the sources. */
const PARTITION_LOOKUP_TIMEOUT_MS = 5_000;

interface NodeOutput {
	readonly sessionId?: string;
	readonly snapshots?: number;
	readonly cwd?: string;
	readonly notices?: readonly { type: string; message: string }[];
	readonly mappings?: readonly { from: string; to: string }[];
	readonly userMessages?: number;
	readonly toolResult?: readonly { type: string; text?: string }[];
	readonly error?: { name?: string; code?: string; retryable?: boolean; message?: string };
}

function toolText(output: NodeOutput | undefined): string {
	return output?.toolResult?.map((part) => part.text ?? "").join("") ?? "";
}

describe.skipIf(distributedSkipReason !== undefined)("resume on another node", () => {
	let cluster: Cluster;
	let sandbox: GitSandbox;
	let clone: string;
	let offline: string;
	let head: string;
	let sessionId: string;
	const written = () => join(clone, "notes", "agent-wrote.txt");
	const gitEnv = () => ({ GIT_CONFIG_GLOBAL: sandbox.globalConfig, GIT_CONFIG_NOSYSTEM: "1" });

	beforeAll(async () => {
		cluster = await Cluster.start(SCENARIO, ["a", "b", "c", "d"]);
		sandbox = new GitSandbox();
		({ clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "package-lock.json": "{}\n" }));
		sandbox.write(join(clone, "unpushed.txt"), "only on node A\n");
		head = await sandbox.commitAll(clone, "unpushed commit");
		sandbox.write(join(clone, "README.md"), "uncommitted edit\n");
		sandbox.write(join(clone, "notes", "untracked.txt"), "untracked\n");

		// Node A runs a turn that writes a file, then is killed; its checkout goes with it.
		const nodeA = cluster
			.node("a")
			.run<NodeOutput>(
				driver,
				"record",
				{ cwd: clone, file: written(), content: "written by the model on node A\n" },
				gitEnv(),
			);
		const recorded = await nodeA.firstOutput();
		assert.equal(recorded.snapshots, 1, JSON.stringify(recorded));
		sessionId = recorded.sessionId!;
		nodeA.child.kill("SIGKILL");
		assert.equal((await nodeA.run).signal, "SIGKILL");
		recordEvent(SCENARIO, { fault: "sigkill-node", node: "a" });
		offline = join(sandbox.root, "node-a-gone");
		renameSync(clone, offline);
	});
	afterAll(async () => {
		await cluster?.cleanup();
		sandbox?.dispose();
	});

	test("a node without Git opens the session without its checkout, and says why", async () => {
		const node = cluster.node("c");
		const emptyBin = join(node.root, "bin");
		mkdirSync(emptyBin, { recursive: true });
		const opened = await node.run<NodeOutput>(
			driver,
			"resume",
			{ sessionId, launchCwd: node.home, readPath: written(), openOnly: true },
			{ ...gitEnv(), PATH: `${emptyBin}:${bunOnly(node.root)}`, ATOMIC_OFFLINE: "1" },
		).run;
		assert.equal(opened.code, 0, opened.stderr);
		assert.deepEqual(opened.output?.mappings, []);
		assert.equal(opened.output?.cwd, node.home);
		assert.equal(opened.output?.notices?.length, 1, JSON.stringify(opened.output?.notices));
		assert.match(opened.output?.notices?.[0]?.message ?? "", /Git is unavailable here \(offline\)/);
		assert.equal(existsSync(join(node.agentDir, "worktree-snapshots", "worktrees")), false);
	});

	test("cut off from the database, node B fails the resume with a typed, retryable error and restores nothing", async () => {
		const node = cluster.node("b");
		node.partition();
		try {
			const partitioned = await node.run<NodeOutput>(
				driver,
				"resume",
				{ sessionId, launchCwd: node.home, readPath: written(), catalogTimeoutMs: PARTITION_LOOKUP_TIMEOUT_MS },
				gitEnv(),
			).run;
			assert.equal(partitioned.code, 2, partitioned.stderr);
			assert.deepEqual(
				[partitioned.output?.error?.name, partitioned.output?.error?.code],
				["ResumeCatalogTimeoutError", "catalog-timeout"],
			);
			assert.equal(partitioned.output?.error?.retryable, true);
		} finally {
			node.heal();
		}
		assert.equal(existsSync(join(node.agentDir, "worktree-snapshots", "worktrees")), false);
	});

	test("node B, killed in the middle of restoring the worktree, resumes on the next try in a byte-identical tree", async () => {
		const node = cluster.node("b");
		const shim = gitKillingTheFirstRestore(join(node.root, "shim"));
		const setupMarker = join(node.root, "setup-ran");
		const args = {
			sessionId,
			launchCwd: node.home,
			readPath: written(),
			setupCommand: `echo ran >> "${setupMarker}"`,
		};
		const env = { ...gitEnv(), PATH: `${shim.path}:${process.env.PATH}` };
		const killed = await node.run<NodeOutput>(driver, "resume", args, env).run;
		assert.equal(killed.signal, "SIGKILL");
		assert.ok(existsSync(shim.killed));
		recordEvent(SCENARIO, { fault: "sigkill-mid-restore", node: "b" });

		const resumed = await node.run<NodeOutput>(driver, "resume", args, env).run;
		assert.equal(resumed.code, 0, `${resumed.stderr}\n${JSON.stringify(resumed.output)}`);
		const output = resumed.output!;
		const worktrees = join(node.agentDir, "worktree-snapshots", "worktrees");
		assert.deepEqual(
			output.mappings?.map((mapping) => mapping.from),
			[clone],
		);
		const restored = output.mappings![0]!.to;
		assert.ok(restored.startsWith(worktrees), restored);
		assert.equal(output.cwd, restored);
		assert.deepEqual(treeDigest(restored), treeDigest(offline));
		assert.equal(await sandbox.git(restored, "rev-parse", "HEAD"), head);
		await sandbox.git(restored, "fsck", "--no-progress");
		assert.equal(output.userMessages, 2);
		assert.match(toolText(output), /written by the model on node A/);
		assert.equal(readFileSync(setupMarker, "utf8"), "ran\n");
		// The killed attempt left only staging, never a worktree the session uses.
		const others = readdirSync(worktrees).filter((name) => join(worktrees, name) !== restored);
		assert.ok(
			others.every((name) => /^\.s-[0-9a-f]{12}$/.test(name)),
			others.join(", "),
		);
	});

	test("a node without Git provisions it to restore and continue; a failed download opens the session without its checkout", async () => {
		// A session of its own, which no other node has continued yet.
		const { clone: provisioned } = await sandbox.remoteWithClone("provisioned-repo", { "README.md": "hello\n" });
		sandbox.write(join(provisioned, "README.md"), "edited on the node with Git\n");
		const file = join(provisioned, "provisioned.txt");
		const nodeA = cluster
			.node("a")
			.run<NodeOutput>(driver, "record", { cwd: provisioned, file, content: "from the node with Git\n" }, gitEnv());
		const recorded = await nodeA.firstOutput();
		nodeA.child.kill("SIGKILL");
		await nodeA.run;
		const gone = join(sandbox.root, "provisioned-repo-gone");
		renameSync(provisioned, gone);

		const node = cluster.node("d");
		const portable = portableGitArchive(node.root);
		const gitless = (extra: NodeJS.ProcessEnv = {}) => ({
			...gitEnv(),
			PATH: `${provisioningTools(node.root)}:${bunOnly(node.root)}`,
			ATOMIC_OFFLINE: "",
			PROVISION_ARCHIVE: portable.archive,
			PROVISION_SHA256: portable.sha256,
			PROVISION_VERSION: portable.version,
			...extra,
		});
		const args = { sessionId: recorded.sessionId, launchCwd: node.home, readPath: file };

		const failed = await node.run<NodeOutput>(
			driver,
			"resume",
			{ ...args, openOnly: true },
			gitless({ PROVISION_FAIL: "1" }),
		).run;
		assert.equal(failed.code, 0, failed.stderr);
		assert.deepEqual(failed.output?.mappings, []);
		assert.match(failed.output?.notices?.[0]?.message ?? "", /Git is unavailable here \(download-failed\)/);
		assert.equal(existsSync(join(node.agentDir, "bin", "git", "bin", "git")), false);

		const resumed = await node.run<NodeOutput>(driver, "resume", args, gitless()).run;
		assert.equal(resumed.code, 0, `${resumed.stderr}\n${JSON.stringify(resumed.output)}`);
		assert.ok(
			existsSync(join(node.agentDir, "bin", "git", "bin", "git")),
			`Git was not provisioned into Atomic home: ${JSON.stringify(resumed.output)}`,
		);
		const restored = resumed.output?.mappings?.[0]?.to ?? "";
		assert.ok(restored.startsWith(join(node.agentDir, "worktree-snapshots", "worktrees")), restored);
		assert.deepEqual(treeDigest(restored), treeDigest(gone));
		assert.equal(resumed.output?.userMessages, 2);
		assert.match(toolText(resumed.output), /from the node with Git/);
	});
});
