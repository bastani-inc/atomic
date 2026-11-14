// One worker host of the hot-path benchmark (#4793): `HP_SLOTS` workers claim pooled children of one root, commit
// `HP_STEPS` checkpoints each, heartbeat every `HP_HEARTBEAT_MS`, and complete. Each host is its own process with its
// own connections, as a machine is. Writes `{ latencies, commits }` to `HP_RESULT_FILE` on exit.
//   HP_BACKEND sqlite|pg|pg-serial, HP_URL, HP_PREFIX, HP_HOST, HP_SLOTS, HP_STEPS, HP_PAYLOAD, HP_PG_MODULE
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { hotPath, openPostgres, openSqlite, StaleError } from "./hotpath.mjs";

const env = process.env;
const backend = env.HP_BACKEND;
const slots = Number(env.HP_SLOTS ?? 4);
const steps = Number(env.HP_STEPS ?? 20);
const pad = "x".repeat(Number(env.HP_PAYLOAD ?? 256));
const host = env.HP_HOST;
const LEASE_MS = 30_000;
const HEARTBEAT_MS = Number(env.HP_HEARTBEAT_MS ?? 7_500);
const POLL_MS = 250;
const lease = { runId: "root", holderId: "root-holder", epoch: 1 };
// One facade per host for SQLite, as the host coordinator's one queue; a pool of slots + 1 connections for Postgres.
const db = backend === "sqlite"
	? await openSqlite({ url: env.HP_URL })
	: openPostgres({ url: env.HP_URL, serial: backend === "pg-serial", max: slots + 1, pgModule: env.HP_PG_MODULE });
const pool = hotPath(db, env.HP_PREFIX);
const latencies = [];
const commits = [];
const errors = {};
let busy = 0;
let done = false;
const count = (error) => {
	const key = error instanceof StaleError ? error.message : String(error?.code ?? error?.message ?? error).slice(0, 80);
	errors[key] = (errors[key] ?? 0) + 1;
};

async function retry(action) {
	// Bounded jittered retry of a transient failure, as the facade's: 20 ms base, doubling, capped at 1 s.
	for (let attempt = 0; ; attempt++) {
		try {
			return await action();
		} catch (error) {
			if (error instanceof StaleError || attempt >= 8) throw error;
			count(error);
			await sleep(Math.random() * Math.min(1000, 20 * 2 ** attempt));
		}
	}
}

async function worker(slot) {
	const name = `${host}-w${slot}`;
	while (!done) {
		const candidates = await pool.candidates(lease, slots).catch((error) => (count(error), []));
		if (candidates.length === 0) {
			const progress = await pool.progress(lease).catch(() => undefined);
			if (progress && !progress.ready && !progress.leased) return;
			await sleep(POLL_MS);
			continue;
		}
		const candidate = candidates[Math.floor(Math.random() * candidates.length)];
		const work = await retry(() => pool.claim(lease, name, candidate, LEASE_MS)).catch((error) => (count(error), undefined));
		if (!work) continue;
		busy++;
		const token = { id: work.id, generation: Number(work.generation), worker: name };
		const beat = setInterval(() => void retry(() => pool.heartbeat(lease, token, LEASE_MS)).catch(count), HEARTBEAT_MS);
		try {
			for (let step = 0; step < steps; step++) {
				const began = performance.now();
				await retry(() => pool.commit(lease, token, `op-${work.id}-${step}`, `${work.id}/step-${step}`, JSON.stringify({ step, pad })));
				const ended = performance.now();
				latencies.push(Math.round((ended - began) * 100) / 100);
				commits.push(Math.round(performance.timeOrigin + ended));
			}
			await retry(() => pool.complete(lease, token, JSON.stringify({ runId: work.id })));
		} catch (error) {
			count(error);
		} finally {
			clearInterval(beat);
			busy--;
		}
	}
}

const report = setInterval(() => void pool.reportHost(host, slots, busy).catch(count), 5_000);
await pool.reportHost(host, slots, 0).catch(count);
writeFileSync(env.HP_READY_FILE, "ready");
await Promise.all(Array.from({ length: slots }, (_, slot) => worker(slot)));
done = true;
clearInterval(report);
writeFileSync(env.HP_RESULT_FILE, JSON.stringify({ host, latencies, commits, errors }));
await db.close();
process.exit(0);
