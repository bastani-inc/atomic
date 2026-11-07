import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { bunExecutable, makeTempDirectory, moduleDir, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/**
 * Reduced variant of the #4329 workflow acceptance scenarios: each node is its own process with its own agent
 * directory, HOME and Atomic home, and the nodes share only a libSQL `file:` journal. The Azure variant runs the same
 * driver on separate VMs against a shared sqld.
 */
const MULTINODE_RUN_SCENARIO_TIMEOUT_MS = 240_000;
/** The shipped run lookup deadline (RESUME_CATALOG_TIMEOUT_MS), which the partitioned resume waits out in full. */
const RUN_LOOKUP_DEADLINE_MS = 15_000;
const NODE_STEP_TIMEOUT_MS = 120_000;
const driver = join(moduleDir(import.meta.url), "..", "fixtures", "multinode-run-node.ts");
const libsqlAdapter = join(moduleDir(import.meta.url), "..", "..", "packages", "storage-libsql", "libsql.js");
const CLEARED_STORAGE_ENV = {
	ATOMIC_STORAGE: "",
	ATOMIC_SESSIONS_STORAGE: "",
	ATOMIC_WORKFLOWS_JOURNAL: "",
	ATOMIC_WORKFLOW_JOURNAL_PATH: "",
	ATOMIC_CODING_AGENT_SESSION_DIR: "",
};

interface RunOutput {
	readonly runId?: string;
	readonly forkRunId?: string;
	readonly status?: string;
	readonly result?: Record<string, string>;
	readonly error?: {
		readonly name?: string;
		readonly message?: string;
		readonly code?: string;
		readonly retryable?: boolean;
		readonly subject?: string;
	};
}

interface NodeRun {
	readonly lines: readonly RunOutput[];
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
}

let root: string;
let gitPath: string;
let journalUrl: string;

function nodeEnv(name: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const home = join(root, name, "home");
	mkdirSync(home, { recursive: true });
	return {
		...process.env,
		...CLEARED_STORAGE_ENV,
		HOME: home,
		ATOMIC_CODING_AGENT_DIR: join(root, name, "agent"),
		MULTINODE_NODE: name,
		MULTINODE_LIBSQL: libsqlAdapter,
		MULTINODE_JOURNAL_URL: journalUrl,
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		...extra,
	};
}

function startNode(
	command: string,
	args: object,
	env: NodeJS.ProcessEnv,
): { child: ChildProcess; run: Promise<NodeRun> } {
	const child = spawn(bunExecutable(), ["--no-install", driver, command, JSON.stringify(args)], {
		cwd: env.HOME,
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
		const timer = setTimeout(() => child.kill("SIGKILL"), NODE_STEP_TIMEOUT_MS);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			const lines = stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as RunOutput);
			resolveRun({ lines, code, signal, stderr });
		});
	});
	return { child, run };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync(gitPath, args, {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
	})
		.toString()
		.trim();
}

/** A bare repository with one commit on `main`, reachable from every node through a `file://` URL. */
function remote(name: string, files: Readonly<Record<string, string>>): { url: string; bare: string } {
	const seed = join(root, "seeds", name);
	mkdirSync(seed, { recursive: true });
	git(seed, "init", "-q", "-b", "main");
	for (const [file, content] of Object.entries(files)) writeFileSync(join(seed, file), content);
	git(seed, "add", "-A");
	git(seed, "commit", "-q", "-m", "initial");
	const bare = join(root, "remotes", `${name}.git`);
	mkdirSync(dirname(bare), { recursive: true });
	git(root, "clone", "-q", "--bare", seed, bare);
	return { url: pathToFileURL(bare).href, bare };
}

