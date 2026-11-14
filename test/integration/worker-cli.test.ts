import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { type BudgetedProcess, expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { startFakeLibsqlServer } from "../helpers/fake-libsql-server.js";
import { startOutageProxy } from "../helpers/outage-proxy.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { bunExecutable, makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * `atomic worker start` (#4768) as users run it: the CLI from source, one process per node with its own agent
 * directory, joined to one libSQL `file:` database by `--db` and `--token-file`, serving a root that runs with shared
 * placement (`test/fixtures/shared-pool-root.mjs`).
 */
const cli = fileURLToPath(new URL("../../packages/coding-agent/src/cli.ts", import.meta.url));
const rootFixture = fileURLToPath(new URL("../fixtures/shared-pool-root.mjs", import.meta.url));
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const libsqlPackage = fileURLToPath(new URL("../../packages/storage-libsql", import.meta.url));
const PREFIX = "acme_";
const TOKEN = `worker-cli-token-${randomUUID()}`;
/** The root's pool and one CLI node. */
const SERVE_BUDGET = poolTestBudgetMs(2);
/** The root's pool and two CLI nodes. */
const TAKEOVER_BUDGET = poolTestBudgetMs(3);
/** A short work lease, so a surviving node takes a killed node's child over within the test. */
const TAKEOVER_LEASE_MS = 4_000;
/** How long each child of the outage scenario works: the outage, its retries and the recovery fit inside it. */
const OUTAGE_WORK_MS = 30_000;

interface Scenario {
	readonly directory: string;
	readonly url: string;
	readonly root: string;
	readonly tokenFile: string;
	readonly deadline: number;
}

function scenario(label: string, budgetMs: number): Scenario {
	const directory = makeTempDirectory(`${label}-`);
	const tokenFile = join(directory, "token");
	writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
	return {
		directory,
		url: pathToFileURL(join(directory, "shared.db")).href,
		root: randomUUID(),
		tokenFile,
		deadline: Date.now() + budgetMs,
	};
}

/** A node: `atomic worker start` with its own agent directory, which has the libSQL adapter installed. */
interface Node {
	readonly name: string;
	readonly process: BudgetedProcess;
	readonly stdout: string[];
}

function startNode(
	s: Scenario,
	name: string,
	slots: number,
	extra: Record<string, string> = {},
	url: string = s.url,
): Node {
	const agentDir = join(s.directory, name, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [libsqlPackage] }));
	const args = [
		...["--db", url, "--token-file", s.tokenFile, "--prefix", PREFIX],
		...["--slots", String(slots), "--host-id", name, "--label", `node=${name}`],
	];
	const child = spawnWithinBudget(
		[bunExecutable(), cli, "worker", "start", ...args],
		{
			cwd: s.directory,
			stdout: "pipe",
			detached: true,
			env: {
				...process.env,
				HOME: join(s.directory, name),
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_PROFILE: "",
				ATOMIC_STORAGE: "",
				ATOMIC_TEAM_URL: "",
				SHARED_POOL_HOST: name,
				...extra,
			},
		},
		s.deadline,
	);
	const stdout: string[] = [];
	void (async () => {
		let pending = "";
		const decoder = new TextDecoder();
		for await (const chunk of child.process.stdout!) {
			const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
			pending = lines.pop()!;
			stdout.push(...lines.filter(Boolean));
		}
	})();
	return { name, process: child, stdout };
}

function startRoot(
	s: Scenario,
	children: number,
	workMs: number,
	env: Record<string, string> = {},
	url: string = s.url,
): BudgetedProcess {
	return spawnWithinBudget(
		[process.execPath, rootFixture, "start", s.directory, String(children), "1", "distributed"],
		{
			cwd: s.directory,
			stdout: "ignore",
			detached: true,
			env: {
				...process.env,
				SHARED_POOL_HOST: "A",
				SHARED_POOL_AGENT_DIR: join(s.directory, "A", "agent"),
				SHARED_POOL_ADAPTER: libsql,
				SHARED_POOL_URL: url,
				SHARED_POOL_PREFIX: PREFIX,
				SHARED_POOL_ROOT: s.root,
				SHARED_POOL_WORK_MS: String(workMs),
				...env,
			},
		},
		s.deadline,
	);
}

