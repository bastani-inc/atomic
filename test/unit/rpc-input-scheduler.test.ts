import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRpcInputLineHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-input.ts";
import { createRpcInputScheduler, isConcurrentRpcControlLine } from "../../packages/coding-agent/src/modes/rpc/rpc-input-scheduler.ts";
import { createRpcSuccessResponse, type RpcOutputRecord } from "../../packages/coding-agent/src/modes/rpc/rpc-responses.ts";
import { createRpcCommandHandler, type RpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("abort_compaction reaches a running compact command without waiting for it to finish", async () => {
	const compact = deferred();
	const abortHandled = deferred();
	const calls: string[] = [];
	const dispatch = createRpcInputScheduler(async (line) => {
		const type = (JSON.parse(line) as { type: string }).type;
		calls.push(`${type}:start`);
		if (type === "compact") await compact.promise;
		if (type === "abort_compaction") abortHandled.resolve();
		calls.push(`${type}:end`);
	});

	dispatch('{"id":"compact","type":"compact"}');
	dispatch('{"id":"abort","type":"abort_compaction"}');

	await Promise.race([
		abortHandled.promise,
		Bun.sleep(50).then(() => { throw new Error("abort_compaction remained queued behind compact"); }),
	]);
	assert.deepEqual(calls, ["compact:start", "abort_compaction:start", "abort_compaction:end"]);

	compact.resolve();
	await Bun.sleep(0);
	assert.deepEqual(calls, ["compact:start", "abort_compaction:start", "abort_compaction:end", "compact:end"]);
});

test("ordinary RPC commands remain ordered while a command is running", async () => {
	const compact = deferred();
	const calls: string[] = [];
	const dispatch = createRpcInputScheduler(async (line) => {
		const type = (JSON.parse(line) as { type: string }).type;
		calls.push(`${type}:start`);
		if (type === "compact") await compact.promise;
		calls.push(`${type}:end`);
	});

	dispatch('{"type":"compact"}');
	dispatch('{"type":"get_state"}');
	await Bun.sleep(0);
	assert.deepEqual(calls, ["compact:start"]);

	compact.resolve();
	await Bun.sleep(0);
	assert.deepEqual(calls, ["compact:start", "compact:end", "get_state:start", "get_state:end"]);
});

test("host protocol responses bypass a running RPC command", async () => {
	const compact = deferred();
	const handled: string[] = [];
	const dispatch = createRpcInputScheduler(async (line) => {
		const type = (JSON.parse(line) as { type: string }).type;
		handled.push(type);
		if (type === "compact") await compact.promise;
	});

	dispatch('{"type":"compact"}');
	dispatch('{"type":"extension_ui_response","id":"ui-1","value":true}');
	dispatch('{"type":"engine_custom_input","componentId":"ui-2","data":"escape"}');
	await Bun.sleep(0);

	assert.deepEqual(handled, ["compact", "extension_ui_response", "engine_custom_input"]);
	compact.resolve();
});

test("only validated cancellation and host-control frames bypass the ordinary lane", () => {
	for (const type of ["abort", "abort_compaction", "abort_retry", "abort_bash"]) {
		assert.equal(isConcurrentRpcControlLine(JSON.stringify({ type })), true, type);
	}
	assert.equal(isConcurrentRpcControlLine('{"type":"extension_ui_response","id":"ui-1","cancelled":true}'), true);
	assert.equal(isConcurrentRpcControlLine('{"type":"engine_custom_input","componentId":"ui-1","data":"escape"}'), true);

	for (const line of [
		'{"type":"compact"}',
		'{"type":"extension_ui_response"}',
		'{"type":"engine_custom_input","componentId":"ui-1"}',
		'{"type":"engine_unknown","componentId":"ui-1"}',
		'not json',
	]) {
		assert.equal(isConcurrentRpcControlLine(line), false, line);
	}
});

test("a rejected ordinary command drains the next ordinary frame", async () => {
	const compact = deferred();
	const calls: string[] = [];
	const dispatch = createRpcInputScheduler(async (line) => {
		const type = (JSON.parse(line) as { type: string }).type;
		calls.push(type);
		if (type === "compact") {
			await compact.promise;
			throw new Error("Compaction cancelled");
		}
	});

	dispatch('{"type":"compact"}');
	dispatch('{"type":"get_state"}');
	compact.resolve();
	await Bun.sleep(0);
	assert.deepEqual(calls, ["compact", "get_state"]);
});

test("duplicate and late compaction aborts remain independent harmless controls", async () => {
	const compact = deferred();
	const calls: string[] = [];
	const dispatch = createRpcInputScheduler(async (line) => {
		const command = JSON.parse(line) as { id?: string; type: string };
		calls.push(command.id ?? command.type);
		if (command.type === "compact") await compact.promise;
	});

	dispatch('{"id":"compact","type":"compact"}');
	dispatch('{"id":"abort-1","type":"abort_compaction"}');
	dispatch('{"id":"abort-2","type":"abort_compaction"}');
	await Bun.sleep(0);
	assert.deepEqual(calls, ["compact", "abort-1", "abort-2"]);

	compact.resolve();
	await Bun.sleep(0);
	dispatch('{"id":"abort-late","type":"abort_compaction"}');
	await Bun.sleep(0);
	assert.deepEqual(calls, ["compact", "abort-1", "abort-2", "abort-late"]);
});

test("RPC input returns the correlated abort response before compact settles", async () => {
	const compact = deferred();
	const records: RpcOutputRecord[] = [];
	const handleCommand: RpcCommandHandler = async (command) => {
		if (command.type === "compact") {
			await compact.promise;
			throw new Error("Compaction cancelled");
		}
		return createRpcSuccessResponse(command.id, command.type);
	};
	const handleLine = createRpcInputLineHandler({
		output: (record) => records.push(record),
		pendingExtensionRequests: new Map(),
		handleCommand,
		checkShutdownRequested: async () => {},
	});
	const dispatch = createRpcInputScheduler(handleLine);

	dispatch('{"id":"compact-1","type":"compact"}');
	dispatch('{"id":"abort-1","type":"abort_compaction"}');
	await Promise.race([
		(async () => {
			while (records.length === 0) await Bun.sleep(1);
		})(),
		Bun.sleep(50).then(() => { throw new Error("abort_compaction response timed out"); }),
	]);
	assert.deepEqual(records, [{ id: "abort-1", type: "response", command: "abort_compaction", success: true }]);

	compact.resolve();
	await Bun.sleep(0);
	assert.deepEqual(records[1], {
		id: "compact-1",
		type: "response",
		command: "compact",
		success: false,
		error: "Compaction cancelled",
	});
});

test("abort_compaction reaches the RPC session and terminates active compaction", async () => {
	let rejectCompaction: ((error: Error) => void) | undefined;
	let abortCalls = 0;
	const session = {
		compact: () => new Promise((_resolve, reject) => { rejectCompaction = reject; }),
		abortCompaction: () => {
			abortCalls += 1;
			rejectCompaction?.(new Error("Compaction cancelled"));
		},
	};
	const records: RpcOutputRecord[] = [];
	const handleCommand = createRpcCommandHandler({
		runtimeHost: {} as never,
		getSession: () => session as never,
		rebindSession: async () => {},
		output: (record) => records.push(record),
	});
	const handleLine = createRpcInputLineHandler({
		output: (record) => records.push(record),
		pendingExtensionRequests: new Map(),
		handleCommand,
		checkShutdownRequested: async () => {},
	});
	const dispatch = createRpcInputScheduler(handleLine);

	dispatch('{"id":"compact-real","type":"compact"}');
	dispatch('{"id":"abort-real","type":"abort_compaction"}');
	await Promise.race([
		(async () => {
			while (records.length < 2) await Bun.sleep(1);
		})(),
		Bun.sleep(50).then(() => { throw new Error("active compaction did not terminate"); }),
	]);

	assert.equal(abortCalls, 1);
	assert.deepEqual(records, [
		{ id: "abort-real", type: "response", command: "abort_compaction", success: true },
		{ id: "compact-real", type: "response", command: "compact", success: false, error: "Compaction cancelled" },
	]);
});
