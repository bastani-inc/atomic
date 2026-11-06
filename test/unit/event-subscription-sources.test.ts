import assert from "node:assert/strict";
import { appendFile, truncate, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	EventSourceError,
	isEventSourceError,
	isSubscriptionConfigError,
	SubscriptionClosedError,
	SubscriptionConfigError,
} from "../../packages/coding-agent/src/core/event-subscriptions/errors.js";
import {
	type GitHubCommandRunner,
	githubChecks,
	githubReviews,
	interval,
	logTail,
	webhook,
} from "../../packages/coding-agent/src/core/event-subscriptions/sources.js";
import type { EventSource, SubscriptionEvent } from "../../packages/coding-agent/src/core/event-subscriptions/types.js";
import { createWakeDispatcher } from "../../packages/coding-agent/src/core/event-subscriptions/wake-dispatcher.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const TICK_MS = 20;
const POLL_MS = 20;
const WAIT_TIMEOUT_MS = 10_000;
const SETTLE_MS = 15 * POLL_MS;

interface RunningSource {
	readonly events: SubscriptionEvent[];
	readonly finished: Promise<void>;
	readonly controller: AbortController;
	stop(): Promise<void>;
}

const running: RunningSource[] = [];
const tempDirs: string[] = [];

function run(source: EventSource, emitted: SubscriptionEvent[] = []): RunningSource {
	const controller = new AbortController();
	const finished = Promise.resolve(
		source.start(controller.signal, (event) => {
			if (controller.signal.aborted) throw new SubscriptionClosedError("test", "emit");
			emitted.push(event);
		}),
	);
	const handle: RunningSource = {
		events: emitted,
		finished,
		controller,
		async stop() {
			controller.abort();
			await finished;
		},
	};
	running.push(handle);
	return handle;
}

function eventIds(handle: RunningSource): string[] {
	return handle.events.map((event) => event.id);
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (!condition()) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
		await sleep(5);
	}
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return assert.fail("expected the promise to reject");
}

interface ManualTimer {
	readonly at: number;
	readonly callback: () => void;
}

/** A dispatcher whose clock only moves when the test advances it. */
function manualDispatcher(start = 1_000) {
	let time = start;
	const timers = new Set<ManualTimer>();
	const dispatcher = createWakeDispatcher({
		now: () => time,
		elapsed: () => time,
		setTimer: (callback, ms) => {
			const timer: ManualTimer = { at: time + ms, callback };
			timers.add(timer);
			return { cancel: () => timers.delete(timer) };
		},
	});
	function advance(ms: number): void {
		time += ms;
		for (;;) {
			const due = [...timers].filter((timer) => timer.at <= time).sort((a, b) => a.at - b.at);
			if (due.length === 0) return;
			for (const timer of due) {
				timers.delete(timer);
				timer.callback();
			}
		}
	}
	/** Waits until the source is asleep on one wake, moves the clock, and waits until it is asleep again. */
	async function step(ms: number): Promise<void> {
		await waitFor(() => dispatcher.pending === 1, "the source to sleep");
		advance(ms);
		await waitFor(() => dispatcher.pending === 1, "the source to sleep again");
	}
	return { dispatcher, advance, step, hostTimers: () => timers.size };
}

function assertNoLeakedWakes(clock: ReturnType<typeof manualDispatcher>): void {
	assert.equal(clock.dispatcher.pending, 0);
	assert.equal(clock.hostTimers(), 0);
}

function configError(factory: () => unknown): SubscriptionConfigError {
	try {
		factory();
	} catch (error) {
		assert.ok(isSubscriptionConfigError(error));
		assert.ok(error instanceof SubscriptionConfigError);
		return error;
	}
	return assert.fail("expected the factory to throw");
}

function tempDir(): string {
	const dir = makeTempDirectory("event-sources-");
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	running.length = 0;
});

