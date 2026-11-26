/**
 * A fork across nodes: a session recorded on node A is forked on node B, which continues the fork, while node C
 * continues the original. Each sees only its own continuation, and both start from what node A recorded.
 */
import assert from "node:assert/strict";
import { realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { treeDigest } from "../../helpers/tree-digest.js";
import { GitSandbox } from "../../helpers/worktree-snapshot.js";
import { Cluster, repoRoot } from "../harness/cluster.js";
import { distributedSkipReason } from "../harness/topology.js";

const SCENARIO = "fork";
const resumeDriver = join(repoRoot, "test/fixtures/multinode-resume-node.ts");
const sessionDriver = join(repoRoot, "test/distributed/node/session-node.ts");

interface SessionOutput {
	readonly sessionId?: string;
	readonly parentSession?: string;
	readonly cwd?: string;
	readonly mappings?: readonly { from: string; to: string }[];
	readonly userTexts?: readonly string[];
	readonly entryIds?: readonly string[];
	readonly userMessages?: number;
	readonly snapshots?: number;
	readonly toolResult?: readonly { type: string; text?: string }[];
	readonly error?: { name?: string; code?: string; message?: string };
}

const toolText = (output: SessionOutput | undefined) =>
	output?.toolResult?.map((part) => part.text ?? "").join("") ?? "";

describe.skipIf(distributedSkipReason !== undefined)("a fork across nodes", () => {
	let cluster: Cluster;
	let sandbox: GitSandbox;
	let clone: string;
	let offline: string;
	let sourceId: string;
	let recordedEntries: readonly string[];
	let forkId: string;
	const written = () => join(clone, "notes.txt");
	const gitEnv = () => ({ GIT_CONFIG_GLOBAL: sandbox.globalConfig, GIT_CONFIG_NOSYSTEM: "1" });

	beforeAll(async () => {
		cluster = await Cluster.start(SCENARIO, ["a", "b", "c"]);
		sandbox = new GitSandbox();
		({ clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" }));
		sandbox.write(join(clone, "README.md"), "edited on node A\n");
		const nodeA = cluster
			.node("a")
			.run<SessionOutput>(
				resumeDriver,
				"record",
				{ cwd: clone, file: written(), content: "from node A\n" },
				gitEnv(),
			);
		const recorded = await nodeA.firstOutput();
		assert.equal(recorded.snapshots, 1, JSON.stringify(recorded));
		sourceId = recorded.sessionId!;
		nodeA.child.kill("SIGKILL");
		await nodeA.run;
		offline = join(sandbox.root, "node-a-gone");
		renameSync(clone, offline);
		const inspected = await cluster.node("c").run<SessionOutput>(sessionDriver, "inspect", { sessionId: sourceId })
			.run;
		assert.equal(inspected.code, 0, inspected.stderr);
		recordedEntries = inspected.output!.entryIds!;
	});
	afterAll(async () => {
		await cluster?.cleanup();
		sandbox?.dispose();
	});

	test("node B forks the session and continues the fork in node A's restored checkout", async () => {
		const node = cluster.node("b");
		const forked = await node.run<SessionOutput>(
			sessionDriver,
			"fork",
			{ sessionId: sourceId, launchCwd: node.home, readPath: written(), prompt: "continue the fork on node B" },
			gitEnv(),
		).run;
		assert.equal(forked.code, 0, `${forked.stderr}\n${JSON.stringify(forked.output)}`);
		const output = forked.output!;
		forkId = output.sessionId!;
		assert.notEqual(forkId, sourceId);
		assert.equal(output.parentSession, sourceId);
		assert.deepEqual(output.userTexts, ["write the file", "continue the fork on node B"]);
		assert.match(toolText(output), /from node A/);
		const restored = output.mappings?.[0]?.to;
		assert.ok(restored !== undefined, `the fork did not restore node A's checkout: ${JSON.stringify(output)}`);
		assert.ok(restored.startsWith(join(node.agentDir, "worktree-snapshots", "worktrees")), restored);
		// A fork continues where it was started; node A's paths lead into the restored checkout.
		assert.equal(output.cwd, realpathSync(node.home));
		const tree = treeDigest(restored);
		assert.equal(tree["README.md"], treeDigest(offline)["README.md"]);
	});

	test("node C continues the original, which the fork left as node A recorded it", async () => {
		const node = cluster.node("c");
		const before = await node.run<SessionOutput>(sessionDriver, "inspect", { sessionId: sourceId }).run;
		assert.deepEqual(before.output?.entryIds, recordedEntries, "forking changed the original");

		const resumed = await node.run<SessionOutput>(
			resumeDriver,
			"resume",
			{ sessionId: sourceId, launchCwd: node.home, readPath: written() },
			gitEnv(),
		).run;
		assert.equal(resumed.code, 0, `${resumed.stderr}\n${JSON.stringify(resumed.output)}`);
		assert.equal(resumed.output?.userMessages, 2);
		assert.match(toolText(resumed.output), /from node A/);

		const original = (await node.run<SessionOutput>(sessionDriver, "inspect", { sessionId: sourceId }).run).output!;
		const fork = (await node.run<SessionOutput>(sessionDriver, "inspect", { sessionId: forkId }).run).output!;
		assert.deepEqual(original.userTexts, ["write the file", "read the file you wrote"]);
		assert.deepEqual(fork.userTexts, ["write the file", "continue the fork on node B"]);
		assert.equal(fork.parentSession, sourceId);
		assert.deepEqual(original.entryIds?.slice(0, recordedEntries.length), recordedEntries);
		assert.ok(
			!fork.entryIds?.some((id) => original.entryIds!.slice(recordedEntries.length).includes(id)),
			"the fork holds an entry of the original's continuation",
		);
	});
});