/** A git on PATH that runs the real one and SIGKILLs the node at its `killAt`-th `git worktree add`, once. */
function killingGit(name: string, killAt: number): string {
	const shimDir = join(root, name, "shim");
	mkdirSync(shimDir, { recursive: true });
	const counter = join(root, name, "worktree-adds");
	const marker = join(root, name, "killed-mid-restore");
	writeFileSync(
		join(shimDir, "git"),
		`#!/bin/sh\n"${gitPath}" "$@"\nstatus=$?\ncase "$*" in *"worktree add"*) echo x >> "${counter}"; if [ ! -e "${marker}" ] && [ "$(wc -l < "${counter}")" -ge ${killAt} ]; then : > "${marker}"; kill -9 $PPID; fi;; esac\nexit $status\n`,
	);
	chmodSync(join(shimDir, "git"), 0o755);
	return shimDir;
}

/** A loopback TCP server that accepts connections and never answers, as a partitioned database looks to a client. */
async function silentServer(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
	const sockets: Socket[] = [];
	const server: Server = createServer((socket) => {
		sockets.push(socket);
	});
	await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no TCP address");
	return {
		port: address.port,
		connections: () => sockets.length,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
		},
	};
}

/** Waits until every file in `files` exists or `node` ends. */
async function untilFiles(files: readonly string[], node: { run: Promise<NodeRun> }): Promise<void> {
	let ended: NodeRun | undefined;
	void node.run.then((run) => {
		ended = run;
	});
	while (!files.every((file) => existsSync(file))) {
		if (ended !== undefined) assert.fail(`the node ended early: ${ended.stderr}\n${JSON.stringify(ended.lines)}`);
		await sleep(50);
	}
}

/**
 * The worktrees under `worktrees` that a restore left half done: a directory at a worktree path, outside the staging
 * directories an interrupted restore leaves for the next one to sweep, that is not a checkout of its own with a HEAD.
 */
function halfRestored(worktrees: string): string[] {
	if (!existsSync(worktrees)) return [];
	return readdirSync(worktrees)
		.filter((entry) => !entry.startsWith(".staging-"))
		.map((entry) => join(worktrees, entry))
		.filter((path) => {
			try {
				git(path, "rev-parse", "--verify", "HEAD");
				return git(path, "rev-parse", "--show-toplevel") !== path;
			} catch {
				return true;
			}
		});
}

/**
 * Lets the dead holder's lease on `runId` lapse, as it does on its own after the foreign-execution window, so a test
 * does not wait for it; the same step main's shared-pool host tests take.
 */
async function expireLease(runId: string): Promise<void> {
	const database = await openLibsqlDatabase({ url: journalUrl });
	try {
		await database.run("UPDATE wf_leases SET renewed_at = 0 WHERE run_id = ?", runId);
	} finally {
		await database.close();
	}
}

function finalLine(run: NodeRun): RunOutput {
	const line = run.lines.at(-1);
	assert.ok(line !== undefined, `no output: ${run.stderr}`);
	return line;
}