afterEach(async () => {
	for (const handle of running) {
		handle.controller.abort();
		await handle.finished.catch(() => undefined);
	}
	for (const dir of tempDirs.splice(0)) removeTempDirectory(dir);
});

test("interval emits ticks with unique ids at its scheduled times and holds no wake after abort", async () => {
	const clock = manualDispatcher(1_000);
	const source = interval(TICK_MS, { dispatcher: clock.dispatcher });
	assert.equal(source.id, `interval:${TICK_MS}`);
	const handle = run(source);
	await waitFor(() => clock.dispatcher.pending === 1, "the first wake");
	assert.deepEqual(handle.events, []);

	await clock.step(TICK_MS);
	await clock.step(TICK_MS);
	await waitFor(() => handle.events.length === 2, "two ticks");
	assert.deepEqual(handle.events, [
		{ id: "interval:20:1000:1", type: "tick", payload: { tick: 1, at: 1_020 } },
		{ id: "interval:20:1000:2", type: "tick", payload: { tick: 2, at: 1_040 } },
	]);

	await handle.stop();
	assertNoLeakedWakes(clock);
	clock.advance(10 * TICK_MS);
	assert.equal(handle.events.length, 2);
});

test("interval skips ticks missed during a stall instead of replaying them", async () => {
	const clock = manualDispatcher(1_000);
	const handle = run(interval(TICK_MS, { dispatcher: clock.dispatcher }));
	await clock.step(5 * TICK_MS);
	await clock.step(TICK_MS);
	await waitFor(() => handle.events.length === 2, "two ticks");
	assert.deepEqual(
		handle.events.map((event) => event.id),
		["interval:20:1000:1", "interval:20:1000:2"],
	);
});

test("interval ticks on the shared dispatcher by default and stops on abort", async () => {
	const handle = run(interval(TICK_MS));
	await waitFor(() => handle.events.length >= 2, "two ticks");
	await handle.stop();
	const emitted = handle.events.length;
	assert.equal(new Set(handle.events.map((event) => event.id)).size, emitted);
	await sleep(SETTLE_MS);
	assert.equal(handle.events.length, emitted);
});

test("interval resolves immediately when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const events: SubscriptionEvent[] = [];
	await interval(TICK_MS).start(controller.signal, (event) => events.push(event));
	assert.deepEqual(events, []);
});

test("interval rejects a non-positive-integer period before returning a source", () => {
	for (const ms of [0, -5, 1.5, Number.NaN, 2 ** 31]) {
		const error = configError(() => interval(ms));
		assert.equal(error.code, "invalid-option");
		assert.equal(error.field, "interval.ms");
		assert.equal(error.reason, "not-positive-integer");
	}
});

test("logTail emits only lines appended after it starts, with byte-offset ids", async () => {
	const dir = tempDir();
	const file = join(dir, "app.log");
	await writeFile(file, "old line\n");
	const clock = manualDispatcher();
	const source = logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher });
	assert.equal(source.id, `log:${file}`);
	const handle = run(source);
	await clock.step(POLL_MS);
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, []);

	await appendFile(file, "first\r\nsecond\n");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, [
		{ id: `${file}:9`, type: "line", payload: { path: file, line: "first", offset: 9 } },
		{ id: `${file}:16`, type: "line", payload: { path: file, line: "second", offset: 16 } },
	]);

	await handle.stop();
	assertNoLeakedWakes(clock);
});

test("logTail holds a partial line until its newline arrives", async () => {
	const dir = tempDir();
	const file = join(dir, "partial.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "half a li");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, []);

	await appendFile(file, "ne\nnext");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, [
		{ id: `${file}:0`, type: "line", payload: { path: file, line: "half a line", offset: 0 } },
	]);
	await clock.step(POLL_MS);
	assert.equal(handle.events.length, 1);

	await appendFile(file, "\n");
	await clock.step(POLL_MS);
	assert.equal(eventIds(handle)[1], `${file}:12`);
});

