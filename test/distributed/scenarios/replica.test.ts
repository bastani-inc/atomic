/**
 * The streaming replica as a read path: a node pointed at the replica reads the sessions other nodes wrote through
 * PgBouncer to the primary, and cannot write. Runs only when the run started the replica (the default).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { adminSql, Cluster, repoRoot } from "../harness/cluster.js";
import { distributedSkipReason, requireTopology, topology } from "../harness/topology.js";

const SCENARIO = "replica";
const sessionDriver = join(repoRoot, "test/distributed/node/session-node.ts");
const resumeDriver = join(repoRoot, "test/fixtures/multinode-resume-node.ts");
const ENTRIES = 20;

interface SessionOutput {
	readonly sessionId?: string;
	readonly written?: number;
	readonly entryIds?: readonly string[];
	readonly error?: { name?: string; code?: string; message?: string };
}

describe.skipIf(distributedSkipReason !== undefined || topology?.replica === undefined)("the streaming replica", () => {
	let cluster: Cluster;

	beforeAll(async () => {
		cluster = await Cluster.start(SCENARIO, ["a"]);
		// Node R reads from the replica directly, with no PgBouncer in between.
		await cluster.addNode("r", { queries: requireTopology().replica!, wakeUps: requireTopology().replica! });
	});
	afterAll(async () => {
		await cluster?.cleanup();
	});

	test("the replica streams from the primary over TLS", () => {
		const replication = adminSql(
			"SELECT r.state || '|' || s.ssl FROM pg_stat_replication r JOIN pg_stat_ssl s USING (pid) WHERE r.application_name <> ''",
		);
		assert.equal(replication, "streaming|true");
		assert.equal(adminSql("SELECT pg_is_in_recovery()", "replica"), "t");
	});

	test("a node reading from the replica sees every entry another node wrote through PgBouncer", async () => {
		const writerNode = cluster.node("a");
		const dir = join(writerNode.root, "writer");
		mkdirSync(dir, { recursive: true });
		const stopFile = join(dir, "stop");
		const writer = writerNode.run<SessionOutput>(sessionDriver, "writer", {
			cwd: writerNode.home,
			ackFile: join(dir, "acks.jsonl"),
			stopFile,
			intervalMs: 20,
		});
		const { sessionId } = await writer.firstOutput();
		const acks = join(dir, "acks.jsonl");
		await vi.waitFor(
			() => {
				const acked = existsSync(acks)
					? readFileSync(acks, "utf8")
							.split("\n")
							.filter((line) => line.includes('"ack"')).length
					: 0;
				assert.ok(acked >= ENTRIES, `${acked} entries written so far`);
			},
			{ timeout: 60_000, interval: 250 },
		);
		writeFileSync(stopFile, "");
		const written = await writer.run;
		assert.equal(written.code, 0, written.stderr);
		const expected = Array.from(
			{ length: written.output!.written! },
			(_, index) => `w${String(index + 1).padStart(6, "0")}`,
		);

		const reader = cluster.node("r");
		await vi.waitFor(
			async () => {
				const read = await reader.run<SessionOutput>(sessionDriver, "inspect", { sessionId }).run;
				assert.equal(read.code, 0, `${read.stderr}\n${JSON.stringify(read.output)}`);
				assert.deepEqual(read.output?.entryIds, expected);
			},
			{ timeout: 60_000, interval: 1_000 },
		);
	});

	test("a node pointed at the replica cannot write a session there", async () => {
		const reader = cluster.node("r");
		const attempted = await reader.run<SessionOutput>(resumeDriver, "record", {
			cwd: reader.home,
			file: join(reader.home, "never.txt"),
			content: "never\n",
		}).run;
		assert.notEqual(attempted.code, 0);
		assert.match(JSON.stringify(attempted.output), /read-only/);
	});
});
