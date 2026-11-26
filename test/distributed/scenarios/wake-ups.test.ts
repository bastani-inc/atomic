/**
 * Wake-ups across nodes: released sessions and released subagents wake on a node other than the one that released
 * them, and Intercom wakes released subagents for messages that other nodes send them.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { treeDigest } from "../../helpers/tree-digest.js";
import { GitSandbox } from "../../helpers/worktree-snapshot.js";
import { Cluster, type NodeClient, repoRoot } from "../harness/cluster.js";
import { distributedSkipReason, recordEvent } from "../harness/topology.js";
import { deliveredInOrder, type SentMessage, sendSequence } from "../harness/traffic.js";

const SCENARIO = "wakeups";
const sessionDriver = join(repoRoot, "test/fixtures/multinode-released-node.ts");
const subagentDriver = join(repoRoot, "test/fixtures/multinode-released-subagent-node.ts");
/** The wake of a node that is cut off waits out the product's lookup deadline (15 s) before it fails. */
const PARTITIONED_WAKE_TIMEOUT_MS = 120_000;
const RELEASED_CHILDREN = 4;
const MESSAGES_PER_SENDER = 5;
const DELIVERY = { timeout: 60_000, interval: 100 };

interface NodeOutput {
	readonly ready?: boolean;
	readonly sessionId?: string;
	readonly snapshots?: number;
	readonly releasedCwd?: string;
	readonly ownerSessionId?: string;
	readonly childId?: string;
	readonly childSessionRecordedInStore?: boolean;
	readonly childSnapshots?: number;
	readonly outcome?: string;
	readonly reason?: string;
	readonly cwd?: string;
	readonly cwdExists?: boolean;
	readonly mappings?: readonly { from: string; to: string }[];
	readonly userMessages?: number;
	readonly toolResult?: string | readonly { type: string; text?: string }[];
	readonly error?: { name?: string; code?: string; retryable?: boolean; message?: string };
}

function toolText(output: NodeOutput | undefined): string {
	const result = output?.toolResult;
	return typeof result === "string" ? result : (result?.map((part) => part.text ?? "").join("") ?? "");
}

function restoredEntries(directory: string): string[] {
	return existsSync(directory) ? readdirSync(directory, { recursive: true }).map(String) : [];
}