test("logTail waits for a missing file and reads it from the start", async () => {
	const dir = tempDir();
	const file = join(dir, "later.log");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events, []);
	await writeFile(file, "created\n");
	await clock.step(POLL_MS);
	assert.equal(eventIds(handle)[0], `${file}:0`);
});

test("logTail restarts from the beginning when the file is truncated", async () => {
	const dir = tempDir();
	const file = join(dir, "rotate.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await clock.step(POLL_MS);
	await appendFile(file, "aaaaaaaaaa\nbbbbbbbbbb\n");
	await clock.step(POLL_MS);
	assert.equal(handle.events.length, 2);

	await truncate(file, 0);
	await clock.step(POLL_MS);
	await appendFile(file, "c\n");
	await clock.step(POLL_MS);
	assert.deepEqual(handle.events[2], { id: `${file}:0`, type: "line", payload: { path: file, line: "c", offset: 0 } });
});

test("logTail resolves on abort and emits nothing afterwards", async () => {
	const dir = tempDir();
	const file = join(dir, "stop.log");
	await writeFile(file, "");
	const clock = manualDispatcher();
	const handle = run(logTail(file, { pollMs: POLL_MS, dispatcher: clock.dispatcher }));
	await waitFor(() => clock.dispatcher.pending === 1, "the first wake");
	await handle.stop();
	assertNoLeakedWakes(clock);
	await appendFile(file, "late\n");
	clock.advance(10 * POLL_MS);
	await sleep(SETTLE_MS);
	assert.deepEqual(handle.events, []);
});

test("logTail rejects a read failure other than ENOENT with the errno code as detail", async () => {
	const dir = tempDir();
	const notDirectory = join(dir, "file");
	await writeFile(notDirectory, "x");
	const failing = run(logTail(join(notDirectory, "child.log"), { pollMs: POLL_MS }));
	const error = await rejection(failing.finished);
	assert.ok(isEventSourceError(error));
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.code, "source-failed");
	assert.equal(error.phase, "read");
	assert.equal(error.detail, "ENOTDIR");
	assert.equal(error.retryable, false);
	assert.ok(error.cause !== undefined);
});

test("logTail rejects invalid options before touching the file system", () => {
	const missingPath = configError(() => logTail(""));
	assert.equal(missingPath.field, "logTail.path");
	assert.equal(missingPath.reason, "not-string");
	const badPoll = configError(() => logTail("/tmp/x.log", { pollMs: 0 }));
	assert.equal(badPoll.field, "logTail.pollMs");
	assert.equal(badPoll.reason, "not-positive-integer");
});

async function startWebhook(
	options: Parameters<typeof webhook>[0],
): Promise<{ readonly handle: RunningSource; readonly url: string }> {
	const source = webhook(options);
	const handle = run(source);
	return { handle, url: await source.listening() };
}

test("webhook accepts a JSON POST, using x-github-delivery as the event id", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/hooks\/ci$/);

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-delivery": "delivery-1",
			"x-github-event": "check_suite",
		},
		body: JSON.stringify({ id: "body-id", action: "completed" }),
	});
	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), { accepted: true, id: "delivery-1" });
	assert.deepEqual(handle.events, [
		{ id: "delivery-1", type: "check_suite", payload: { id: "body-id", action: "completed" } },
	]);
});

test("webhook falls back to the body id and type, then to a generated id", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	const headers = { "content-type": "application/json" };

	await fetch(url, { method: "POST", headers, body: JSON.stringify({ id: 42, type: "deploy" }) });
	await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "opened" }) });
	await fetch(url, { method: "POST", body: "plain text" });

	assert.equal(handle.events.length, 3);
	assert.equal(handle.events[0]?.id, "42");
	assert.equal(handle.events[0]?.type, "deploy");
	assert.equal(handle.events[1]?.type, "opened");
	assert.match(handle.events[1]?.id ?? "", /^[0-9a-f-]{36}$/);
	assert.equal(handle.events[2]?.type, undefined);
	assert.equal(handle.events[2]?.payload, "plain text");
});

