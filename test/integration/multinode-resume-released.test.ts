import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { type FakeLibsqlServer, startFakeLibsqlServer } from "../helpers/fake-libsql-server.js";
import { bunExecutable, makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { treeDigest } from "../helpers/tree-digest.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

useTemporaryAgentDir();

/**
 * Scenario 5 of #4329, reduced to processes on one runner: each node is its own process with its own agent directory,
 * HOME and Atomic home; the nodes share only a libSQL database over HTTP (a loopback stand-in for sqld) selected by
 * ATOMIC_STORAGE. Node B reaches it through a proxy the test can cut, as a partition cuts a node off. The Azure variant
 * runs the same steps on separate VMs against a real sqld.
 */
const MULTINODE_RELEASED_TIMEOUT_MS = 240_000;
/** One node process: it starts Bun, loads the sources and opens the shared database. */
const NODE_STEP_TIMEOUT_MS = 90_000;
/** The wake of a node that is cut off waits out the product's lookup deadline (15 s) before it fails. */
const PARTITIONED_WAKE_TIMEOUT_MS = 90_000;
const driver = join(moduleDir(import.meta.url), "..", "fixtures", "multinode-released-node.ts");
/** This checkout's libSQL adapter by path, so a node never resolves (or Bun auto-installs) a published copy. */
const libsqlAdapter = join(moduleDir(import.meta.url), "..", "..", "packages", "storage-libsql", "libsql.js");
const CLEARED_STORAGE_ENV = {
	ATOMIC_SESSIONS_STORAGE: "",
	ATOMIC_WORKFLOWS_JOURNAL: "",
	ATOMIC_WORKFLOW_JOURNAL_PATH: "",
	ATOMIC_CODING_AGENT_SESSION_DIR: "",
};

interface NodeOutput {
	readonly ready?: boolean;
	readonly sessionId?: string;
	readonly snapshots?: number;
	readonly releasedCwd?: string;
	readonly cwd?: string;
	readonly cwdExists?: boolean;
	readonly mappings?: readonly { from: string; to: string }[];
	readonly userMessages?: number;
	readonly toolResult?: readonly { type: string; text?: string }[];
	readonly error?: { name?: string; code?: string; retryable?: boolean; message?: string };
}

interface NodeRun {
	readonly output: NodeOutput | undefined;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
}

let root: string;
let sandbox: GitSandbox;
let database: FakeLibsqlServer;

function nodeEnv(name: string, storageUrl = database.url): NodeJS.ProcessEnv {
	const home = join(root, name, "home");
	mkdirSync(home, { recursive: true });
	return {
		...process.env,
		...CLEARED_STORAGE_ENV,
		HOME: home,
		ATOMIC_CODING_AGENT_DIR: join(root, name, "agent"),
		ATOMIC_STORAGE: JSON.stringify({ adapter: libsqlAdapter, options: { url: storageUrl } }),
		GIT_CONFIG_GLOBAL: sandbox.globalConfig,
		GIT_CONFIG_NOSYSTEM: "1",
	};
}

function startNode(
	command: string,
	args: object,
	env: NodeJS.ProcessEnv,
	timeoutMs = NODE_STEP_TIMEOUT_MS,
): { child: ChildProcess; run: Promise<NodeRun> } {
	const child = spawn(bunExecutable(), ["--no-install", driver, command, JSON.stringify(args)], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const run = new Promise<NodeRun>((resolveRun) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			const line = stdout.trim().split("\n").filter(Boolean).at(-1);
			resolveRun({ output: line ? (JSON.parse(line) as NodeOutput) : undefined, code, signal, stderr });
		});
	});
	return { child, run };
}

/** The first JSON line `node` prints, or a failure if it ends first. */
function firstOutput(node: { child: ChildProcess; run: Promise<NodeRun> }): Promise<NodeOutput> {
	return new Promise<NodeOutput>((resolveOutput, reject) => {
		let buffer = "";
		node.child.stdout?.on("data", (chunk) => {
			buffer += chunk.toString();
			const line = buffer.split("\n").find((candidate) => candidate.startsWith("{"));
			if (line) resolveOutput(JSON.parse(line) as NodeOutput);
		});
		void node.run.then((run) => reject(new Error(`the node exited early: ${run.stderr}`)));
	});
}

/**
 * A TCP proxy to the database that can be cut: while it is, every connection stays open and nothing moves either way,
 * as on a partitioned network, and what was held is delivered when it heals.
 */
async function partitionProxy(
	targetPort: number,
): Promise<{ port: number; partition: () => void; heal: () => void; close: () => Promise<void> }> {
	let cut = false;
	const sockets = new Set<Socket>();
	const held: Array<() => void> = [];
	const relay = (from: Socket, to: Socket) => {
		from.on("data", (chunk) => {
			const send = () => to.write(chunk);
			if (cut) held.push(send);
			else send();
		});
		from.on("close", () => to.destroy());
		from.on("error", () => to.destroy());
	};
	const server: Server = createServer((client) => {
		const upstream = connect(targetPort, "127.0.0.1");
		sockets.add(client).add(upstream);
		relay(client, upstream);
		relay(upstream, client);
	});
	await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no TCP address");
	return {
		port: address.port,
		partition: () => {
			cut = true;
		},
		heal: () => {
			cut = false;
			for (const send of held.splice(0)) send();
		},
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
		},
	};
}

