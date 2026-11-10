import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { GitHubCopilotStreamAttempt } from "../src/providers/github-copilot-stream-attempt.ts";

function fakeClock(start = 1_000): { readonly now: () => number; set(value: number): void; advance(ms: number): void } {
	let current = start;
	return {
		now: () => current,
		set: (value) => {
			current = value;
		},
		advance: (ms) => {
			current += ms;
		},
	};
}

async function* items<T>(values: readonly T[], seen?: T[]): AsyncGenerator<T> {
	for (const value of values) {
		seen?.push(value);
		yield value;
	}
}

describe("GitHubCopilotStreamAttempt (#4626)", () => {
	it("has nothing to report until Copilot answered with HTTP success (#4626)", () => {
		const attempt = new GitHubCopilotStreamAttempt(fakeClock().now);

		assert.equal(attempt.snapshot(), undefined);
		attempt.begin();
		assert.equal(attempt.snapshot(), undefined);
	});

	it("measures from the moment the request was sent (#4626)", () => {
		const clock = fakeClock(1_000);
		const attempt = new GitHubCopilotStreamAttempt(clock.now);

		clock.advance(7_000);
		attempt.begin();
		clock.advance(250);
		attempt.respond(new Headers());
		clock.advance(2_250);

		assert.equal(attempt.snapshot()?.durationMs, 2_500);
	});

	it("reports no events for a response that was never observed, even before the first send (#4626)", () => {
		const attempt = new GitHubCopilotStreamAttempt(fakeClock(0).now);

		attempt.respond(new Headers());

		assert.deepEqual(attempt.snapshot(), { durationMs: 0, startedContent: false });
	});

	it("rounds the duration to whole milliseconds and never reports a negative one (#4626)", () => {
		const clock = fakeClock(100);
		const attempt = new GitHubCopilotStreamAttempt(clock.now);
		attempt.begin();
		attempt.respond(new Headers());

		clock.set(100.4);
		assert.equal(attempt.snapshot()?.durationMs, 0);
		clock.set(100.6);
		assert.equal(attempt.snapshot()?.durationMs, 1);
		clock.set(40);
		assert.equal(attempt.snapshot()?.durationMs, 0);
	});

	it("records the x-request-id and treats an empty or missing one as unknown (#4626)", () => {
		const attempt = new GitHubCopilotStreamAttempt(fakeClock().now);
		attempt.begin();

		attempt.respond(new Headers({ "x-request-id": "req-77", "request-id": "other" }));
		assert.equal(attempt.snapshot()?.requestId, "req-77");

		attempt.respond(new Headers({ "x-request-id": "" }));
		assert.equal(Object.hasOwn(attempt.snapshot() ?? {}, "requestId"), false);

		attempt.respond(new Headers({ "request-id": "not-copilots" }));
		assert.equal(Object.hasOwn(attempt.snapshot() ?? {}, "requestId"), false);
	});

	it("notes that the response started only once a provider event arrived (#4626)", async () => {
		const attempt = new GitHubCopilotStreamAttempt(fakeClock().now);
		attempt.begin();
		attempt.respond(new Headers());
		const seen: number[] = [];
		const observed = attempt.observe(items([1, 2, 3], seen));

		assert.equal(attempt.snapshot()?.startedContent, false);
		const received: number[] = [];
		for await (const value of observed) {
			received.push(value);
			assert.equal(attempt.snapshot()?.startedContent, true);
		}

		assert.deepEqual(received, [1, 2, 3]);
		assert.deepEqual(seen, [1, 2, 3]);
	});

	it("keeps startedContent false for a stream that ends without any event (#4626)", async () => {
		const attempt = new GitHubCopilotStreamAttempt(fakeClock().now);
		attempt.begin();
		attempt.respond(new Headers());

		for await (const _ of attempt.observe(items<number>([]))) assert.fail("no event expected");

		assert.equal(attempt.snapshot()?.startedContent, false);
	});

	it("lets a failing source fail the reader after noting the events before it (#4626)", async () => {
		const attempt = new GitHubCopilotStreamAttempt(fakeClock().now);
		attempt.begin();
		attempt.respond(new Headers());
		const cut = new TypeError("terminated");
		async function* failing(): AsyncGenerator<number> {
			yield 1;
			throw cut;
		}

		await assert.rejects(
			(async () => {
				for await (const _ of attempt.observe(failing())) {
					// drain until the source fails
				}
			})(),
			cut,
		);

		assert.equal(attempt.snapshot()?.startedContent, true);
	});

	it("forgets everything observed for an earlier send when the request is sent again (#4626)", async () => {
		const clock = fakeClock(0);
		const attempt = new GitHubCopilotStreamAttempt(clock.now);
		attempt.begin();
		attempt.respond(new Headers({ "x-request-id": "first" }));
		for await (const _ of attempt.observe(items([1]))) {
			// one event arrived
		}
		clock.advance(9_000);

		attempt.begin();

		assert.equal(attempt.snapshot(), undefined);
		clock.advance(40);
		attempt.respond(new Headers());
		assert.deepEqual(attempt.snapshot(), { durationMs: 40, startedContent: false });
	});
});
