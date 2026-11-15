// HTTP proxy in front of sqld that records every Hrana pipeline request (#4768): when it arrived, how long sqld took to
// answer, the baton that ties requests of one stream together, and which statements it carried. `analyze` turns that
// into write transactions: how long each held sqld's write lock, how many requests it made, and how long the lock
// holder itself was silent between an answer and its next request (time the lock is held while the client waits on
// something else).
import { createServer, request as httpRequest } from "node:http";
import { gunzipSync } from "node:zlib";

/** First two words of each statement a pipeline request carries; `store_sql` registers text that later steps name by id. */
function statementsOf(parsed, stored) {
	const words = (text) => String(text ?? "").trim().split(/\s+/).slice(0, 3).join(" ");
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
	/** Requests sent on to sqld and not answered yet: what a stalled store is waiting on. */
	const pending = new Set();
	// sql ids are per stream; a stream's later requests name the text its earlier ones stored. Ids are small integers
	// the client reuses, so the latest text stored under an id is the one a following request names.
	const stored = new Map();
	const server = createServer((incoming, outgoing) => {
		const conn = `${incoming.socket.remoteAddress}:${incoming.socket.remotePort}`;
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
			const waiting = { conn, arrived, inBaton: parsed?.baton ?? null, sql };
			pending.add(waiting);
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
						let fence = false;
						let busy = false;
						try {
							const plain = (response.headers["content-encoding"] === "gzip" ? gunzipSync(text) : text).toString("utf8");
							fence = plain.includes("atomic-pool-fence");
							busy = plain.includes("SQLITE_BUSY") || plain.includes("TRANSACTION_TIMEOUT");
						} catch {}
						pending.delete(waiting);
						records.push({ fence, busy, conn, arrived, answered: performance.now(), inBaton: parsed?.baton ?? null, outBaton: baton ?? null, sql, status: response.statusCode });
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
		server.listen(0, "127.0.0.1", () =>
			resolve({
				port: server.address().port,
				records,
				pending: () => [...pending].map((entry) => ({ ...entry, waitingMs: Math.round(performance.now() - entry.arrived), arrived: undefined })),
				close: () => server.close(),
			}),
		),
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
	const begins = records.filter((record) => record.sql.some((s) => /^BEGIN IMMEDIATE/i.test(s)));
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
		// Service time sqld spent on the holder's own requests after BEGIN: a holder that waits for its turn shows here.
		const holderService = chain.slice(1).map((record) => record.answered - record.arrived);
		const commit = chain.at(-1);
		// BEGIN IMMEDIATE requests from other connections in flight while this holder's COMMIT was being served.
		const waitersAtCommit = begins.filter(
			(other) => other !== start && other.conn !== start.conn && other.arrived <= commit.arrived && other.answered >= commit.answered,
		).length;
		transactions.push({
			conns: new Set(chain.map((record) => record.conn)).size,
			holderServiceMaxMs: Math.max(0, ...holderService),
			commitServiceMs: commit.answered - commit.arrived,
			waitersAtCommit,
			beginWaitMs: start.answered - start.arrived,
			holdMs: ended.answered - lockedAt,
			requests: chain.length,
			statements: chain.reduce((sum, record) => sum + record.sql.length, 0),
			clientSilentMs: gaps.reduce((sum, gap) => sum + gap, 0),
			maxClientGapMs: Math.max(0, ...gaps),
			firstWrite: chain.flatMap((record) => record.sql).find((s) => /^(INSERT|UPDATE|DELETE|CREATE)/i.test(s)) ?? null,
			firstRead: chain.flatMap((record) => record.sql).find((s) => /^SELECT/i.test(s)) ?? null,
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
		holderServiceMaxMs: { p50: pct(field("holderServiceMaxMs"), 50), p99: pct(field("holderServiceMaxMs"), 99), max: pct(field("holderServiceMaxMs"), 100) },
		commitServiceMs: { p50: pct(field("commitServiceMs"), 50), p99: pct(field("commitServiceMs"), 99), max: pct(field("commitServiceMs"), 100) },
		slowCommits: transactions.filter((t) => t.commitServiceMs > 1000).map((t) => ({ commitServiceMs: Math.round(t.commitServiceMs), waitersAtCommit: t.waitersAtCommit, holdMs: Math.round(t.holdMs), requests: t.requests })).slice(0, 40),
		waitersAtCommit: { p50: pct(field("waitersAtCommit"), 50), p99: pct(field("waitersAtCommit"), 99), max: pct(field("waitersAtCommit"), 100) },
		connections: new Set(records.map((r) => r.conn)).size,
		fenceAborts: records.filter((r) => r.fence).length,
		serviceByKind: (() => {
			const kinds = new Map();
			for (const r of records) {
				const k = r.sql.filter((s) => !/^(BEGIN|COMMIT|ROLLBACK|close)/i.test(s)).slice(0, 1).join("") || r.sql.join("|") || "-";
				if (!kinds.has(k)) kinds.set(k, []);
				kinds.get(k).push(r.answered - r.arrived);
			}
			return Object.fromEntries([...kinds].sort((a, b) => b[1].length - a[1].length).slice(0, 25).map(([k, v]) => [k, { n: v.length, p50: pct(v, 50), p99: pct(v, 99) }]));
		})(),
		busyAnswers: records.filter((r) => r.busy).length,
		requestMix: (() => { const mix = {}; for (const r of records) { const k = r.sql.filter((s) => !/^(BEGIN|COMMIT|ROLLBACK|close)/i.test(s)).slice(0, 1).join("") || r.sql.join("|") || "-"; mix[k] = (mix[k] ?? 0) + 1; } return Object.fromEntries(Object.entries(mix).sort((a, b) => b[1] - a[1]).slice(0, 40)); })(),
		transactionsOnOneConnection: transactions.filter((t) => t.conns === 1).length,
		statementMix: (() => { const mix = {}; for (const t of transactions) { const k = t.firstWrite ?? "?"; mix[k] = (mix[k] ?? 0) + 1; } return mix; })(),
		sqldServiceMs: { p50: pct(records.map((r) => r.answered - r.arrived), 50), p99: pct(records.map((r) => r.answered - r.arrived), 99) },
	};
}
