// HTTP proxy in front of sqld that records every Hrana pipeline request (#4768): when it arrived, how long sqld took to
// answer, the baton that ties requests of one stream together, and which statements it carried. `analyze` turns that
// into write transactions: how long each held sqld's write lock, how many requests it made, and how long the lock
// holder itself was silent between an answer and its next request (time the lock is held while the client waits on
// something else).
import { createServer, request as httpRequest } from "node:http";
import { gunzipSync } from "node:zlib";

/** First two words of each statement a pipeline request carries; `store_sql` registers text that later steps name by id. */
function statementsOf(parsed, stored) {
	const words = (text) => String(text ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
	const out = [];
	for (const request of parsed?.requests ?? []) {
		if (request.type === "store_sql") stored.set(request.sql_id, request.sql);
		else if (request.type === "execute") out.push(words(request.stmt?.sql ?? stored.get(request.stmt?.sql_id)));
		else if (request.type === "batch") for (const step of request.batch?.steps ?? []) out.push(words(step.stmt?.sql ?? stored.get(step.stmt?.sql_id)));
		else if (request.type !== "close_sql") out.push(request.type);
	}
	return out;
}

export function startTraceProxy(targetPort) {
	const records = [];
	// sql ids are per stream; a stream's later requests name the text its earlier ones stored. Ids are small integers
	// the client reuses, so the latest text stored under an id is the one a following request names.
	const stored = new Map();
	const server = createServer((incoming, outgoing) => {
		const chunks = [];
		incoming.on("data", (chunk) => chunks.push(chunk));
		incoming.on("end", () => {
			const body = Buffer.concat(chunks);
			const arrived = performance.now();
			let parsed;
			try {
				parsed = JSON.parse(body.toString("utf8"));
			} catch {}
			const sql = statementsOf(parsed, stored);
			const upstream = httpRequest(
				{ host: "127.0.0.1", port: targetPort, method: incoming.method, path: incoming.url, headers: incoming.headers },
				(response) => {
					const answer = [];
					response.on("data", (chunk) => answer.push(chunk));
					response.on("end", () => {
						const text = Buffer.concat(answer);
						let baton;
						try {
							const plain = response.headers["content-encoding"] === "gzip" ? gunzipSync(text) : text;
							baton = JSON.parse(plain.toString("utf8")).baton ?? null;
						} catch {}
						records.push({ arrived, answered: performance.now(), inBaton: parsed?.baton ?? null, outBaton: baton ?? null, sql, status: response.statusCode });
						outgoing.writeHead(response.statusCode, response.headers);
						outgoing.end(text);
					});
				},
			);
			upstream.on("error", () => outgoing.destroy());
			upstream.end(body);
		});
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, records, close: () => server.close() })),
	);
}

const pct = (values, p) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
};

/** Write transactions reconstructed from the trace: BEGIN IMMEDIATE … COMMIT/ROLLBACK chained by baton. */
export function analyze(records) {
	const byBaton = new Map();
	for (const record of records) if (record.inBaton) byBaton.set(record.inBaton, record);
	const transactions = [];
	for (const start of records) {
		if (!start.sql.some((s) => /^BEGIN IMMEDIATE/i.test(s))) continue;
		const chain = [start];
		let current = start;
		while (current.outBaton && byBaton.has(current.outBaton) && !current.sql.some((s) => /^(COMMIT|ROLLBACK)/i.test(s))) {
			current = byBaton.get(current.outBaton);
			chain.push(current);
		}
		const lockedAt = start.answered; // BEGIN IMMEDIATE answered: the lock is held from here.
		const ended = chain.at(-1);
		const gaps = chain.slice(1).map((record, index) => record.arrived - chain[index].answered);
		transactions.push({
			beginWaitMs: start.answered - start.arrived,
			holdMs: ended.answered - lockedAt,
			requests: chain.length,
			statements: chain.reduce((sum, record) => sum + record.sql.length, 0),
			clientSilentMs: gaps.reduce((sum, gap) => sum + gap, 0),
			maxClientGapMs: Math.max(0, ...gaps),
			committed: ended.sql.some((s) => /^COMMIT/i.test(s)) && ended.status === 200,
		});
	}
	const field = (name) => transactions.map((transaction) => transaction[name]);
	return {
		requests: records.length,
		writeTransactions: transactions.length,
		uncommitted: transactions.filter((transaction) => !transaction.committed).length,
		beginWaitMs: { p50: pct(field("beginWaitMs"), 50), p99: pct(field("beginWaitMs"), 99), max: pct(field("beginWaitMs"), 100) },
		holdMs: { p50: pct(field("holdMs"), 50), p99: pct(field("holdMs"), 99), max: pct(field("holdMs"), 100) },
		requestsPerTransaction: { p50: pct(field("requests"), 50), p99: pct(field("requests"), 99), max: pct(field("requests"), 100) },
		clientSilentShareOfHold: (() => {
			const hold = field("holdMs").reduce((a, b) => a + b, 0);
			return hold === 0 ? null : Math.round((field("clientSilentMs").reduce((a, b) => a + b, 0) / hold) * 1000) / 1000;
		})(),
		maxClientGapMs: { p50: pct(field("maxClientGapMs"), 50), p99: pct(field("maxClientGapMs"), 99), max: pct(field("maxClientGapMs"), 100) },
		sqldServiceMs: { p50: pct(records.map((r) => r.answered - r.arrived), 50), p99: pct(records.map((r) => r.answered - r.arrived), 99) },
	};
}