test("webhook prefers x-request-id and idempotency-key over the body id", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	await fetch(url, { method: "POST", headers: { "x-request-id": "req-1" }, body: "a" });
	await fetch(url, { method: "POST", headers: { "idempotency-key": "idem-1" }, body: "b" });
	assert.deepEqual(
		handle.events.map((event) => event.id),
		["req-1", "idem-1"],
	);
});

test("webhook answers 404 for other paths and 405 for other methods, emitting nothing", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	const base = new URL(url).origin;

	assert.equal((await fetch(`${base}/other`, { method: "POST", body: "x" })).status, 404);
	const wrongMethod = await fetch(url, { method: "GET" });
	assert.equal(wrongMethod.status, 405);
	assert.equal(wrongMethod.headers.get("allow"), "POST");
	assert.deepEqual(handle.events, []);
});

test("webhook answers 400 for invalid JSON and 413 for a body over the limit", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci", maxBodyBytes: 64 });

	const invalid = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
	assert.equal(invalid.status, 400);
	const tooLarge = await fetch(url, { method: "POST", body: "x".repeat(65) });
	assert.equal(tooLarge.status, 413);
	const atLimit = await fetch(url, { method: "POST", body: "x".repeat(64) });
	assert.equal(atLimit.status, 202);
	assert.equal(handle.events.length, 1);
});

test("webhook responds 503 when the subscription no longer accepts events", async () => {
	const source = webhook({ path: "/hooks/ci" });
	const controller = new AbortController();
	let closed = false;
	const finished = Promise.resolve(
		source.start(controller.signal, () => {
			if (closed) throw new SubscriptionClosedError("test", "emit");
		}),
	);
	running.push({ events: [], finished, controller, stop: async () => undefined });
	const url = await source.listening();
	closed = true;
	assert.equal((await fetch(url, { method: "POST", body: "x" })).status, 503);
});

test("webhook stops listening and resolves when the signal aborts", async () => {
	const { handle, url } = await startWebhook({ path: "/hooks/ci" });
	await handle.stop();
	const error = await rejection(fetch(url, { method: "POST", body: "x" }));
	assert.ok(error instanceof Error);
	assert.deepEqual(handle.events, []);
});

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

test("webhook rejects with a listen failure when another process holds the port", async () => {
	const occupier = createServer();
	await new Promise<void>((resolve) => occupier.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = occupier.address() as AddressInfo;
		const source = webhook({ path: "/hooks/ci", port });
		const finished = Promise.resolve(source.start(new AbortController().signal, () => undefined));
		const error = await rejection(finished);
		assert.ok(isEventSourceError(error));
		assert.ok(error instanceof EventSourceError);
		assert.equal(error.code, "source-failed");
		assert.equal(error.phase, "listen");
		assert.equal(error.detail, "EADDRINUSE");
		assert.equal(error.sourceId, "webhook:/hooks/ci");
		assert.equal(await rejection(source.listening()), error);
	} finally {
		await new Promise<void>((resolve) => occupier.close(() => resolve()));
	}
});

test("webhook sources on one fixed port share a server that closes with the last of them", async () => {
	const port = await freePort();
	const ci = await startWebhook({ path: "/hooks/ci", port });
	const deploy = await startWebhook({ path: "/hooks/deploy", port });
	assert.equal(new URL(ci.url).port, String(port));
	assert.equal(new URL(deploy.url).port, String(port));

	await fetch(ci.url, { method: "POST", headers: { "x-request-id": "ci-1" }, body: "a" });
	await fetch(deploy.url, { method: "POST", headers: { "x-request-id": "deploy-1" }, body: "b" });
	assert.deepEqual(
		ci.handle.events.map((event) => event.id),
		["ci-1"],
	);
	assert.deepEqual(
		deploy.handle.events.map((event) => event.id),
		["deploy-1"],
	);

	await ci.handle.stop();
	assert.equal((await fetch(ci.url, { method: "POST", body: "x" })).status, 404);
	assert.equal((await fetch(deploy.url, { method: "POST", body: "x" })).status, 202);

	await deploy.handle.stop();
	assert.ok((await rejection(fetch(deploy.url, { method: "POST", body: "x" }))) instanceof Error);

	const reopened = await startWebhook({ path: "/hooks/ci", port });
	assert.equal(new URL(reopened.url).port, String(port));
});

