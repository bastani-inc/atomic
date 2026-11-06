/**
 * A release or wake failure keeps what caused it, and what a caller can do about the cause survives a process
 * boundary (#4326): a retryable cause is still retryable after a worker, RPC or broker round trip.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	AgentRehydrateError,
	type AgentRehydrateErrorCode,
	isAgentRehydrateError,
	isRetryableAgentRehydrateError,
	rehydrateAgentRehydrateError,
	type SerializedAgentRehydrateError,
	serializeAgentRehydrateError,
} from "../src/core/agent-rehydrate-errors.ts";
import { StorageConfigError, StorageWriteLockTimeoutError } from "../src/core/storage/errors.ts";
import { ToolDetachmentError } from "../src/core/tool-detachment-errors.ts";

function acrossProcesses(error: AgentRehydrateError): AgentRehydrateError {
	const wire = JSON.parse(JSON.stringify(serializeAgentRehydrateError(error))) as SerializedAgentRehydrateError;
	return rehydrateAgentRehydrateError(wire);
}

const FIELDS = { sessionId: "s-1", storage: "node-sqlite" };

describe("a cause survives a process boundary with what a caller acts on (#4326)", () => {
	test("a retryable agent error under a failure keeps the failure retryable, as the same class", () => {
		const busy = new AgentRehydrateError("session-busy", { ...FIELDS, activity: "queued-messages" });
		const failed = new AgentRehydrateError("release-failed", FIELDS, { cause: busy });
		assert.equal(failed.retryable, false);
		assert.equal(isRetryableAgentRehydrateError(failed), true, "the busy cause makes it retryable");

		const rebuilt = acrossProcesses(failed);

		assert.equal(isRetryableAgentRehydrateError(rebuilt), true);
		assert.ok(rebuilt.cause instanceof AgentRehydrateError);
		assert.equal((rebuilt.cause as AgentRehydrateError).code, "session-busy");
		assert.equal((rebuilt.cause as AgentRehydrateError).retryable, true);
		assert.deepEqual((rebuilt.cause as AgentRehydrateError).fields, busy.fields);
	});

	test("a non-retryable agent error under a failure stays non-retryable", () => {
		const missing = new AgentRehydrateError("session-not-found", { ...FIELDS, localOnly: true });
		const rebuilt = acrossProcesses(new AgentRehydrateError("wake-failed", { wakeKey: "k" }, { cause: missing }));

		assert.equal(isRetryableAgentRehydrateError(rebuilt), false);
		assert.equal((rebuilt.cause as AgentRehydrateError).code, "session-not-found");
	});

	test("every code of a nested agent error keeps its class, code and retryable flag", () => {
		const codes: ReadonlyArray<readonly [AgentRehydrateErrorCode, boolean]> = [
			["session-busy", true],
			["not-reopenable", false],
			["session-not-found", false],
			["wake-failed", false],
			["release-failed", false],
		];
		for (const [code, retryable] of codes) {
			const rebuilt = acrossProcesses(
				new AgentRehydrateError("wake-failed", {}, { cause: new AgentRehydrateError(code, FIELDS) }),
			);
			const cause = rebuilt.cause;
			assert.ok(isAgentRehydrateError(cause));
			assert.equal(cause.code, code);
			assert.equal(cause.retryable, retryable);
		}
	});

	test("a tool detachment error cause comes back as a ToolDetachmentError with its code, fields and retryable flag", () => {
		const busy = new ToolDetachmentError("session-busy", { sessionId: "s-1" });
		const rebuilt = acrossProcesses(new AgentRehydrateError("wake-failed", { wakeKey: "k" }, { cause: busy }));

		const cause = rebuilt.cause;
		assert.ok(cause instanceof ToolDetachmentError);
		assert.equal(cause.code, "session-busy");
		assert.equal(cause.retryable, true);
		assert.deepEqual(cause.fields, { sessionId: "s-1" });
	});

	test("a storage error cause comes back as its storage class with its code and retryable flag", () => {
		const timeout = new StorageWriteLockTimeoutError(
			{ adapter: "node-sqlite", location: "/sessions.sqlite" },
			{ timeoutMs: 5_000, elapsedMs: 5_001, phase: "queued" },
		);
		const config = new StorageConfigError("sdk", "sessionStore", "missing");
		const rebuilt = acrossProcesses(
			new AgentRehydrateError("release-failed", FIELDS, { cause: new AggregateError([timeout, config]) }),
		);
		const rebuiltTimeout = acrossProcesses(new AgentRehydrateError("wake-failed", {}, { cause: timeout })).cause;
		const rebuiltConfig = acrossProcesses(new AgentRehydrateError("wake-failed", {}, { cause: config })).cause;

		assert.ok(rebuiltTimeout instanceof StorageWriteLockTimeoutError);
		assert.equal(rebuiltTimeout.code, "write-lock-timeout");
		assert.equal(rebuiltTimeout.retryable, true);
		assert.ok(rebuiltConfig instanceof StorageConfigError);
		assert.equal(rebuiltConfig.code, "invalid-config");
		assert.equal(rebuilt.cause?.name, "AggregateError", "an error outside every family stays a plain error");
	});

	test("an unknown cause keeps its name, code and retryable flag on a plain error", () => {
		const unknown = Object.assign(new Error("transport reset"), {
			name: "BrokerLinkError",
			code: "link-reset",
			retryable: true,
		});
		const rebuilt = acrossProcesses(new AgentRehydrateError("wake-failed", { wakeKey: "k" }, { cause: unknown }));

		const cause = rebuilt.cause as Error & { code?: string; retryable?: boolean };
		assert.equal(cause.name, "BrokerLinkError");
		assert.equal(cause.code, "link-reset");
		assert.equal(cause.retryable, true);
		assert.equal(cause.message, "transport reset");
	});

	test("a structural copy of a retryable agent error from another realm stays retryable", () => {
		const copy = { name: "AgentRehydrateError", message: "busy", code: "session-busy", retryable: true };
		const failed = new AgentRehydrateError("release-failed", FIELDS, { cause: copy });
		assert.equal(isRetryableAgentRehydrateError(failed), true);

		assert.equal(isRetryableAgentRehydrateError(acrossProcesses(failed)), true);
	});

	test("a cause chain of agent errors stays bounded across the round trip", () => {
		let cause: Error = new AgentRehydrateError("session-busy", FIELDS);
		for (let level = 0; level < 20; level++)
			cause = new AgentRehydrateError("wake-failed", { wakes: level }, { cause });

		const wire = JSON.parse(JSON.stringify(serializeAgentRehydrateError(cause as AgentRehydrateError)));
		let depth = 0;
		for (let link = wire.cause; link !== undefined; link = (link.family?.error ?? link).cause) depth += 1;

		assert.ok(depth <= 8, `the chain was cut at ${depth} levels`);
		assert.doesNotThrow(() => rehydrateAgentRehydrateError(wire));
	});
});