async function until(what: string, s: Scenario, check: () => boolean, watched: readonly BudgetedProcess[]) {
	while (!check()) {
		for (const watchedProcess of watched)
			if (watchedProcess.process.exitCode !== null)
				assert.fail(
					`a process ended (${watchedProcess.process.exitCode}) while waiting for ${what}:\n${await watchedProcess.stderr}`,
				);
		if (Date.now() >= s.deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

function claimed(node: Node): string[] {
	return node.stdout.filter((line) => line.startsWith("claimed ")).map((line) => /child=(\S+)/.exec(line)![1]!);
}

interface Outcome {
	readonly status: string;
	readonly children: { readonly status: string; readonly firstHost: string; readonly finalHost: string }[];
}

/** Every file under `directory`, the token file aside, as text: logs, settings, pool state. */
function filesHolding(directory: string, text: string): string[] {
	const found: string[] = [];
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && statSync(full).size < 64 * 1024 * 1024 && readFileSync(full).includes(text))
				found.push(full);
		}
	};
	walk(directory);
	return found;
}

function killGroup(child: BudgetedProcess | undefined): void {
	if (child?.process.exitCode === null && child.process.pid !== undefined) {
		try {
			process.kill(-child.process.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

test.skipIf(process.platform === "win32")(
	"atomic worker start joins a libSQL file journal, serves a shared root's children, and SIGTERM drains a running child to completion with exit 0 (#4768)",
	async () => {
		const s = scenario("worker-cli-serve", SERVE_BUDGET.waitMs);
		let node: Node | undefined;
		let root: BudgetedProcess | undefined;
		try {
			node = startNode(s, "B", 2);
			await until("node B to be ready", s, () => node!.stdout.some((line) => line.startsWith("ready ")), [
				node.process,
			]);
			assert.match(
				node.stdout[0]!,
				/^ready host=B slots=2 journal=file:\/\/\S+shared\.db prefix=acme_ labels=node=B$/,
			);
			// Each child works for 8 s; the root's one worker takes one, node B the others.
			root = startRoot(s, 3, 8_000);
			await until("node B to run a child", s, () => claimed(node!).length > 0, [node.process, root]);
			// SIGTERM mid-run: node B takes nothing more, and exits 0 once the children it holds finished there.
			node.process.process.kill("SIGTERM");
			const stderr = await expectExitedCleanly(node.process);
			await expectExitedCleanly(root);
			const outcome = await readJson<Outcome>(join(s.directory, "outcome-start.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			const onB = outcome.children.filter((child) => child.firstHost === "B");
			assert.ok(onB.length > 0, `node B ran a child: ${JSON.stringify(outcome)}`);
			for (const child of onB) {
				assert.equal(child.status, "completed");
				assert.equal(child.finalHost, "B", "a child node B held when it was told to drain finished there");
			}
			const events = node.stdout.map((line) => line.split(" ")[0]);
			assert.equal(events.at(-1), "drained", node.stdout.join("\n"));
			assert.ok(events.includes("draining") && events.includes("released"), node.stdout.join("\n"));
			// The token is in no output and no file the node or its workers wrote.
			for (const text of [...node.stdout, stderr]) assert.ok(!text.includes(TOKEN), text);
			assert.deepEqual(filesHolding(join(s.directory, "B"), TOKEN), []);
		} finally {
			killGroup(node?.process);
			killGroup(root);
			removeTempDirectory(s.directory);
		}
	},
	SERVE_BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a second node joins and takes work, and when one node is killed with SIGKILL the other takes over its leased child (#4768)",
	async () => {
		const s = scenario("worker-cli-takeover", TAKEOVER_BUDGET.waitMs);
		let nodeB: Node | undefined;
		let nodeC: Node | undefined;
		let root: BudgetedProcess | undefined;
		try {
			nodeB = startNode(s, "B", 1);
			await until("node B to be ready", s, () => nodeB!.stdout.length > 0, [nodeB.process]);
			// Three children of 20 s each: the root's one worker and node B take one each, the third waits.
			root = startRoot(s, 3, 20_000, { SHARED_POOL_LEASE_MS: String(TAKEOVER_LEASE_MS) });
			await until("node B to run a child", s, () => claimed(nodeB!).length > 0, [nodeB.process, root]);
			// Node C joins later with two slots, takes the waiting child, and keeps one slot free.
			nodeC = startNode(s, "C", 2);
			await until("node C to take the waiting child", s, () => claimed(nodeC!).length > 0, [
				nodeB.process,
				nodeC.process,
				root,
			]);
			const [held] = claimed(nodeB);
			// Node B dies with the child it holds: its host process and its workers, at once.
			killGroup(nodeB.process);
			await nodeB.process.process.exited;
			await until("node C to take node B's child over", s, () => claimed(nodeC!).includes(held!), [
				nodeC.process,
				root,
			]);
			await expectExitedCleanly(root);
			const outcome = await readJson<Outcome>(join(s.directory, "outcome-start.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.equal(outcome.children.length, 3);
			for (const child of outcome.children) assert.equal(child.status, "completed", JSON.stringify(child));
			assert.ok(
				outcome.children.some((child) => child.firstHost === "B" && child.finalHost === "C"),
				`a child node B started finished on node C: ${JSON.stringify(outcome)}`,
			);
			nodeC.process.process.kill("SIGTERM");
			await expectExitedCleanly(nodeC.process);
			assert.equal(nodeC.stdout.at(-1)?.split(" ")[0], "drained");
		} finally {
			killGroup(nodeB?.process);
			killGroup(nodeC?.process);
			killGroup(root);
			removeTempDirectory(s.directory);
		}
	},
	TAKEOVER_BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a node that loses the database reports degraded, retries with backoff, recovers, and its running child still completes there (#4768)",
	async () => {
		const s = scenario("worker-cli-outage", SERVE_BUDGET.waitMs);
		const database = await startFakeLibsqlServer({ streamTtlMs: 60_000 });
		const proxy = await startOutageProxy(new URL(database.url));
		let node: Node | undefined;
		let root: BudgetedProcess | undefined;
		try {
			// Only node B reaches the database through the proxy; the root reaches it directly.
			node = startNode(s, "B", 2, { SHARED_POOL_WORK_MARKERS: s.directory }, proxy.url);
			await until("node B to be ready", s, () => node!.stdout.length > 0, [node.process]);
			root = startRoot(s, 2, OUTAGE_WORK_MS, {}, database.url);
			// The outage starts once node B's child is in its long step, between checkpoints: a checkpoint written while the
			// database is unreachable replays its child, which this test does not cover.
			await until(
				"node B's child to start its long step",
				s,
				() => readdirSync(s.directory).some((name) => name.startsWith("working-B-")),
				[node.process, root],
			);
			proxy.cut();
			await until(
				"node B to report two failed polls",
				s,
				() => node!.stdout.filter((line) => line.startsWith("degraded ")).length >= 2,
				[node.process, root],
			);
			proxy.restore();
			await until("node B to recover", s, () => node!.stdout.some((line) => line.startsWith("recovered ")), [
				node.process,
				root,
			]);
			await expectExitedCleanly(root);
			const outcome = await readJson<Outcome>(join(s.directory, "outcome-start.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			const onB = outcome.children.filter((child) => child.firstHost === "B");
			assert.ok(onB.length > 0, JSON.stringify(outcome));
			for (const child of onB)
				assert.equal(
					child.finalHost,
					"B",
					`the outage did not take the child off node B:\n${node.stdout.join("\n")}`,
				);
			const degraded = node.stdout.filter((line) => line.startsWith("degraded "));
			const waits = degraded.map((line) => Number(/retry_in_ms=(\d+)/.exec(line)![1]));
			assert.ok(waits[1]! > waits[0]! / 2 && waits[1]! >= 1_000, `the waits back off: ${degraded.join("\n")}`);
			node.process.process.kill("SIGTERM");
			const stderr = await expectExitedCleanly(node.process);
			for (const text of [...node.stdout, stderr]) assert.ok(!text.includes(TOKEN), text);
		} finally {
			killGroup(node?.process);
			killGroup(root);
			await proxy.close();
			await database.close();
			removeTempDirectory(s.directory);
		}
	},
	SERVE_BUDGET.timeoutMs,
);
