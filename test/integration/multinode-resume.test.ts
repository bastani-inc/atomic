import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { bunExecutable, makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/**
 * Reduced variant of the #4329 acceptance scenarios: each node is its own process with its own agent directory, HOME
 * and Atomic home; the nodes share only a libSQL `file:` database selected by ATOMIC_STORAGE. The Azure variant runs
 * the same steps on separate VMs against a shared sqld.
 */
const MULTINODE_SCENARIO_TIMEOUT_MS = 240_000;
const NODE_STEP_TIMEOUT_MS = 90_000;
/** The lookup deadline of the partitioned step: long enough to start Bun and open the adapter, short for CI. */
const PARTITION_LOOKUP_TIMEOUT_MS = 3_000;
const driver = join(moduleDir(import.meta.url), "..", "fixtures", "multinode-resume-node.ts");
/** This checkout's libSQL adapter by path, so a node never resolves (or Bun auto-installs) a published copy. */
const libsqlAdapter = join(moduleDir(import.meta.url), "..", "..", "packages", "storage-libsql", "libsql.js");
const CLEARED_STORAGE_ENV = {
	ATOMIC_SESSIONS_STORAGE: "",
	ATOMIC_WORKFLOWS_JOURNAL: "",
	ATOMIC_WORKFLOW_JOURNAL_PATH: "",
	ATOMIC_CODING_AGENT_SESSION_DIR: "",
};

interface NodeOutput {
	readonly sessionId?: string;
	readonly snapshots?: number;
	readonly cwd?: string;
	readonly notices?: readonly { type: string; message: string }[];
	readonly mappings?: readonly { from: string; to: string }[];
	readonly userMessages?: number;
	readonly toolResult?: readonly { type: string; text?: string }[];
	readonly readFile?: string;
	readonly error?: {
		name?: string;
		code?: string;
		message?: string;
		problems?: readonly { code: string; subject: string; checkout?: string }[];
		cause?: { name?: string; code?: string };
	};
}

interface NodeRun {
	readonly output: NodeOutput | undefined;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
}

let root: string;
let gitPath: string;
let sharedDatabase: string;

function nodeEnv(name: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const home = join(root, name, "home");
	mkdirSync(home, { recursive: true });
	return {
		...process.env,
		...CLEARED_STORAGE_ENV,
		HOME: home,
		ATOMIC_CODING_AGENT_DIR: join(root, name, "agent"),
		ATOMIC_STORAGE: JSON.stringify({
			adapter: libsqlAdapter,
			options: { url: `file:${sharedDatabase}` },
		}),
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
		const timer = setTimeout(() => child.kill("SIGKILL"), NODE_STEP_TIMEOUT_MS);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			const line = stdout.trim().split("\n").filter(Boolean).at(-1);
			resolveRun({ output: line ? (JSON.parse(line) as NodeOutput) : undefined, code, signal, stderr });
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

/** Every file below `dir` except Git metadata, with its bytes. */
function treeFiles(dir: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.set(relative(dir, path), readFileSync(path).toString("base64"));
		}
	};
	walk(dir);
	return files;
}

/**
 * This machine's Git packed as Atomic's portable Git archive (`bin/git`, `libexec/git-core`, templates, an empty system
 * config and CA bundle), with its SHA-256 and version, so a node without Git can provision a working one offline.
 */
function portableGitArchive(): { archive: string; sha256: string; version: string } {
	const execPath = execFileSync(gitPath, ["--exec-path"]).toString().trim();
	const source = join(root, "portable-git");
	for (const dir of ["bin", "libexec", "share/git-core", "etc", "ssl"])
		mkdirSync(join(source, dir), { recursive: true });
	copyFileSync(realpathSync(gitPath), join(source, "bin", "git"));
	chmodSync(join(source, "bin", "git"), 0o755);
	cpSync(execPath, join(source, "libexec", "git-core"), { recursive: true, verbatimSymlinks: true });
	const templates = join(execPath, "..", "..", "share", "git-core", "templates");
	if (existsSync(templates)) cpSync(templates, join(source, "share", "git-core", "templates"), { recursive: true });
	else mkdirSync(join(source, "share", "git-core", "templates"));
	writeFileSync(join(source, "etc", "gitconfig"), "");
	writeFileSync(join(source, "ssl", "cacert.pem"), "");
	const archive = join(root, "portable-git.tar.gz");
	execFileSync("tar", ["czf", archive, "-C", source, "."]);
	const version = /git version (\S+)/.exec(execFileSync(gitPath, ["--version"]).toString())?.[1] ?? "";
	return { archive, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"), version };
}

/** A directory holding only the tools Git provisioning unpacks with, for a PATH without Git. */
function provisioningTools(): string {
	const tools = join(root, "provisioning-tools");
	if (existsSync(tools)) return tools;
	mkdirSync(tools, { recursive: true });
	for (const tool of ["tar", "gzip"]) {
		const located = execFileSync("sh", ["-c", `command -v ${tool}`])
			.toString()
			.trim();
		symlinkSync(located, join(tools, tool));
	}
	return tools;
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

describe.skipIf(process.platform === "win32")("multi-node resume, reduced to processes on one runner (#4329)", () => {
	let clone: string;
	let offlineClone: string;
	let sessionId: string;
	let killedAttempt: string[] = [];

	beforeAll(async () => {
		root = await makeTempDirectory("atomic-multinode-");
		gitPath = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
		sharedDatabase = join(root, "shared", "team.db");
		mkdirSync(dirname(sharedDatabase), { recursive: true });
		writeFileSync(
			join(root, "gitconfig"),
			'[user]\n\tname = Fixture\n\temail = fixture@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n[protocol "file"]\n\tallow = always\n',
		);
		const remote = join(root, "remote.git");
		git(root, "init", "-q", "--bare", remote);
		clone = join(root, "node-a", "home", "repo");
		mkdirSync(dirname(clone), { recursive: true });
		git(root, "clone", "-q", remote, clone);
		writeFileSync(join(clone, "README.md"), "hello\n");
		writeFileSync(join(clone, "package-lock.json"), "{}\n");
		git(clone, "add", "-A");
		git(clone, "commit", "-q", "-m", "initial");
		git(clone, "push", "-q", "origin", "HEAD:main");
		git(clone, "branch", "-q", "--set-upstream-to=origin/main");
		writeFileSync(join(clone, "unpushed.txt"), "only on node A\n");
		git(clone, "add", "-A");
		git(clone, "commit", "-q", "-m", "unpushed commit");
		writeFileSync(join(clone, "README.md"), "uncommitted edit\n");
		mkdirSync(join(clone, "notes"));
		writeFileSync(join(clone, "notes", "untracked.txt"), "untracked\n");
	}, MULTINODE_SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		if (root) await removeTempDirectory(root);
	});

	test(
		"scenario 1: a session killed on node A resumes on node B in a byte-identical tree, with chaos on the way",
		async () => {
			const nodeA = startNode(
				"record",
				{ cwd: clone, file: join(clone, "notes", "agent-wrote.txt"), content: "written by the model on node A\n" },
				nodeEnv("node-a"),
			);
			const recorded = await new Promise<NodeOutput>((resolveRecorded, reject) => {
				let buffer = "";
				nodeA.child.stdout?.on("data", (chunk) => {
					buffer += chunk.toString();
					const line = buffer.split("\n").find((candidate) => candidate.startsWith("{"));
					if (line) resolveRecorded(JSON.parse(line) as NodeOutput);
				});
				void nodeA.run.then((run) => reject(new Error(`node A exited early: ${run.stderr}`)));
			});
			sessionId = recorded.sessionId!;
			assert.equal(recorded.snapshots, 1);
			nodeA.child.kill("SIGKILL");
			assert.equal((await nodeA.run).signal, "SIGKILL");
			offlineClone = join(root, "node-a-offline", "home", "repo");
			renameSync(join(root, "node-a"), join(root, "node-a-offline"));

			const nodeCPath = join(root, "node-c", "bin");
			mkdirSync(nodeCPath, { recursive: true });
			// Without Git the session still opens, without its checkout and with one notice saying why (#4733).
			const gitless = await startNode(
				"resume",
				{
					sessionId,
					launchCwd: join(root, "node-c", "home"),
					readPath: join(clone, "notes", "agent-wrote.txt"),
					openOnly: true,
				},
				nodeEnv("node-c", { PATH: `${nodeCPath}:${dirname(bunExecutable())}`, ATOMIC_OFFLINE: "1" }),
			).run;
			assert.equal(gitless.code, 0, gitless.stderr);
			assert.deepEqual(gitless.output?.mappings, []);
			assert.equal(gitless.output?.cwd, join(root, "node-c", "home"));
			assert.equal(gitless.output?.notices?.length, 1, JSON.stringify(gitless.output?.notices));
			assert.match(gitless.output?.notices?.[0]?.message ?? "", /Git is unavailable here \(offline\)/);
			assert.equal(existsSync(join(root, "node-c", "agent", "worktree-snapshots", "worktrees")), false);

			const partition = await silentServer();
			const partitioned = await startNode(
				"resume",
				{
					sessionId,
					launchCwd: join(root, "node-b", "home"),
					readPath: join(clone, "notes", "agent-wrote.txt"),
					catalogTimeoutMs: PARTITION_LOOKUP_TIMEOUT_MS,
				},
				nodeEnv("node-b", {
					ATOMIC_STORAGE: JSON.stringify({
						adapter: libsqlAdapter,
						options: { url: `http://127.0.0.1:${partition.port}` },
					}),
				}),
			).run;
			await partition.close();
			assert.equal(partitioned.code, 2, partitioned.stderr);
			assert.deepEqual(
				[partitioned.output?.error?.name, partitioned.output?.error?.code],
				["ResumeCatalogTimeoutError", "catalog-timeout"],
			);
			assert.ok(partition.connections() >= 1);
			assert.equal(existsSync(join(root, "node-b", "agent", "worktree-snapshots")), false);

			const shimDir = join(root, "node-b", "shim");
			mkdirSync(shimDir, { recursive: true });
			const killMarker = join(root, "node-b", "killed-mid-restore");
			writeFileSync(
				join(shimDir, "git"),
				`#!/bin/sh\n"${gitPath}" "$@"\nstatus=$?\ncase "$*" in *"worktree add"*) if [ ! -e "${killMarker}" ]; then : > "${killMarker}"; kill -9 $PPID; fi;; esac\nexit $status\n`,
			);
			chmodSync(join(shimDir, "git"), 0o755);
			const setupMarker = join(root, "node-b", "setup-ran");
			const resumeArgs = {
				sessionId,
				launchCwd: join(root, "node-b", "home"),
				readPath: join(clone, "notes", "agent-wrote.txt"),
				setupCommand: `echo ran >> "${setupMarker}"`,
			};
			const killed = await startNode(
				"resume",
				resumeArgs,
				nodeEnv("node-b", { PATH: `${shimDir}:${process.env.PATH}` }),
			).run;
			assert.equal(killed.signal, "SIGKILL");
			assert.ok(existsSync(killMarker));

			const resumed = await startNode(
				"resume",
				resumeArgs,
				nodeEnv("node-b", { PATH: `${shimDir}:${process.env.PATH}` }),
			).run;
			assert.equal(resumed.code, 0, `${resumed.stderr}\n${JSON.stringify(resumed.output)}`);
			const output = resumed.output!;
			const worktrees = join(root, "node-b", "agent", "worktree-snapshots", "worktrees");
			assert.ok(output.cwd?.startsWith(worktrees), output.cwd);
			assert.deepEqual(
				output.mappings?.map((mapping) => mapping.from),
				[clone],
			);
			const restoredRoot = output.mappings![0]!.to;
			assert.equal(output.cwd, restoredRoot);
			assert.deepEqual(treeFiles(restoredRoot), treeFiles(offlineClone));
			assert.equal(git(restoredRoot, "rev-parse", "HEAD"), git(offlineClone, "rev-parse", "HEAD"));
			git(restoredRoot, "fsck", "--no-progress");
			assert.equal(output.userMessages, 2);
			assert.match(
				output.toolResult?.map((part) => part.text ?? "").join("") ?? "",
				/written by the model on node A/,
			);
			assert.match(output.notices?.[0]?.message ?? "", /^Restored worktree snapshot/);
			assert.equal(readFileSync(setupMarker, "utf8"), "ran\n");
			killedAttempt = readdirSync(worktrees)
				.map((name) => join(worktrees, name))
				.filter((path) => path !== restoredRoot);
			assert.equal(killedAttempt.length, 1);
			assert.ok(!output.mappings!.some((mapping) => killedAttempt.includes(mapping.to)));
			assert.ok(!killedAttempt.some((path) => output.cwd!.startsWith(path)));
		},
		MULTINODE_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a session recorded at a path that node B also holds, with another tree, continues through the SDK in a restored worktree",
		async () => {
			const fleetPath = join(root, "fleet", "repo");
			mkdirSync(dirname(fleetPath), { recursive: true });
			git(root, "clone", "-q", join(root, "remote.git"), fleetPath);
			writeFileSync(join(fleetPath, "README.md"), "edited on node A\n");
			const nodeA = startNode(
				"record",
				{ cwd: fleetPath, file: join(fleetPath, "notes.txt"), content: "written on node A\n" },
				nodeEnv("fleet-node-a"),
			);
			const recorded = await new Promise<NodeOutput>((resolveRecorded, reject) => {
				let buffer = "";
				nodeA.child.stdout?.on("data", (chunk) => {
					buffer += chunk.toString();
					const line = buffer.split("\n").find((candidate) => candidate.startsWith("{"));
					if (line) resolveRecorded(JSON.parse(line) as NodeOutput);
				});
				void nodeA.run.then((run) => reject(new Error(`node A exited early: ${run.stderr}`)));
			});
			nodeA.child.kill("SIGKILL");
			await nodeA.run;
			renameSync(fleetPath, join(root, "fleet", "node-a-repo"));
			git(root, "clone", "-q", join(root, "remote.git"), fleetPath);
			writeFileSync(join(fleetPath, "README.md"), "node B's own checkout\n");

			const opened = await startNode(
				"sdk-open",
				{ sessionId: recorded.sessionId, readFile: "README.md" },
				nodeEnv("node-b"),
			).run;

			assert.equal(opened.code, 0, `${opened.stderr}\n${JSON.stringify(opened.output)}`);
			const restoredRoot = opened.output?.mappings?.[0]?.to;
			assert.deepEqual(
				opened.output?.mappings?.map((mapping) => mapping.from),
				[fleetPath],
			);
			assert.equal(opened.output?.cwd, restoredRoot);
			assert.ok(restoredRoot?.startsWith(join(root, "node-b", "agent", "worktree-snapshots", "worktrees")));
			assert.equal(opened.output?.readFile, "edited on node A\n");
			assert.equal(readFileSync(join(fleetPath, "README.md"), "utf8"), "node B's own checkout\n");
		},
		MULTINODE_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a session that wrote into two repositories on node A gets both restored and set up on node B",
		async () => {
			const repos = ["alpha", "beta"].map((name) => {
				const remote = join(root, `${name}.git`);
				const checkout = join(root, "two-repos-node-a", name);
				git(root, "init", "-q", "--bare", remote);
				mkdirSync(dirname(checkout), { recursive: true });
				git(root, "clone", "-q", remote, checkout);
				writeFileSync(join(checkout, "README.md"), `${name}\n`);
				writeFileSync(join(checkout, "package-lock.json"), "{}\n");
				git(checkout, "add", "-A");
				git(checkout, "commit", "-q", "-m", "initial");
				git(checkout, "push", "-q", "origin", "HEAD:main");
				return checkout;
			});
			const [alpha, beta] = repos as [string, string];
			const nodeA = startNode(
				"record",
				{
					cwd: alpha,
					file: join(alpha, "notes.txt"),
					content: "alpha from node A\n",
					alsoWrite: { file: join(beta, "notes.txt"), content: "beta from node A\n" },
				},
				nodeEnv("two-repos-node-a"),
			);
			const recorded = await new Promise<NodeOutput>((resolveRecorded, reject) => {
				let buffer = "";
				nodeA.child.stdout?.on("data", (chunk) => {
					buffer += chunk.toString();
					const line = buffer.split("\n").find((candidate) => candidate.startsWith("{"));
					if (line) resolveRecorded(JSON.parse(line) as NodeOutput);
				});
				void nodeA.run.then((run) => reject(new Error(`node A exited early: ${run.stderr}`)));
			});
			nodeA.child.kill("SIGKILL");
			await nodeA.run;
			renameSync(join(root, "two-repos-node-a"), join(root, "two-repos-node-a-offline"));
			const setupMarker = join(root, "two-repos-node-b", "setup-ran");
			mkdirSync(dirname(setupMarker), { recursive: true });

			const resumed = await startNode(
				"resume",
				{
					sessionId: recorded.sessionId,
					launchCwd: join(root, "two-repos-node-b"),
					readPath: join(beta, "notes.txt"),
					setupCommand: `echo ran >> "${setupMarker}"`,
				},
				nodeEnv("two-repos-node-b"),
			).run;

			assert.equal(resumed.code, 0, `${resumed.stderr}\n${JSON.stringify(resumed.output)}`);
			assert.deepEqual(resumed.output?.mappings?.map((mapping) => mapping.from).sort(), [alpha, beta].sort());
			assert.match(resumed.output?.toolResult?.map((part) => part.text ?? "").join("") ?? "", /beta from node A/);
			assert.equal(readFileSync(setupMarker, "utf8"), "ran\nran\n");
		},
		MULTINODE_SCENARIO_TIMEOUT_MS,
	);

	test(
		"scenario 6: a git-less node provisions Git to restore and continue a session; a failed download opens it without its checkout and writes no worktree (#4733)",
		async () => {
			const recordedClone = join(root, "prov-node-a", "home", "repo");
			mkdirSync(dirname(recordedClone), { recursive: true });
			git(root, "clone", "-q", join(root, "remote.git"), recordedClone);
			writeFileSync(join(recordedClone, "README.md"), "edited on the node with Git\n");
			const nodeA = startNode(
				"record",
				{ cwd: recordedClone, file: join(recordedClone, "provisioned.txt"), content: "from the node with Git\n" },
				nodeEnv("prov-node-a"),
			);
			const recorded = await new Promise<NodeOutput>((resolveRecorded, reject) => {
				let buffer = "";
				nodeA.child.stdout?.on("data", (chunk) => {
					buffer += chunk.toString();
					const line = buffer.split("\n").find((candidate) => candidate.startsWith("{"));
					if (line) resolveRecorded(JSON.parse(line) as NodeOutput);
				});
				void nodeA.run.then((run) => reject(new Error(`node A exited early: ${run.stderr}`)));
			});
			nodeA.child.kill("SIGKILL");
			await nodeA.run;
			const offline = join(root, "prov-node-a-gone");
			renameSync(join(root, "prov-node-a"), offline);
			const portable = portableGitArchive();
			const gitless = (extra: NodeJS.ProcessEnv = {}) =>
				nodeEnv("prov-node-d", {
					PATH: `${provisioningTools()}:${dirname(bunExecutable())}`,
					ATOMIC_OFFLINE: "",
					PROVISION_ARCHIVE: portable.archive,
					PROVISION_SHA256: portable.sha256,
					PROVISION_VERSION: portable.version,
					...extra,
				});
			const agentDir = join(root, "prov-node-d", "agent");
			const resumeArgs = {
				sessionId: recorded.sessionId,
				launchCwd: join(root, "prov-node-d", "home"),
				readPath: join(recordedClone, "provisioned.txt"),
			};

			const failed = await startNode("resume", { ...resumeArgs, openOnly: true }, gitless({ PROVISION_FAIL: "1" }))
				.run;
			assert.equal(failed.code, 0, failed.stderr);
			assert.deepEqual(failed.output?.mappings, []);
			assert.equal(failed.output?.notices?.length, 1, JSON.stringify(failed.output?.notices));
			assert.match(failed.output?.notices?.[0]?.message ?? "", /Git is unavailable here \(download-failed\)/);
			assert.equal(existsSync(join(agentDir, "worktree-snapshots", "worktrees")), false);
			assert.equal(existsSync(join(agentDir, "bin", "git", "bin", "git")), false);

			const resumed = await startNode("resume", resumeArgs, gitless()).run;
			assert.equal(resumed.code, 0, `${resumed.stderr}\n${JSON.stringify(resumed.output)}`);
			assert.ok(existsSync(join(agentDir, "bin", "git", "bin", "git")), "Git was provisioned into Atomic home");
			const restoredRoot = resumed.output?.mappings?.[0]?.to ?? "";
			assert.deepEqual(
				resumed.output?.mappings?.map((mapping) => mapping.from),
				[recordedClone],
			);
			assert.ok(restoredRoot.startsWith(join(agentDir, "worktree-snapshots", "worktrees")), restoredRoot);
			assert.deepEqual(treeFiles(restoredRoot), treeFiles(join(offline, "home", "repo")));
			assert.equal(resumed.output?.userMessages, 2);
			assert.match(
				resumed.output?.toolResult?.map((part) => part.text ?? "").join("") ?? "",
				/from the node with Git/,
			);
		},
		MULTINODE_SCENARIO_TIMEOUT_MS,
	);

	test("#4245 crash recovery: a restore SIGKILLed in `git worktree add` leaves nothing at a worktree path, only staging that a later restore sweeps", () => {
		assert.equal(killedAttempt.length, 1, "scenario 1 records what its killed restore left behind");
		assert.ok(basename(killedAttempt[0]!).startsWith(".staging-"), killedAttempt[0]);
	});
});
