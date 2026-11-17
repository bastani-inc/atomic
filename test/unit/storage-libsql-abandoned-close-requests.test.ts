import assert from "node:assert/strict";
import type { Config } from "@libsql/client";
import { test, vi } from "vitest";
import { useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * The requests the libSQL adapter sends while it keeps the close of a stream an outage cut (#5114), through the fetch
 * it hands the libSQL client: every request of the client goes through it, with the caller's abort signal.
 */

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The fetch the adapter handed the libSQL client it created last. */
const handed: { fetch?: Fetch } = {};
vi.mock("@libsql/client", async (importOriginal) => {
	const original = await importOriginal<typeof import("@libsql/client")>();
	return {
		...original,
		createClient(config: Config) {
			handed.fetch = config.fetch as Fetch;
			return original.createClient(config);
		},
	};
});

useTemporaryAgentDir();
const { server, open } = useFakeLibsqlServers();

/** The adapter's wait before its first resend of a kept close; each unanswered resend of its timer doubles it. */
const CLOSE_FIRST_WAIT_MS = 250;
/** How soon a waiting request settles once its caller aborts it. */
const ABORT_BOUND_MS = 1_000;

/** A pipeline request body that only closes a stream, in JSON. */
const CLOSE_ONLY = /^\{"baton":"([^"]*)","requests":\[\{"type":"close"\}\]\}$/;

function pipeline(url: string, body: object): Request {
	return new Request(`${url}/v2/pipeline`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const closeOf = (url: string, baton: string) => pipeline(url, { baton, requests: [{ type: "close" }] });
const statementOf = (url: string, sql: string) =>
	pipeline(url, { baton: null, requests: [{ type: "execute", stmt: { sql } }, { type: "close" }] });

interface SentClose {
	readonly baton: string;
	readonly at: number;
	readonly signal: AbortSignal | null;
	/** Settles a held close: answered with `response`, or unanswered with `error`. */
	settle?: (outcome: { response: Response } | { error: Error }) => void;
}

/**
 * A database on a fake server, the fetch its client sends through, and a server stand-in for requests that only close
 * a stream: `fail` refuses them as an unreachable server does, `hold` takes them and leaves them unanswered until a test
 * settles them, `pass` lets them reach the fake server.
 */
async function client() {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const clientFetch = handed.fetch!;
	const real = globalThis.fetch;
	const sent: SentClose[] = [];
	const control = { mode: "fail" as "fail" | "hold" | "pass" };
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const baton = CLOSE_ONLY.exec(await request.clone().text())?.[1];
		if (baton === undefined) return real(request);
		const close: SentClose = { baton, at: performance.now(), signal: init?.signal ?? null };
		sent.push(close);
		if (control.mode === "pass") return real(request);
		if (control.mode === "fail")
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		return new Promise<Response>((resolve, reject) => {
			close.settle = (outcome) => ("response" in outcome ? resolve(outcome.response) : reject(outcome.error));
		});
	});
	return { url: fake.url, clientFetch, sent, control };
}

async function until(condition: () => boolean, what: string) {
	const deadline = performance.now() + 10_000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
}

const unanswered = () => ({ error: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }) });

test("a write whose caller aborts it while it waits for a kept close fails at once, and the close goes on (#5114)", async () => {
	const { url, clientFetch, sent, control } = await client();
	// The client's own close of a stream it gave up on fails, so the adapter keeps it.
	await assert.rejects(clientFetch(closeOf(url, "kept")));
	control.mode = "hold";
	const aborted = new AbortController();
	aborted.abort();
	const startedAborted = performance.now();
	await assert.rejects(clientFetch(statementOf(url, "INSERT INTO events VALUES (1)"), { signal: aborted.signal }), {
		name: "AbortError",
	});
	assert.ok(performance.now() - startedAborted < ABORT_BOUND_MS, "a write aborted before it starts fails at once");
	const caller = new AbortController();
	const write = clientFetch(statementOf(url, "INSERT INTO events VALUES (2)"), { signal: caller.signal });
	await until(() => sent.some((close) => close.settle !== undefined), "the kept close to be under way");
	await sleep(50);
	const abortedAt = performance.now();
	caller.abort();
	await assert.rejects(write, { name: "AbortError" });
	assert.ok(performance.now() - abortedAt < ABORT_BOUND_MS, "the aborted write failed at once");
	const held = sent.find((close) => close.settle !== undefined)!;
	assert.equal(held.signal?.aborted, false, "aborting a waiting write does not abort the kept close");
	held.settle!({ response: new Response("{}", { status: 200 }) });
	const after = await clientFetch(statementOf(url, "INSERT INTO events VALUES (3)"));
	assert.equal(after.status, 200);
}, 30_000);

test("a close kept while the timer's resend is under way adds no second resend, so one unanswered resend doubles the wait once (#5114)", async () => {
	const { url, clientFetch, sent, control } = await client();
	await assert.rejects(clientFetch(closeOf(url, "first")));
	control.mode = "hold";
	await until(() => sent.length === 2, "the timer's resend of the kept close");
	control.mode = "fail";
	// Another close is kept while the resend is under way; a second timer would fire meanwhile and join that resend.
	await assert.rejects(clientFetch(closeOf(url, "second")));
	await sleep(2 * CLOSE_FIRST_WAIT_MS);
	sent[1].settle!(unanswered());
	const settledCount = sent.length;
	// Each round stops at the first close, which fails: the next rounds come after 2 and then 4 first waits.
	await until(
		() => sent.filter((close, index) => index >= settledCount && close.baton === "first").length >= 2,
		"two more rounds",
	);
	const [next, after] = sent.slice(settledCount).filter((close) => close.baton === "first");
	const gap = after.at - next.at;
	assert.ok(gap < 6 * CLOSE_FIRST_WAIT_MS, `the round after next came ${Math.round(gap)} ms after the next one`);
}, 30_000);

test("the timer joining a resend a request started does not double the wait when it goes unanswered (#5114)", async () => {
	const { url, clientFetch, sent, control } = await client();
	await assert.rejects(clientFetch(closeOf(url, "first")));
	control.mode = "hold";
	// A read sends the kept close ahead of itself; the timer comes due while that resend is under way.
	const read = clientFetch(statementOf(url, "SELECT n FROM events"));
	await until(() => sent.length === 2, "the read's resend of the kept close");
	await sleep(2 * CLOSE_FIRST_WAIT_MS);
	control.mode = "fail";
	const releasedAt = performance.now();
	sent[1].settle!(unanswered());
	await read.catch(() => {});
	await until(() => sent.length >= 4, "two timer rounds");
	const [next, after] = sent.slice(2);
	assert.ok(
		next.at - releasedAt < 3 * CLOSE_FIRST_WAIT_MS,
		`the next round came ${Math.round(next.at - releasedAt)} ms after the resend failed`,
	);
	assert.ok(
		after.at - next.at < 3 * CLOSE_FIRST_WAIT_MS,
		`the round after it came ${Math.round(after.at - next.at)} ms later`,
	);
}, 30_000);
