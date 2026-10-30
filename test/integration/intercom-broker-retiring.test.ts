import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 90_000;
/**
 * Every shared database call waits this long, so a broker giving its leases up takes a call per session and then some:
 * the closing window this suite connects into lasts about a second (the broker bounds it at two) instead of a few
 * milliseconds. The brokers' own start-up pays the same delay per call.
 */
const DATABASE_CALL_DELAY_MS = 150;
const SESSIONS_HELD_ON_THE_RETIRING_BROKER = 4;
const CLOSING_TEST_TIMEOUT_MS = 30_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ databaseCallDelayMs: DATABASE_CALL_DELAY_MS });
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test(
	"a broker that is closing refuses a registration as retiring instead of registering a session it is about to drop",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const group = unique("retiring");
		const sessions = await Promise.all(
			Array.from({ length: SESSIONS_HELD_ON_THE_RETIRING_BROKER }, (_, index) =>
				harness.connect("a", unique(`held-${index}`), { group }),
			),
		);

		// An orderly shutdown request, not a signal: on Windows a SIGTERM ends the process unconditionally, so the
		// broker would never close in an observable window and its pipe would be gone at once. The broker's pipe stays
		// open until its shutdown has finished, on every platform, which is what lets it answer a late registration.
		await harness.requestShutdown("a");
		// The broker ends every session's socket as its shutdown begins, so from here on it is closing.
		await vi.waitFor(
			() =>
				assert.ok(
					sessions.every((session) => session.disconnected),
					"sessions still connected",
				),
			{
				timeout: 10_000,
				interval: 10,
			},
		);

		const failure = await harness.connect("a", unique("late"), { group }).then(
			() => undefined,
			(error: unknown) => error,
		);

		assert.ok(failure instanceof Error, "the registration was accepted by a broker that is closing");
		// The client module is loaded per node, so the class is told apart by what it declares about itself.
		assert.equal(failure.name, "IntercomBrokerRetiringError", String(failure));
		assert.equal((failure as { intercomRecoverableDisconnect?: boolean }).intercomRecoverableDisconnect, true);
		assert.match(failure.message, /broker is retiring/u);
		// The answer came from the broker, not from its exit: it was still closing when it gave it.
		assert.equal(harness.isBrokerRunning("a"), true);

		// A replacement on the same socket serves the next registration, as a spawned successor would.
		await harness.stopBroker("a", "SIGKILL").catch(() => undefined);
		await harness.startBroker("a");
		const registered = await harness.connect("a", unique("after"), { group });
		assert.equal(registered.disconnected, false);
	},
	CLOSING_TEST_TIMEOUT_MS,
);