describe("multi-node wake of a released session (#4329)", () => {
	beforeAll(async () => {
		root = makeTempDirectory("atomic-multinode-released-");
		sandbox = new GitSandbox();
		database = await startFakeLibsqlServer();
	});

	afterAll(async () => {
		await database?.close();
		sandbox?.dispose();
		if (root) await removeTempDirectory(root);
	});

	test(
		"scenario 5: a released session wakes on a different node from the one that released it: its worktree is restored before it continues, and a partition during the wake ends in a retryable typed error before a retry succeeds",
		async () => {
			// Node A's checkout, as a session leaves it: an unpushed commit, an uncommitted edit and an untracked file.
			const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "lib/util.txt": "util\n" });
			sandbox.write(join(clone, "committed.txt"), "unpushed\n");
			const head = await sandbox.commitAll(clone, "unpushed commit");
			sandbox.write(join(clone, "README.md"), "uncommitted edit\n");
			sandbox.write(join(clone, "notes", "untracked.txt"), "untracked\n");
			const written = join(clone, "notes", "agent-wrote.txt");

			// Node A runs the session, releases it, and is killed. Nothing of it is left in memory, and its checkout is gone.
			const nodeA = startNode(
				"release",
				{ cwd: clone, file: written, content: "written by the model on node A\n" },
				nodeEnv("node-a"),
			);
			const released = await firstOutput(nodeA);
			assert.equal(released.releasedCwd, clone);
			assert.equal(released.snapshots, 1, "the session recorded the worktree it changed");
			nodeA.child.kill("SIGKILL");
			assert.equal((await nodeA.run).signal, "SIGKILL");
			const offline = join(root, "node-a-offline");
			renameSync(clone, offline);
			assert.equal(existsSync(clone), false);
			const expected = treeDigest(offline);
			const wakeArgs = {
				cwd: join(root, "node-b", "home"),
				sessionId: released.sessionId,
				readPath: written,
				goFile: join(root, "node-b-go"),
			};

			// A partition during the wake: node B is up, then cut off from the database as its wake starts. The wake fails
			// typed and retryable, and restores nothing.
			const proxy = await partitionProxy(database.port);
			const partitionedNode = startNode(
				"wake",
				wakeArgs,
				nodeEnv("node-b", `http://127.0.0.1:${proxy.port}`),
				PARTITIONED_WAKE_TIMEOUT_MS,
			);
			assert.equal((await firstOutput(partitionedNode)).ready, true);
			proxy.partition();
			writeFileSync(wakeArgs.goFile, "");
			const partitioned = await partitionedNode.run;
			assert.equal(partitioned.code, 2, partitioned.stderr);
			assert.ok(
				["ResumeCatalogTimeoutError", "ResumeCatalogUnavailableError"].includes(
					partitioned.output?.error?.name ?? "",
				),
				JSON.stringify(partitioned.output),
			);
			assert.ok(["catalog-timeout", "catalog-unavailable"].includes(partitioned.output?.error?.code ?? ""));
			assert.equal(partitioned.output?.error?.retryable, true);
			assert.equal(existsSync(join(root, "node-b", "agent", "worktree-snapshots")), false, "nothing was restored");
			proxy.heal();
			await proxy.close();
			rmSync(wakeArgs.goFile);

			// The partition heals and the wake is retried: node B restores the worktree before the session continues.
			writeFileSync(wakeArgs.goFile, "");
			const woken = await startNode("wake", wakeArgs, nodeEnv("node-b")).run;
			assert.equal(woken.code, 0, `${woken.stderr}\n${JSON.stringify(woken.output)}`);
			const output = woken.output!;
			const worktrees = join(root, "node-b", "agent", "worktree-snapshots", "worktrees");
			assert.equal(output.cwdExists, true, `the session continued in ${output.cwd}, which does not exist on node B`);
			assert.ok(output.cwd?.startsWith(worktrees), output.cwd);
			assert.deepEqual(
				output.mappings?.map((mapping) => mapping.from),
				[clone],
			);
			assert.equal(output.cwd, output.mappings![0]!.to);
			// Restored byte for byte, with the commit it was on, before the session continued in it.
			assert.deepEqual(treeDigest(output.cwd!), expected);
			assert.equal(await sandbox.git(output.cwd!, "rev-parse", "HEAD"), head);
			// The conversation continued, and the path node A wrote resolves in the restored worktree.
			assert.equal(output.userMessages, 2);
			assert.match(
				output.toolResult?.map((part) => part.text ?? "").join("") ?? "",
				/written by the model on node A/,
			);
		},
		MULTINODE_RELEASED_TIMEOUT_MS,
	);
});