test("webhook rejects a second source registering the same path on a shared port", async () => {
	const port = await freePort();
	const first = await startWebhook({ path: "/hooks/ci", port });
	const second = webhook({ path: "/hooks/ci", port });
	const error = await rejection(Promise.resolve(second.start(new AbortController().signal, () => undefined)));
	assert.ok(isSubscriptionConfigError(error));
	assert.ok(error instanceof SubscriptionConfigError);
	assert.equal(error.code, "invalid-option");
	assert.equal(error.field, "webhook.path");
	assert.equal(error.reason, "duplicate-id");
	assert.equal(await rejection(second.listening()), error);
	assert.equal((await fetch(first.url, { method: "POST", body: "x" })).status, 202);
});

test("webhook sources on the ephemeral port each get their own server", async () => {
	const first = await startWebhook({ path: "/hooks/ci" });
	const second = await startWebhook({ path: "/hooks/ci" });
	assert.notEqual(new URL(first.url).port, new URL(second.url).port);
	await first.handle.stop();
	assert.equal((await fetch(second.url, { method: "POST", body: "x" })).status, 202);
});

test("webhook rejects invalid options before listening", () => {
	assert.equal(configError(() => webhook({ path: "hooks" })).field, "webhook.path");
	assert.equal(configError(() => webhook({ path: "" })).reason, "not-string");
	const port = configError(() => webhook({ path: "/h", port: 70_000 }));
	assert.equal(port.field, "webhook.port");
	assert.equal(port.reason, "not-positive-integer");
	const body = configError(() => webhook({ path: "/h", maxBodyBytes: 0 }));
	assert.equal(body.field, "webhook.maxBodyBytes");
	assert.equal(body.reason, "not-positive-integer");
	assert.equal(configError(() => webhook({ path: "/h", hostname: "" })).field, "webhook.hostname");
});

interface RecordingRunner {
	readonly gh: GitHubCommandRunner;
	readonly calls: (readonly string[])[];
}

function fakeGh(responses: Readonly<Record<string, string>>): RecordingRunner {
	const calls: (readonly string[])[] = [];
	const gh: GitHubCommandRunner = async (args) => {
		calls.push(args);
		const response = responses[args.join(" ")];
		if (response === undefined) throw new Error(`unexpected gh call: ${args.join(" ")}`);
		return response;
	};
	return { gh, calls };
}