describe.skipIf(process.platform === "win32")(
	"multi-node workflow resume, reduced to processes on one runner (#4329)",
	() => {
		beforeAll(() => {
			root = makeTempDirectory("atomic-multinode-runs-");
			gitPath = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
			journalUrl = pathToFileURL(join(root, "shared", "journal.db")).href;
			mkdirSync(join(root, "shared"), { recursive: true });
			writeFileSync(
				join(root, "gitconfig"),
				'[user]\n\tname = Fixture\n\temail = fixture@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n[protocol "file"]\n\tallow = always\n',
			);
		});

		afterAll(() => {
			if (root) removeTempDirectory(root);
		});

		test(
			"scenario 2: a workflow bound to two repositories is killed mid-step on node A and resumed on node B without repeating or misplacing work",
			async () => {
				const alpha = remote("alpha", { "README.md": "alpha\n" });
				const beta = remote("beta", { "README.md": "beta\n" });
				const runId = randomUUID();
				const holdDir = join(root, "holds");
				mkdirSync(holdDir, { recursive: true });
				const nodeA = startNode(
					"two-repos",
					{ runId, alpha: alpha.url, beta: beta.url },
					nodeEnv("node-a", { HOLD_DIR: holdDir }),
				);
				await untilFiles([join(holdDir, "alpha.holding"), join(holdDir, "beta.holding")], nodeA);
				nodeA.child.kill("SIGKILL");
				assert.equal((await nodeA.run).signal, "SIGKILL");
				renameSync(join(root, "node-a"), join(root, "node-a-gone"));
				await expireLease(runId);

				const shim = killingGit("node-b", 2);
				const killed = await startNode(
					"two-repos",
					{ runId, alpha: alpha.url, beta: beta.url },
					nodeEnv("node-b", { PATH: `${shim}:${process.env.PATH}` }),
				).run;
				assert.equal(killed.signal, "SIGKILL", `${killed.stderr}\n${JSON.stringify(killed.lines)}`);
				assert.ok(existsSync(join(root, "node-b", "killed-mid-restore")));

				const resumed = await startNode(
					"two-repos",
					{ runId, alpha: alpha.url, beta: beta.url },
					nodeEnv("node-b", { PATH: `${shim}:${process.env.PATH}` }),
				).run;
				assert.equal(resumed.code, 0, `${resumed.stderr}\n${JSON.stringify(resumed.lines)}`);
				const output = finalLine(resumed);
				assert.equal(output.status, "completed", JSON.stringify(output));
				const worktrees = join(root, "node-b", "agent", "worktree-snapshots", "worktrees");
				const children = (["alpha", "beta"] as const).map(
					(name) => JSON.parse(output.result?.[name] ?? "{}") as { cwd: string; effects: string; notes: string },
				);
				for (const child of children) {
					assert.ok(child.cwd.startsWith(worktrees), child.cwd);
					assert.equal(child.effects, "node-a\n", "the completed effect ran once, on node A");
					assert.equal(child.notes, "uncommitted, written on node-a\n");
				}
				assert.notEqual(children[0]!.cwd, children[1]!.cwd);
				assert.equal(readFileSync(join(children[0]!.cwd, "README.md"), "utf8"), "alpha\n");
				assert.equal(readFileSync(join(children[1]!.cwd, "README.md"), "utf8"), "beta\n");
				assert.deepEqual(halfRestored(worktrees), []);
			},
			MULTINODE_RUN_SCENARIO_TIMEOUT_MS,
		);

		test(
			"scenario 4: forkRun from an earlier stage on a third node materializes that stage's snapshot, also after a SIGKILL mid-restore",
			async () => {
				const gamma = remote("gamma", { "README.md": "gamma\n", "state.txt": "zero\n" });
				const clone = join(root, "fork-node-a", "home", "repo");
				mkdirSync(dirname(clone), { recursive: true });
				git(root, "clone", "-q", gamma.bare, clone);
				const sourceRunId = randomUUID();
				const source = await startNode("stepped", { runId: sourceRunId, cwd: clone }, nodeEnv("fork-node-a")).run;
				assert.equal(source.code, 0, `${source.stderr}\n${JSON.stringify(source.lines)}`);
				const sourceOutput = finalLine(source);
				assert.equal(sourceOutput.status, "completed", JSON.stringify(sourceOutput));
				assert.equal((JSON.parse(sourceOutput.result?.two ?? "{}") as { before: string }).before, "one\n");
				renameSync(join(root, "fork-node-a"), join(root, "fork-node-a-gone"));

				const shim = killingGit("fork-node-c", 1);
				const killed = await startNode(
					"fork",
					{ sourceRunId, fromStage: "two" },
					nodeEnv("fork-node-c", { PATH: `${shim}:${process.env.PATH}` }),
				).run;
				assert.equal(killed.signal, "SIGKILL", `${killed.stderr}\n${JSON.stringify(killed.lines)}`);

				const forked = await startNode(
					"fork",
					{ sourceRunId, fromStage: "two" },
					nodeEnv("fork-node-c", { PATH: `${shim}:${process.env.PATH}` }),
				).run;
				assert.equal(forked.code, 0, `${forked.stderr}\n${JSON.stringify(forked.lines)}`);
				const output = finalLine(forked);
				assert.equal(output.status, "completed", JSON.stringify(output));
				assert.notEqual(output.runId, sourceRunId);
				const one = JSON.parse(output.result?.one ?? "{}") as { before: string; cwd: string };
				const two = JSON.parse(output.result?.two ?? "{}") as { before: string; cwd: string };
				assert.equal(one.before, "zero\n", "stage one replays its saved result");
				assert.equal(two.before, "one\n", "stage two runs again on the tree recorded at its fork point");
				const worktrees = join(root, "fork-node-c", "agent", "worktree-snapshots", "worktrees");
				assert.ok(two.cwd.startsWith(worktrees), two.cwd);
				assert.equal(readFileSync(join(two.cwd, "state.txt"), "utf8"), "two\n");
				assert.deepEqual(halfRestored(worktrees), []);
			},
			MULTINODE_RUN_SCENARIO_TIMEOUT_MS,
		);

		test(
			"scenario 7: a database partition during the run lookup and a SIGKILL mid-restore end typed or in a retry that succeeds, never in a half-restored worktree",
			async () => {
				const delta = remote("delta", { "README.md": "delta\n" });
				const epsilon = remote("epsilon", { "README.md": "epsilon\n" });
				const runId = randomUUID();
				const holdDir = join(root, "chaos-holds");
				mkdirSync(holdDir, { recursive: true });
				const inputs = { runId, alpha: delta.url, beta: epsilon.url };
				const nodeA = startNode("two-repos", inputs, nodeEnv("chaos-node-a", { HOLD_DIR: holdDir }));
				await untilFiles([join(holdDir, "alpha.holding"), join(holdDir, "beta.holding")], nodeA);
				nodeA.child.kill("SIGKILL");
				await nodeA.run;
				renameSync(join(root, "chaos-node-a"), join(root, "chaos-node-a-gone"));
				await expireLease(runId);
				const worktrees = join(root, "chaos-node-b", "agent", "worktree-snapshots", "worktrees");

				const partition = await silentServer();
				const startedAt = Date.now();
				const partitioned = await startNode(
					"two-repos",
					inputs,
					nodeEnv("chaos-node-b", { MULTINODE_JOURNAL_URL: `http://127.0.0.1:${partition.port}` }),
				).run;
				const waitedMs = Date.now() - startedAt;
				await partition.close();
				assert.equal(partitioned.code, 2, partitioned.stderr);
				const { message: _message, ...timeout } = finalLine(partitioned).error ?? {};
				assert.deepEqual(timeout, {
					name: "ResumeCatalogTimeoutError",
					code: "catalog-timeout",
					retryable: true,
					subject: "run",
				});
				assert.ok(waitedMs >= RUN_LOOKUP_DEADLINE_MS, `${waitedMs} ms`);
				assert.ok(partition.connections() >= 1);
				assert.equal(existsSync(worktrees), false, "a partitioned lookup restores nothing");

				const shim = killingGit("chaos-node-b", 1);
				const killed = await startNode(
					"two-repos",
					inputs,
					nodeEnv("chaos-node-b", { PATH: `${shim}:${process.env.PATH}` }),
				).run;
				assert.equal(killed.signal, "SIGKILL", `${killed.stderr}\n${JSON.stringify(killed.lines)}`);
				assert.deepEqual(halfRestored(worktrees), []);

				const recovered = await startNode(
					"two-repos",
					inputs,
					nodeEnv("chaos-node-b", { PATH: `${shim}:${process.env.PATH}` }),
				).run;
				assert.equal(recovered.code, 0, `${recovered.stderr}\n${JSON.stringify(recovered.lines)}`);
				const output = finalLine(recovered);
				assert.equal(output.status, "completed", JSON.stringify(output));
				for (const name of ["alpha", "beta"] as const) {
					const child = JSON.parse(output.result?.[name] ?? "{}") as { cwd: string; effects: string };
					assert.ok(child.cwd.startsWith(worktrees), child.cwd);
					assert.equal(child.effects, "chaos-node-a\n");
				}
				assert.deepEqual(halfRestored(worktrees), []);
			},
			MULTINODE_RUN_SCENARIO_TIMEOUT_MS,
		);
	},
);
