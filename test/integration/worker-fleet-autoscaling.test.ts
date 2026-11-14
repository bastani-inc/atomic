import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import type { ProvisionedHost, WorkerHostProvisioner } from "../../packages/workflows/src/workers/autoscaler.js";
import {
	startWorkflowFleetController,
	type WorkflowFleetController,
	type WorkflowFleetEvent,
} from "../../packages/workflows/src/workers/fleet-controller.js";
import { type BudgetedProcess, expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { bunExecutable, makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * A fleet controller (#4768) driving real `atomic worker start` processes, each with its own HOME and agent directory,
 * through a fake provisioner that starts them as a cloud would start VMs, on the queue depth of a root that runs with
 * shared placement on a libSQL `file:` journal (`test/fixtures/shared-pool-root.mjs`).
 */
const cli = fileURLToPath(new URL("../../packages/coding-agent/src/cli.ts", import.meta.url));
const rootFixture = fileURLToPath(new URL("../fixtures/shared-pool-root.mjs", import.meta.url));
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const libsqlPackage = fileURLToPath(new URL("../../packages/storage-libsql", import.meta.url));
const PREFIX = "acme_";
/** The root's pool and up to three nodes, each a cold start. */
const BUDGET = poolTestBudgetMs(4);
const MAX_HOSTS = 3;
const CHILDREN = 6;
/** Each child's work: long enough that the queue stays deep while the nodes boot. */
const WORK_MS = 8_000;
/** How long a node holds no child before the controller drains it. */
const IDLE_DRAIN_MS = 3_000;

interface Node {
	readonly id: string;
	readonly process: BudgetedProcess;
	readonly stdout: string[];
	readonly since: number;
}

/** A fake cloud: `scaleTo` starts `atomic worker start` processes, `drain` waits for one to exit and forgets it. */
class FakeCloud implements WorkerHostProvisioner {
	readonly kind = "fake-local";
	readonly nodes = new Map<string, Node>();
	readonly removed: Node[] = [];
	readonly scaleCalls: number[] = [];
	maxRunning = 0;
	private next = 0;
	constructor(
		private readonly directory: string,
		private readonly url: string,
		private readonly tokenFile: string,
		private readonly deadline: number,
	) {}

	async list(): Promise<readonly ProvisionedHost[]> {
		return [...this.nodes.values()].map((node) => ({
			id: node.id,
			state: node.process.process.exitCode === null ? "running" : "stopped",
			since: node.since,
		}));
	}

	async scaleTo(target: number): Promise<void> {
		this.scaleCalls.push(target);
		while (this.nodes.size < target) this.start(`vm-${++this.next}`);
		this.maxRunning = Math.max(this.maxRunning, this.nodes.size);
	}

	async drain(id: string): Promise<void> {
		const node = this.nodes.get(id);
		if (node === undefined) return;
		await node.process.process.exited;
		this.nodes.delete(id);
		this.removed.push(node);
	}

	private start(id: string): void {
		const home = join(this.directory, id);
		const agentDir = join(home, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [libsqlPackage] }));
		const child = spawnWithinBudget(
			[
				bunExecutable(),
				cli,
				"worker",
				"start",
				...["--db", this.url, "--token-file", this.tokenFile, "--prefix", PREFIX, "--slots", "1", "--host-id", id],
			],
			{
				cwd: this.directory,
				stdout: "pipe",
				detached: true,
				env: {
					...process.env,
					HOME: home,
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ATOMIC_PROFILE: "",
					ATOMIC_STORAGE: "",
					ATOMIC_TEAM_URL: "",
					SHARED_POOL_HOST: id,
					ATOMIC_WORKER_PROVIDER_ID: id,
				},
			},
			this.deadline,
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
		this.nodes.set(id, { id, process: child, stdout, since: Date.now() });
	}
}

/** Kills a process group still running, by its explicit PID. */
function killGroup(child: BudgetedProcess | undefined): void {
	if (child?.process.exitCode === null && child.process.pid !== undefined) {
		try {
			process.kill(-child.process.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

interface Outcome {
	readonly status: string;
	readonly children: { readonly status: string; readonly firstHost: string; readonly finalHost: string }[];
}

test.skipIf(process.platform === "win32")(
	"a fleet controller scales real worker hosts 0 → N → 0 on a root's queue depth, never above maxHosts and never draining a busy host (#4768)",
	async () => {
		const directory = makeTempDirectory("worker-fleet-");
		const deadline = Date.now() + BUDGET.waitMs;
		const tokenFile = join(directory, "token");
		writeFileSync(tokenFile, `token-${randomUUID()}\n`, { mode: 0o600 });
		const url = pathToFileURL(join(directory, "shared.db")).href;
		const journal = { adapter: libsql, options: { url }, prefix: PREFIX };
		const cloud = new FakeCloud(directory, url, tokenFile, deadline);
		const events: WorkflowFleetEvent[] = [];
		let controller: WorkflowFleetController | undefined;
		let root: BudgetedProcess | undefined;
		const until = async (what: string, check: () => boolean) => {
			while (!check()) {
				if (root !== undefined && root.process.exitCode !== null && root.process.exitCode !== 0)
					assert.fail(
						`the root ended (${root.process.exitCode}) while waiting for ${what}:\n${await root.stderr}`,
					);
				if (Date.now() >= deadline)
					assert.fail(
						`timed out waiting for ${what}: ${JSON.stringify(events)}\n${[...cloud.nodes.values(), ...cloud.removed].map((node) => `${node.id}: ${node.stdout.join(" | ")}`).join("\n")}`,
					);
				await sleep(100);
			}
		};
		try {
			controller = await startWorkflowFleetController({
				journal,
				agentDir: join(directory, "controller", "agent"),
				provisioner: cloud,
				minHosts: 0,
				maxHosts: MAX_HOSTS,
				workersPerHost: 1,
				scaleUpQueueDepth: 0,
				scaleUpDelayMs: 0,
				idleDrainMs: IDLE_DRAIN_MS,
				bootTimeoutMs: BUDGET.waitMs,
				tickMs: 500,
				onEvent: (event) => events.push(event),
			});
			await until("the controller to lead", () => controller!.status().role === "active");
			assert.equal(cloud.nodes.size, 0, "no queue, no host");
			root = spawnWithinBudget(
				[process.execPath, rootFixture, "start", directory, String(CHILDREN), "1", "distributed"],
				{
					cwd: directory,
					stdout: "ignore",
					detached: true,
					env: {
						...process.env,
						SHARED_POOL_HOST: "root",
						SHARED_POOL_AGENT_DIR: join(directory, "root", "agent"),
						SHARED_POOL_ADAPTER: libsql,
						SHARED_POOL_URL: url,
						SHARED_POOL_PREFIX: PREFIX,
						SHARED_POOL_ROOT: randomUUID(),
						SHARED_POOL_WORK_MS: String(WORK_MS),
					},
				},
				deadline,
			);
			await until("the fleet to scale up to maxHosts", () => cloud.maxRunning === MAX_HOSTS);
			await until("a node to claim a child", () =>
				[...cloud.nodes.values()].some((node) => node.stdout.some((line) => line.startsWith("claimed "))),
			);
			await expectExitedCleanly(root);
			const outcome = await readJson<Outcome>(join(directory, "outcome-start.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.equal(outcome.children.length, CHILDREN);
			for (const child of outcome.children) {
				assert.equal(child.status, "completed", JSON.stringify(child));
				// A drain never took a child off the host that ran it.
				assert.equal(child.finalHost, child.firstHost, JSON.stringify(outcome));
			}
			assert.ok(
				outcome.children.some((child) => child.firstHost.startsWith("vm-")),
				`the fleet's nodes ran children: ${JSON.stringify(outcome)}`,
			);
			await until("the idle fleet to drain to zero", () => cloud.nodes.size === 0);
			assert.ok(cloud.maxRunning <= MAX_HOSTS);
			assert.ok(Math.max(...cloud.scaleCalls) <= MAX_HOSTS, `scaleTo calls: ${cloud.scaleCalls.join(", ")}`);
			for (const node of cloud.removed) {
				const lines = node.stdout.map((line) => line.split(" ")[0]);
				assert.equal(node.process.process.exitCode, 0, `${node.id}: ${node.stdout.join(" | ")}`);
				assert.equal(lines.at(-1), "drained", `${node.id}: ${node.stdout.join(" | ")}`);
				// Every child a node took it released before it drained: the controller asked only an idle node.
				const asked = lines.indexOf("drain-requested");
				assert.ok(asked >= 0, `${node.id}: ${node.stdout.join(" | ")}`);
				assert.equal(
					lines.slice(0, asked).filter((kind) => kind === "claimed").length,
					lines.slice(0, asked).filter((kind) => kind === "released").length,
					`${node.id} held a child when asked to drain: ${node.stdout.join(" | ")}`,
				);
			}
			const fleetJournal = await resolveRunJournal({ journal, agentDir: join(directory, "reader", "agent") });
			try {
				const recorded = await (await SqlFleetStore.open(fleetJournal)).recent(100);
				const kinds = new Set(recorded.map((event) => event.kind));
				for (const kind of ["active", "scale-up", "drain", "remove"])
					assert.ok(kinds.has(kind), `${kind} in ${JSON.stringify(recorded)}`);
			} finally {
				await fleetJournal.close();
			}
		} finally {
			await controller?.stop();
			for (const node of [...cloud.nodes.values(), ...cloud.removed]) killGroup(node.process);
			killGroup(root);
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