test("githubChecks emits one check_run event per check run of the head commit", async () => {
	const { gh, calls } = fakeGh({
		"api repos/acme/widgets/pulls/7": JSON.stringify({ head: { sha: "abc123" } }),
		"api repos/acme/widgets/commits/abc123/check-runs?per_page=100": JSON.stringify({
			check_runs: [
				{
					id: 11,
					name: "build",
					status: "completed",
					conclusion: "success",
					html_url: "https://github.com/acme/widgets/runs/11",
					started_at: "2026-01-01T00:00:00Z",
					completed_at: "2026-01-01T00:05:00Z",
				},
				{ id: 12, name: "lint", status: "in_progress", conclusion: null, html_url: null },
			],
		}),
	});
	const clock = manualDispatcher();
	const source = githubChecks({ repo: "acme/widgets", pr: 7, intervalMs: POLL_MS, gh, dispatcher: clock.dispatcher });
	assert.equal(source.id, "github-checks:acme/widgets#7");
	const handle = run(source);
	await clock.step(POLL_MS);
	await handle.stop();
	assertNoLeakedWakes(clock);
	assert.equal(handle.events.length, 4);

	assert.deepEqual(handle.events.slice(0, 2), [
		{
			id: "check-run:11:completed:success",
			type: "check_run",
			payload: {
				name: "build",
				status: "completed",
				conclusion: "success",
				url: "https://github.com/acme/widgets/runs/11",
				headSha: "abc123",
				startedAt: "2026-01-01T00:00:00Z",
				completedAt: "2026-01-01T00:05:00Z",
			},
		},
		{
			id: "check-run:12:in_progress:none",
			type: "check_run",
			payload: {
				name: "lint",
				status: "in_progress",
				conclusion: null,
				url: null,
				headSha: "abc123",
				startedAt: null,
				completedAt: null,
			},
		},
	]);
	assert.deepEqual(handle.events.slice(2, 4), handle.events.slice(0, 2));
	assert.deepEqual(calls.slice(0, 2), [
		["api", "repos/acme/widgets/pulls/7"],
		["api", "repos/acme/widgets/commits/abc123/check-runs?per_page=100"],
	]);
});

test("githubReviews emits one pull_request_review event per review", async () => {
	const { gh, calls } = fakeGh({
		"api repos/acme/widgets/pulls/7/reviews?per_page=100": JSON.stringify([
			{
				id: 901,
				user: { login: "octocat" },
				state: "APPROVED",
				body: "ship it",
				submitted_at: "2026-01-02T00:00:00Z",
				html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-901",
			},
			{ id: 902, user: null, state: "COMMENTED", body: null },
		]),
	});
	const clock = manualDispatcher();
	const source = githubReviews({ repo: "acme/widgets", pr: 7, intervalMs: POLL_MS, gh, dispatcher: clock.dispatcher });
	assert.equal(source.id, "github-reviews:acme/widgets#7");
	const handle = run(source);
	await waitFor(() => clock.dispatcher.pending === 1, "the first poll to finish");
	assert.equal(handle.events.length, 2);
	await handle.stop();
	assertNoLeakedWakes(clock);

	assert.deepEqual(handle.events.slice(0, 2), [
		{
			id: "review:901",
			type: "pull_request_review",
			payload: {
				reviewer: "octocat",
				state: "APPROVED",
				body: "ship it",
				submittedAt: "2026-01-02T00:00:00Z",
				url: "https://github.com/acme/widgets/pull/7#pullrequestreview-901",
			},
		},
		{
			id: "review:902",
			type: "pull_request_review",
			payload: { reviewer: null, state: "COMMENTED", body: "", submittedAt: null, url: null },
		},
	]);
	assert.deepEqual(calls[0], ["api", "repos/acme/widgets/pulls/7/reviews?per_page=100"]);
});

test("github sources reject with a poll failure that keeps the runner error as the cause", async () => {
	const runnerFailure = new Error("gh exited with code 1");
	const gh: GitHubCommandRunner = async () => {
		throw runnerFailure;
	};
	for (const factory of [githubChecks, githubReviews]) {
		const source = factory({ repo: "acme/widgets", pr: 7, intervalMs: POLL_MS, gh });
		const error = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
		assert.ok(isEventSourceError(error));
		assert.ok(error instanceof EventSourceError);
		assert.equal(error.code, "source-failed");
		assert.equal(error.phase, "poll");
		assert.equal(error.sourceId, source.id);
		assert.equal(error.retryable, true);
		assert.equal(error.cause, runnerFailure);
	}
});

test("github sources treat a malformed response as a non-retryable poll failure", async () => {
	const source = githubReviews({ repo: "acme/widgets", pr: 7, gh: async () => "not json" });
	const error = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
	assert.ok(error instanceof EventSourceError);
	assert.equal(error.phase, "poll");
	assert.equal(error.retryable, false);
	assert.equal(error.detail, "unexpected gh response");
});

