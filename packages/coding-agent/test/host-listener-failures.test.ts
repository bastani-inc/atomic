import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { ActivityWatchdogDiagnostic } from "../src/modes/interactive-engine/activity-watchdog.ts";
import { HostListenerFailures } from "../src/modes/interactive-engine/host-listener-failures.ts";

const event = { type: "message_start" };
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("HostListenerFailures", () => {
	test("a listener's promise is observed without running its own then or catch (#6107)", async () => {
		const reported: string[] = [];
		const failures = new HostListenerFailures((diagnostic) => reported.push(diagnostic.message));
		const touched: string[] = [];
		const result = Object.defineProperties(Promise.resolve(), {
			// biome-ignore lint/suspicious/noThenProperty: the promise's own then must never be read
			then: { get: () => touched.push("then") && Promise.prototype.then },
			catch: { get: () => touched.push("catch") && Promise.prototype.catch },
		});

		failures.call(() => result, event, "event");
		await nextTurn();

		assert.deepEqual(touched, []);
		assert.deepEqual(reported, []);
	});

	test("a reporter that throws or rejects does not let the failure escape (#6107)", async () => {
		const unhandled: unknown[] = [];
		const record = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", record);
		try {
			const reporters: ((diagnostic: ActivityWatchdogDiagnostic) => void)[] = [
				() => {
					throw new Error("could not show the error");
				},
				async () => {
					throw new Error("could not show the error");
				},
			];
			for (const report of reporters) {
				new HostListenerFailures(report).call(
					() => {
						throw new Error("listener failed");
					},
					event,
					"event",
				);
			}
			await nextTurn();

			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", record);
		}
	});

	test("a failure whose value cannot be read is still reported (#6107)", () => {
		const reported: string[] = [];
		const failures = new HostListenerFailures((diagnostic) => reported.push(diagnostic.message));
		const unreadable = Object.create(null) as object;
		const changed = {
			get type(): string {
				throw new Error("no type");
			},
		};

		failures.call(
			() => {
				throw unreadable;
			},
			changed,
			"event",
		);

		assert.deepEqual(reported, [
			"Atomic failed while handling the interactive engine's unrecognized event: an exception whose message cannot be read",
		]);
	});
});
