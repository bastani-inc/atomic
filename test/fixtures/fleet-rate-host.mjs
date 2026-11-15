import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// One host of a fleet with shared model rate limits (#4768): it opens the shared journal at JOURNAL_PATH, meters its
// model calls to the fake provider "fake" through the journal's bucket and shares its 429 cooldowns there, as a pool
// coordinator and its workers do. It calls the provider (a fake fetch) one call at a time for DURATION_MS, every
// PACE_MS, and writes what happened as JSON to OUT. FAIL_AT is the index of the call the provider answers 429 with a
// Retry-After of RETRY_AFTER_S seconds; READY is a file it writes once its first call went through.
const env = process.env;
const jiti = createJiti(import.meta.url, { fsCache: true });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { openNodeSqliteDatabase } = await jiti.import("@bastani/atomic/storage");
const limits = await load("../../packages/coding-agent/src/core/provider-rate-limits.ts");
const { admitProviderStream } = await load("../../packages/coding-agent/src/core/provider-request-admission.ts");
const { SqlRunJournal } = await load("../../packages/workflows/src/durable/journal/sql-run-journal.ts");
const { SqlRateBuckets } = await load("../../packages/workflows/src/durable/journal/sql-rate-buckets.ts");
const { FleetRateLimiter, fleetRateGate } = await load("../../packages/workflows/src/workers/fleet-rate-limits.ts");

const database = await openNodeSqliteDatabase(env.JOURNAL_PATH);
const journal = await SqlRunJournal.open(database);
const store = await SqlRateBuckets.open(journal);
const limiter = new FleetRateLimiter({
	store,
	limits: { fake: { requestsPerMinute: Number(env.RPM), burst: Number(env.BURST), prefetch: 1 } },
	shareCooldowns: true,
	slots: 1,
	applyCooldowns: (observations) => {
		for (const observation of observations) limits.applyProviderRateLimitObservation(observation);
	},
	pollMs: 100,
	retryStoreMs: Number(env.RETRY_STORE_MS ?? 5_000),
});
limits.observeProviderRateLimits((observation) => limiter.shareCooldown(observation));
limiter.start();
limits.setProviderRequestGate(fleetRateGate(limiter.rateScopes, (provider, model) => limiter.acquire(provider, model)));

const failAt = Number(env.FAIL_AT ?? -1);
const calls = [];
let index = 0;
const fakeFetch = async () => {
	const at = Date.now();
	const status = index++ === failAt ? 429 : 200;
	calls.push({ at, status });
	return status === 429
		? new Response("rate limited", { status, headers: { "retry-after": String(env.RETRY_AFTER_S) } })
		: new Response("{}", { status });
};
const model = { provider: "fake", id: "m", api: "anthropic-messages" };
const { options } = await admitProviderStream(model, { fetch: fakeFetch }, false);
const modes = [];
const waits = [];
const end = Date.now() + Number(env.DURATION_MS);
while (Date.now() < end) {
	const started = Date.now();
	await options.fetch("http://fake.invalid/");
	waits.push(calls.at(-1).at - started);
	modes.push(limiter.mode);
	if (calls.length === 1 && env.READY) writeFileSync(env.READY, "ready");
	const pause = Number(env.PACE_MS) - (Date.now() - started);
	if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
}
await limiter.close();
writeFileSync(env.OUT, JSON.stringify({ calls, modes, waits }));
await journal.close();
await database.close();
process.exit(0);
