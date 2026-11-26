import assert from "node:assert/strict";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import {
	KNOWN_SESSION_RETENTION_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { DELIVERED_MESSAGE_TTL_MS } from "../../packages/intercom/retry-policy.js";
import { postgresSkipReason, postgresTestPassword, withPostgresDatabase } from "../helpers/postgres-database.js";

interface Captured {
	readonly text: string;
	readonly values: readonly unknown[];
}

/** Records every statement the adapter's connections send; the adapter's pg is this one. */
function captureStatements() {
	const query = pg.Client.prototype.query;
	const captured: Captured[] = [];
	const recording = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
		const [first, second] = args as unknown[];
		if (typeof first === "string") captured.push({ text: first, values: Array.isArray(second) ? second : [] });
		else if (typeof first === "object" && first !== null && typeof (first as { text?: unknown }).text === "string") {
			const config = first as { text: string; values?: unknown[] };
			captured.push({ text: config.text, values: config.values ?? (Array.isArray(second) ? second : []) });
		}
		return Reflect.apply(query, this, args) as unknown;
	};
	pg.Client.prototype.query = recording as pg.Client["query"];
	restores.push(() => {
		pg.Client.prototype.query = query;
	});
	return {
		take() {
			return captured.splice(0);
		},
	};
}

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