describe.skipIf(distributedSkipReason !== undefined)("wake-ups across nodes", () => {
	let cluster: Cluster;
	let sandbox: GitSandbox;
	const gitEnv = () => ({ GIT_CONFIG_GLOBAL: sandbox.globalConfig, GIT_CONFIG_NOSYSTEM: "1" });

	beforeAll(async () => {
		cluster = await Cluster.start(SCENARIO, ["a", "b", "c"]);
		sandbox = new GitSandbox();
	});
	afterAll(async () => {
		await cluster?.cleanup();
		sandbox?.dispose();
	});

	/**
	 * Node B starts a wake, prints that it is ready, and is cut off from the database before it begins: the wake fails
	 * typed and retryable and restores nothing. Then the partition heals and the retried wake's output is returned.
	 */
	async function wakeThroughAPartition(script: string, args: Record<string, unknown>): Promise<NodeOutput> {
		const node = cluster.node("b");
		const goFile = join(node.root, `go-${randomUUID().slice(0, 8)}`);
		const worktrees = join(node.agentDir, "worktree-snapshots", "worktrees");
		const restoredBefore = restoredEntries(worktrees);
		const partitioned = node.run<NodeOutput>(
			script,
			"wake",
			{ ...args, goFile },
			gitEnv(),
			PARTITIONED_WAKE_TIMEOUT_MS,
		);
		assert.equal((await partitioned.firstOutput()).ready, true);
		node.partition();
		try {
			writeFileSync(goFile, "");
			const failed = await partitioned.run;
			assert.equal(failed.code, 2, failed.stderr);
			assert.ok(
				["ResumeCatalogTimeoutError", "ResumeCatalogUnavailableError"].includes(failed.output?.error?.name ?? ""),
				JSON.stringify(failed.output),
			);
			assert.equal(failed.output?.error?.retryable, true);
			assert.deepEqual(restoredEntries(worktrees), restoredBefore, "nothing was restored");
		} finally {
			node.heal();
			rmSync(goFile, { force: true });
		}
		writeFileSync(goFile, "");
		const woken = await node.run<NodeOutput>(script, "wake", { ...args, goFile }, gitEnv()).run;
		assert.equal(woken.code, 0, `${woken.stderr}\n${JSON.stringify(woken.output)}`);
		return woken.output!;
	}

	test("a released session wakes on node B in its restored checkout; a partition during the wake fails typed first", async () => {
		const { clone } = await sandbox.remoteWithClone("session-repo", { "README.md": "hello\n" });
		sandbox.write(join(clone, "README.md"), "uncommitted edit\n");
		const written = join(clone, "notes", "agent-wrote.txt");
		const nodeA = cluster
			.node("a")
			.run<NodeOutput>(
				sessionDriver,
				"release",
				{ cwd: clone, file: written, content: "written on node A\n" },
				gitEnv(),
			);
		const released = await nodeA.firstOutput();
		assert.equal(released.snapshots, 1, JSON.stringify(released));
		nodeA.child.kill("SIGKILL");
		await nodeA.run;
		const offline = join(sandbox.root, "session-repo-gone");
		renameSync(clone, offline);

		const node = cluster.node("b");
		const cwd = join(node.root, "wake-cwd");
		mkdirSync(cwd, { recursive: true });
		const output = await wakeThroughAPartition(sessionDriver, {
			cwd,
			sessionId: released.sessionId,
			readPath: written,
		});
		assert.equal(output.cwdExists, true);
		assert.ok(output.cwd?.startsWith(join(node.agentDir, "worktree-snapshots", "worktrees")), output.cwd);
		assert.deepEqual(
			output.mappings?.map((mapping) => mapping.from),
			[clone],
		);
		assert.deepEqual(treeDigest(output.cwd!), treeDigest(offline));
		assert.equal(output.userMessages, 2);
		assert.match(toolText(output), /written on node A/);
	});

	test("a released background subagent wakes on node B in its restored checkout; a partition during the wake fails typed first", async () => {
		const ownerCwd = join(sandbox.root, "owner-cwd");
		mkdirSync(ownerCwd, { recursive: true });
		const { clone } = await sandbox.remoteWithClone("agent-repo", { "README.md": "hello\n" });
		sandbox.write(join(clone, "README.md"), "uncommitted edit\n");
		const written = join(clone, "notes", "subagent-wrote.txt");
		const nodeA = cluster
			.node("a")
			.run<NodeOutput>(
				subagentDriver,
				"release",
				{ ownerCwd, cwd: clone, file: written, content: "written by the subagent on node A\n" },
				gitEnv(),
			);
		const released = await nodeA.firstOutput();
		assert.equal(released.error, undefined, JSON.stringify(released));
		assert.equal(released.childSessionRecordedInStore, true);
		assert.equal(released.childSnapshots, 1);
		nodeA.child.kill("SIGKILL");
		await nodeA.run;
		const offline = join(sandbox.root, "agent-repo-gone");
		renameSync(clone, offline);

		const output = await wakeThroughAPartition(subagentDriver, {
			ownerCwd,
			workedIn: clone,
			ownerSessionId: released.ownerSessionId,
			childId: released.childId,
			readPath: written,
		});
		assert.equal(output.outcome, "restored", `${output.outcome}: ${output.reason}`);
		assert.equal(output.cwdExists, true);
		assert.ok(
			output.cwd?.startsWith(join(cluster.node("b").agentDir, "worktree-snapshots", "worktrees")),
			output.cwd,
		);
		assert.deepEqual(treeDigest(output.cwd!), treeDigest(offline));
		assert.match(toolText(output), /written by the subagent on node A/);
	});

	test("Intercom wakes released subagents for messages from other nodes, and each arrives once, in order", async () => {
		const [a, b, c] = ["a", "b", "c"].map((name) => cluster.node(name));
		for (const node of [a!, b!, c!]) await node.startBroker();
		const ownerToken = randomUUID();
		const owner = await b!.connect(`owner-${randomUUID().slice(0, 6)}`, { supervisorOwnerToken: ownerToken });

		// Each child ran once on node B, so every broker knows its session, and was then released.
		const children: { name: string; returnAddress: string; sessionId: string }[] = [];
		for (let index = 0; index < RELEASED_CHILDREN; index++) {
			const child = {
				name: `child-${index}-${randomUUID().slice(0, 6)}`,
				returnAddress: randomUUID(),
				sessionId: randomUUID(),
			};
			const connected = await b!.connect(child.name, {
				returnAddress: child.returnAddress,
				preferredSessionId: child.sessionId,
			});
			assert.equal(connected.sessionId, child.sessionId);
			await b!.disconnect(connected);
			children.push(child);
		}

		// The owner restores a child when Intercom wakes it, as the subagent runtime does: it authorizes the child, which
		// connects again as the same session. A wake for a child already being restored is a repeat, as there.
		const wakes: string[] = [];
		const woken = new Map<string, NodeClient>();
		const restoring: Promise<void>[] = [];
		owner.client.on("restoring_recipient_wake", (notice: { childName: string }) => {
			wakes.push(notice.childName);
			const child = children.find((candidate) => candidate.name === notice.childName);
			if (child === undefined || wakes.indexOf(notice.childName) !== wakes.length - 1) return;
			restoring.push(
				(async () => {
					const authorization = await owner.client.authorizeSupervisorChild(child.name);
					woken.set(
						child.name,
						await b!.connect(child.name, {
							returnAddress: child.returnAddress,
							preferredSessionId: child.sessionId,
							supervisor: {
								capability: authorization.capability,
								supervisorSessionId: authorization.supervisorSessionId,
							},
						}),
					);
				})(),
			);
		});
		await owner.client.reserveReleasedChildren(
			children.map((child) => ({
				childName: child.name,
				aliases: [child.returnAddress, child.sessionId],
				wake: true,
			})),
		);

		const senders = [await a!.connect("sender-a"), await c!.connect("sender-c")];
		const sent: SentMessage[] = (
			await Promise.all(
				senders.flatMap((sender) =>
					children.map((child) =>
						sendSequence(sender, child.name, child.name, MESSAGES_PER_SENDER, "wake", () =>
							woken.get(child.name),
						),
					),
				),
			)
		).flat();
		recordEvent(SCENARIO, { event: "sent-to-released", messages: sent.length, wakes: wakes.length });
		await Promise.all(restoring);
		assert.deepEqual([...new Set(wakes)].sort(), children.map((child) => child.name).sort(), "every child was woken");
		assert.equal(restoring.length, children.length, "each child was restored once");
		for (const child of children)
			await vi.waitFor(
				() =>
					deliveredInOrder(
						woken.get(child.name)!,
						sent.filter((message) => message.to === child.name),
					),
				DELIVERY,
			);
		assert.equal(wakes.length, children.length, "each child was woken once");
	});
});