test("a failed poll renders one credential-free message that names the phase and source", async () => {
	const source = githubChecks({
		repo: "acme/widgets",
		pr: 7,
		gh: async () => {
			throw new Error("token ghp_secret rejected");
		},
	});
	const error = await rejection(Promise.resolve(source.start(new AbortController().signal, () => undefined)));
	assert.ok(error instanceof EventSourceError);
	assert.equal(
		error.message,
		"Event source failed during poll (gh failed): github-checks:acme/widgets#7 (source-failed). " +
			"Check the source's configuration and access (for GitHub sources, `gh auth status`), then subscribe again.",
	);
});

test("aborting while a poll is in flight resolves instead of failing", async () => {
	let started: () => void = () => undefined;
	const polling = new Promise<void>((resolve) => {
		started = resolve;
	});
	const gh: GitHubCommandRunner = (_args, signal) =>
		new Promise((_resolve, reject) => {
			started();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	const clock = manualDispatcher();
	const handle = run(githubReviews({ repo: "acme/widgets", pr: 7, gh, dispatcher: clock.dispatcher }));
	await polling;
	await handle.stop();
	assertNoLeakedWakes(clock);
	assert.deepEqual(handle.events, []);
});

test("aborting between polls resolves without leaving a timer or emitting again", async () => {
	const { gh, calls } = fakeGh({ "api repos/acme/widgets/pulls/7/reviews?per_page=100": "[]" });
	const clock = manualDispatcher();
	const handle = run(
		githubReviews({ repo: "acme/widgets", pr: 7, intervalMs: 1_000_000, gh, dispatcher: clock.dispatcher }),
	);
	await waitFor(() => clock.dispatcher.pending === 1, "the first poll to finish");
	await handle.stop();
	assertNoLeakedWakes(clock);
	clock.advance(2_000_000);
	await sleep(SETTLE_MS);
	assert.equal(calls.length, 1);
});

test("github sources validate repo, pr and interval before any command runs", () => {
	let ran = false;
	const gh: GitHubCommandRunner = async () => {
		ran = true;
		return "[]";
	};
	for (const [name, factory] of [
		["githubChecks", githubChecks],
		["githubReviews", githubReviews],
	] as const) {
		for (const repo of ["", "widgets", "acme/", "/widgets", "acme/../x", "acme/widgets/extra", "a b/c"]) {
			const error = configError(() => factory({ repo, pr: 1, gh }));
			assert.equal(error.field, `${name}.repo`);
			assert.equal(error.reason, "not-string");
		}
		for (const pr of [0, -1, 1.5, Number.NaN]) {
			const error = configError(() => factory({ repo: "acme/widgets", pr, gh }));
			assert.equal(error.field, `${name}.pr`);
			assert.equal(error.reason, "not-positive-integer");
		}
		const interval = configError(() => factory({ repo: "acme/widgets", pr: 1, intervalMs: 0, gh }));
		assert.equal(interval.field, `${name}.intervalMs`);
		assert.equal(interval.reason, "not-positive-integer");
	}
	assert.equal(ran, false);
});

test("sources reject a dispatcher that cannot sleep before any wake is scheduled", () => {
	const broken = {
		now: () => 0,
		elapsed: () => 0,
		schedule: () => ({ cancel: () => undefined }),
		sleep: "no" as never,
	};
	assert.equal(configError(() => interval(TICK_MS, { dispatcher: broken })).field, "interval.dispatcher");
	assert.equal(configError(() => logTail("/tmp/x.log", { dispatcher: broken })).field, "logTail.dispatcher");
	const repoOptions = { repo: "acme/widgets", pr: 1, dispatcher: broken };
	assert.equal(configError(() => githubChecks(repoOptions)).field, "githubChecks.dispatcher");
	assert.equal(configError(() => githubReviews(repoOptions)).reason, "not-function");
});