interface PlanNode {
	readonly "Node Type": string;
	readonly "Relation Name"?: string;
	readonly "Index Name"?: string;
	readonly Plans?: readonly PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
	return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

const from = { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

function send(messageId: string, targetIdentity: string) {
	return [
		{ messageId, digest: messageId, targetIdentity },
		{
			targetIdentity,
			originBrokerId: "broker-a",
			digest: messageId,
			frame: { type: "message", from, message: { id: messageId, timestamp: 1, content: { text: messageId } } },
		},
	] as const;
}

/** The statements of the outbox's reads and writes, without the schema's and the catalog's. */
const isOutboxStatement = (text: string) =>
	/\bintercom_outbox\b/.test(text) &&
	/^\s*(SELECT|WITH|UPDATE|DELETE|INSERT)\b/i.test(text) &&
	!/pg_catalog|information_schema/.test(text);

describe.skipIf(postgresSkipReason !== undefined)("Intercom outbox indexes on PostgreSQL", () => {
	test("every claim, send, settlement and prune of the outbox reads it by an index, the undelivered rows by the partial index", async () => {
		await withPostgresDatabase(async ({ open, url }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			// pg takes the password from the connection string when it is given one.
			const address = new URL(url);
			if (postgresTestPassword !== undefined) address.password = postgresTestPassword;
			const explainer = new pg.Client({ connectionString: address.href });
			try {
				await explainer.connect();
				// The schema the adapter keeps Atomic's tables in.
				await explainer.query("SET search_path TO atomic");
				// A swarm's outbox: mostly rows settled within the retention, for many recipients, and a few still queued.
				await explainer.query(`INSERT INTO intercom_outbox(message_id, target_identity, origin_broker_id, digest, frame_json,
						state, queued_at, frame_bytes, settled_at)
					SELECT 'old-' || n, 'target-' || (n % 200), 'broker-x', 'd', '{}',
						CASE WHEN n % 50 = 0 THEN 'queued' WHEN n % 7 = 0 THEN 'failed' ELSE 'delivered' END,
						(extract(epoch from now()) * 1000)::bigint - n, 2,
						CASE WHEN n % 50 = 0 THEN NULL ELSE (extract(epoch from now()) * 1000)::bigint - n END
					FROM generate_series(1, 20000) AS n`);
				await explainer.query("ANALYZE intercom_outbox");

				const statements = captureStatements();
				for (const id of ["m-1", "m-2", "m-3"])
					assert.equal((await state.reserveAndEnqueue!(...send(id, "target-a"))).status, "inserted");
				assert.equal((await state.outbox.enqueue(send("m-4", "target-a")[1])).status, "inserted");
				const claimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-a",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.equal(claimed.status, "claimed");
				if (claimed.status !== "claimed") return;
				const [first, second, third, fourth] = claimed.rows.map(({ claim }) => claim);
				assert.ok(first !== undefined && second !== undefined && third !== undefined && fourth !== undefined);
				// An empty recipient's claim, and one another claimant holds.
				assert.deepEqual(
					await state.outbox.claim({ claimantId: "broker-b", targetIdentity: "target-none", staleAfterMs: 1000 }),
					{ status: "claimed", rows: [] },
				);
				assert.equal(
					(await state.outbox.claim({ claimantId: "broker-c", targetIdentity: "target-a", staleAfterMs: 60_000 }))
						.status,
					"held",
				);
				assert.equal((await state.outbox.renewClaim(first)).status, "renewed");
				assert.equal((await state.outbox.reportSaving!(first)).status, "renewed");
				assert.equal((await state.outbox.markDelivered(first)).status, "delivered");
				assert.equal((await state.outbox.markFailed(second, "refused")).status, "failed");
				assert.equal((await state.outbox.releaseClaim(third)).status, "released");
				assert.equal(await state.outbox.releaseClaimsOf("broker-b"), 1);
				assert.equal((await state.outbox.listUndelivered("target-a")).status, "listed");
				assert.equal((await state.outbox.undeliveredPosition("target-a", "m-4")).status, "positioned");
				await state.outbox.prune(DELIVERED_MESSAGE_TTL_MS, KNOWN_SESSION_RETENTION_MS);

				const outbox = statements.take().filter(({ text }) => isOutboxStatement(text));
				assert.ok(outbox.length >= 12, `${outbox.length} outbox statements`);
				const undeliveredReads: string[] = [];
				const settledReads: string[] = [];
				for (const { text, values } of outbox) {
					const explained = await explainer.query(`EXPLAIN (FORMAT JSON) ${text}`, [...values]);
					const plan = (explained.rows[0] as { "QUERY PLAN": { Plan: PlanNode }[] })["QUERY PLAN"][0]!.Plan;
					const scans = nodesOf(plan).filter((node) => node["Relation Name"] === "intercom_outbox");
					assert.deepEqual(
						scans.filter((node) => node["Node Type"] === "Seq Scan"),
						[],
						`a sequential scan of the outbox for:\n${text}`,
					);
					// A bitmap heap scan names the table, and the bitmap index scans under it their indexes.
					const indexes = new Set(nodesOf(plan).map((node) => node["Index Name"]));
					if (/target_identity = \$\d+ AND state IN \('queued', 'claimed'\)/.test(text)) {
						assert.ok(
							indexes.has("intercom_outbox_undelivered"),
							`not from the undelivered rows' index:\n${text}\n${JSON.stringify(plan, null, 1)}`,
						);
						undeliveredReads.push(text);
					}
					if (/^\s*DELETE FROM intercom_outbox\b/i.test(text)) {
						assert.ok(indexes.has("intercom_outbox_settled"), `not from the settled rows' index:\n${text}`);
						settledReads.push(text);
					}
				}
				// The send's size check, the claim's two statements, the listing and the position count at least.
				assert.ok(
					undeliveredReads.length >= 5,
					`${undeliveredReads.length} reads of a recipient's undelivered rows`,
				);
				assert.equal(settledReads.length, 1);
			} finally {
				await explainer.end();
				await bus.close();
				await state.close();
			}
		});
	}, 120_000);

	test("each retention prune deletes in batches found by the index of the column it ages, and the sweeps for a stopped broker's recipients read by index", async () => {
		await withPostgresDatabase(async ({ open, url }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			const address = new URL(url);
			if (postgresTestPassword !== undefined) address.password = postgresTestPassword;
			const explainer = new pg.Client({ connectionString: address.href });
			try {
				await explainer.connect();
				await explainer.query("SET search_path TO atomic");
				const now = "(extract(epoch from now()) * 1000)::bigint";
				await explainer.query(`INSERT INTO intercom_sent_messages(message_id, digest, target_identity, state, recorded_at)
					SELECT 'm-' || n, 'd', 't', 'accepted', ${now} - n FROM generate_series(1, 20000) AS n`);
				await explainer.query(`INSERT INTO intercom_known_sessions(target_identity, intercom_session_id, group_name, groups_json,
						recorded_at)
					SELECT 't-' || n, 's-' || n, 'g', '[]', ${now} - n FROM generate_series(1, 20000) AS n`);
				await explainer.query(`INSERT INTO intercom_session_bindings(intercom_session_id, return_address, recorded_at)
					SELECT 's-' || n, '', ${now} - n FROM generate_series(1, 20000) AS n`);
				await explainer.query(`INSERT INTO intercom_released_asks(question_id, replier_session_id, asker_session_id, child_name,
						owner_session_id, state, expires_at)
					SELECT 'q-' || n, 'r', 'a', 'c', 'o', 'open', ${now} + n FROM generate_series(1, 20000) AS n`);
				await explainer.query(`INSERT INTO intercom_pending_asks(sender_session_id, target_session_id, message_id)
					SELECT 'a', 't-' || n, 'm-' || n FROM generate_series(1, 20000) AS n`);
				for (const table of [
					"intercom_pending_asks",
					"intercom_sent_messages",
					"intercom_known_sessions",
					"intercom_session_bindings",
					"intercom_released_asks",
				])
					await explainer.query(`ANALYZE ${table}`);

				const statements = captureStatements();
				assert.equal(await state.sentMessages.prune(DELIVERED_MESSAGE_TTL_MS), 0);
				assert.equal(await state.knownSessions.prune(KNOWN_SESSION_RETENTION_MS), 0);
				assert.equal(await state.releasedAsks.prune(DELIVERED_MESSAGE_TTL_MS), 0);
				// Every broker's sweep for lost recipients, at every backup poll, reads only the sessions marked lost.
				assert.deepEqual(await state.knownSessions.listLost(60_000), []);
				// And for the ended asks a stopped broker left.
				assert.deepEqual(await state.pendingAsks.listEnded(60_000), { status: "listed", asks: [] });
				const captured = statements.take();
				const deletes = captured.filter(({ text }) => /^\s*DELETE FROM intercom_/.test(text));
				assert.equal(deletes.length, 4);
				const lost = captured.filter(({ text }) => /\b(lost_at|ended_at) IS NOT NULL\b/.test(text));
				assert.equal(lost.length, 2);
				for (const { text, values } of [...deletes, ...lost]) {
					if (deletes.some((each) => each.text === text)) assert.match(text, /LIMIT \$\d+/, "deleted in batches");
					const explained = await explainer.query(`EXPLAIN (FORMAT JSON) ${text}`, [...values]);
					const plan = (explained.rows[0] as { "QUERY PLAN": { Plan: PlanNode }[] })["QUERY PLAN"][0]!.Plan;
					assert.deepEqual(
						nodesOf(plan).filter((node) => node["Node Type"] === "Seq Scan"),
						[],
						`a sequential scan for:\n${text}`,
					);
				}
			} finally {
				await explainer.end();
				await bus.close();
				await state.close();
			}
		});
	}, 120_000);

	test("the outbox keeps no index keyed by state, and leaves a sixth of each page free for its rows' new versions", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			try {
				const database = await open();
				const indexes = await database.all<{ indexname: string; indexdef: string }>(
					"SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'atomic' AND tablename = 'intercom_outbox' ORDER BY indexname",
				);
				assert.deepEqual(
					indexes.map((row) => row.indexname),
					[
						"intercom_outbox_message_id_key",
						"intercom_outbox_pkey",
						"intercom_outbox_settled",
						"intercom_outbox_undelivered",
					],
				);
				const undelivered = indexes.find((row) => row.indexname === "intercom_outbox_undelivered")!.indexdef;
				assert.match(undelivered, /\(target_identity, sequence\) INCLUDE \(frame_bytes\) WHERE \(state = ANY/);
				const options = await database.get<{ reloptions: string | null }>(
					"SELECT array_to_string(reloptions, ',') AS reloptions FROM pg_class WHERE relname = 'intercom_outbox' AND relnamespace = 'atomic'::regnamespace",
				);
				assert.equal(options?.reloptions, "fillfactor=85");
			} finally {
				await bus.close();
				await state.close();
			}
		});
	}, 120_000);
});
