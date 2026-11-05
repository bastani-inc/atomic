/**
 * A rejected background compaction command keeps its typed error across RPC: the engine sends the serialized
 * envelope and the client rehydrates the same class (#4330).
 */

import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	BackgroundCompactionConfigError,
	BackgroundCompactionError,
	isBackgroundCompactionConfigError,
	isSerializedBackgroundCompactionError,
	type SerializedBackgroundCompactionError,
	serializeBackgroundCompactionError,
} from "../src/core/compaction/background-compaction-errors.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { createRpcErrorResponse } from "../src/modes/rpc/rpc-responses.ts";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

class ProbeRpcClient extends RpcClient {
	decode(response: RpcResponse): void {
		this.data(response);
	}
}

function decoded(response: RpcResponse): Error {
	try {
		new ProbeRpcClient().decode(response);
	} catch (error) {
		return error as Error;
	}
	assert.fail("the response decoded without an error");
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function handlerFor() {
	const harness = await createHarness();
	harnesses.push(harness);
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	return createRpcCommandHandler({
		runtimeHost: runtime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output: vi.fn(),
	});
}

/** Runs a command the way RPC input does: a thrown error becomes the error response. */
async function respond(command: RpcCommand): Promise<RpcResponse> {
	const handle = await handlerFor();
	try {
		const response = await handle(command);
		assert.ok(response);
		return JSON.parse(JSON.stringify(response)) as RpcResponse;
	} catch (error) {
		const response = createRpcErrorResponse(command.id, command.type, (error as Error).message, error);
		return JSON.parse(JSON.stringify(response)) as RpcResponse;
	}
}

describe("RPC background compaction errors (#4330)", () => {
	test("an error response carries the serialized envelope next to the plain message", () => {
		const error = new BackgroundCompactionConfigError({
			source: "sdk",
			field: "compaction.backgroundThresholdPercent",
			reason: "out-of-range",
		});
		const response = createRpcErrorResponse("t", "set_background_compaction_threshold", error.message, error);
		assert.ok(!response.success && response.errorCode === "background_compaction");
		assert.equal(response.error, error.message);
		assert.deepEqual(response.errorDetails, serializeBackgroundCompactionError(error));
		assert.deepEqual(JSON.parse(JSON.stringify(response)), response);
		assert.equal(response.errorDetails.code, "invalid-setting");
		assert.equal(response.errorDetails.retryable, false);
		assert.deepEqual(response.errorDetails.fields, {
			source: "sdk",
			field: "compaction.backgroundThresholdPercent",
			reason: "out-of-range",
		});
	});

	test("rejected settings commands decode to the typed error the engine threw", async () => {
		const threshold = await respond({ id: "t", type: "set_background_compaction_threshold", percent: 150 });
		assert.equal(threshold.success, false);
		const thresholdError = decoded(threshold);
		assert.ok(thresholdError instanceof BackgroundCompactionConfigError);
		assert.ok(isBackgroundCompactionConfigError(thresholdError));
		assert.equal(thresholdError.code, "invalid-setting");
		assert.equal(thresholdError.source, "sdk");
		assert.equal(thresholdError.reason, "out-of-range");

		const toggle = await respond({ id: "b", type: "set_background_compaction", enabled: "yes" as never });
		const toggleError = decoded(toggle);
		assert.ok(toggleError instanceof BackgroundCompactionConfigError);
		assert.equal(toggleError.reason, "not-a-boolean");
		assert.equal(toggleError.message, toggle.success ? "" : toggle.error);
	});

	test("an envelope for a class this client does not know keeps its name and code", () => {
		const details: SerializedBackgroundCompactionError = {
			name: "BackgroundCompactionFutureError",
			code: "planner-failed",
			message: "future failure",
			hint: "do the future thing",
			retryable: true,
			phase: "plan",
			fields: { upToEntryId: "u7" },
		};
		const error = decoded({
			type: "response",
			command: "set_background_compaction",
			success: false,
			error: "future failure",
			errorCode: "background_compaction",
			errorDetails: details,
		});
		assert.ok(error instanceof BackgroundCompactionError);
		assert.equal(error.name, "BackgroundCompactionFutureError");
		assert.equal(error.code, "planner-failed");
	});

	test("a malformed envelope falls back to a plain error with the response message", () => {
		const error = decoded({
			type: "response",
			command: "set_background_compaction",
			success: false,
			error: "engine refused",
			errorCode: "background_compaction",
			errorDetails: {} as never,
		});
		assert.equal(error.constructor, Error);
		assert.equal(error.message, "engine refused");
	});

	test("the envelope validator accepts only well-formed envelopes at the wire boundary", () => {
		const valid = serializeBackgroundCompactionError(
			new BackgroundCompactionConfigError({ source: "sdk", field: "f", reason: "out-of-range" }),
		);
		assert.equal(isSerializedBackgroundCompactionError(valid), true);
		assert.equal(
			isSerializedBackgroundCompactionError({ ...valid, cause: { name: "Error", message: "disk full" } }),
			true,
		);
		for (const broken of [
			null,
			[],
			"invalid-setting",
			{ ...valid, name: 1 },
			{ ...valid, code: "unknown-code" },
			{ ...valid, message: undefined },
			{ ...valid, hint: 2 },
			{ ...valid, retryable: "no" },
			{ ...valid, phase: "later" },
			{ ...valid, fields: [] },
			{ ...valid, fields: { nested: {} } },
			{ ...valid, cause: "disk full" },
			{ ...valid, cause: { name: "Error" } },
			{ ...valid, cause: { name: "Error", message: "m", cause: 3 } },
			{ ...valid, cause: { ...valid, code: "unknown-code" } },
		]) {
			assert.equal(isSerializedBackgroundCompactionError(broken), false, JSON.stringify(broken));
		}
		let chain: object = { name: "Error", message: "root" };
		for (let depth = 0; depth < 9; depth++) chain = { name: "Error", message: `wrap ${depth}`, cause: chain };
		assert.equal(isSerializedBackgroundCompactionError({ ...valid, cause: chain }), false, "too deep a chain");
	});
});
