import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function resources() {
	const agentDir = mkdtempSync(join(tmpdir(), "intercom-fixture-"));
	mkdirSync(join(agentDir, "intercom"));
	const files = ["delivered-messages.sqlite", "broker.log"].map((name) => join(agentDir, "intercom", name));
	for (const file of files) writeFileSync(file, "owned by broker");
	const fixture = new IntercomBrokerFixture(agentDir);
	// Control the OS event boundary, not the fixture: signal, exit and stdio close
	// are deliberately separate. This ordering oracle also runs on non-Windows hosts.
	const child = new ChildProcess();
	Object.assign(child, { pid: 12345 });
	const kill = vi.spyOn(child, "kill").mockReturnValue(true);
	fixture.trackBroker(child);
	return { agentDir, files, fixture, child, kill };
}

test("cleanup keeps SQLite and logs until close, not merely a signal or exit", async () => {
	const { agentDir, files, fixture, child, kill } = resources();
	const cleanup = fixture.cleanup();
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(kill.mock.calls, [["SIGTERM"]]);
		for (const file of files) assert.equal(existsSync(file), true, `${file} removed before child close`);
		Object.assign(child, { exitCode: 0 });
		child.emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(0);
		for (const file of files) assert.equal(existsSync(file), true, `${file} removed at exit before stdio close`);
		child.emit("close", 0, null);
		await cleanup;
		assert.equal(existsSync(agentDir), false);
	} finally {
		child.emit("close", 0, null);
		await cleanup;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test.each([null, "SIGTERM"] as const)("cleanup remembers a child already closed with signal %s", async (signal) => {
	const { agentDir, fixture, child, kill } = resources();
	try {
		Object.assign(child, { exitCode: signal ? null : 0, signalCode: signal });
		child.emit("exit", child.exitCode, signal);
		child.emit("close", child.exitCode, signal);
		await fixture.cleanup();
		assert.equal(kill.mock.calls.length, 0, "do not signal an already-closed child");
		assert.equal(existsSync(agentDir), false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("cleanup escalates but rejects within its local bound without deleting live-owned files", async () => {
	const { agentDir, files, fixture, child, kill } = resources();
	let failure: Error | undefined;
	const cleanup = fixture.cleanup().catch((error: Error) => {
		failure = error;
	});
	try {
		await vi.runAllTimersAsync();
		assert.ok(failure instanceof Error, "cleanup must reject when close never arrives");
		assert.match(failure.message, /Broker did not close/);
		assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
		for (const file of files) assert.equal(existsSync(file), true);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		child.emit("close", 0, null);
		await cleanup;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("startup errors are observed immediately but cleanup still waits for close", async () => {
	const { agentDir, files, fixture, child } = resources();
	try {
		const failure = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
		assert.doesNotThrow(() => child.emit("error", failure));
		assert.throws(() => fixture.assertRunning(), failure);
		const cleanup = fixture.cleanup();
		await vi.advanceTimersByTimeAsync(0);
		for (const file of files) assert.equal(existsSync(file), true, "error is not close");
		child.emit("close", -2, null);
		await cleanup;
		assert.equal(existsSync(agentDir), false);
	} finally {
		child.emit("close", -2, null);
		await fixture.cleanup();
	}
});

test.each([undefined, "", " /original agent directory/ "])(
	"cleanup restores agent-dir value %j and destroys owned sockets even on a close timeout",
	async (original) => {
		const saved = process.env.ATOMIC_CODING_AGENT_DIR;
		const { agentDir, fixture, child } = resources();
		const socket = new net.Socket();
		try {
			if (original === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = original;
			fixture.overrideAgentDir();
			assert.equal(process.env.ATOMIC_CODING_AGENT_DIR, agentDir);
			fixture.onCleanup(() => {
				socket.destroy();
			});
			await Promise.all([assert.rejects(fixture.cleanup(), /Broker did not close/), vi.runAllTimersAsync()]);
			assert.equal(socket.destroyed, true);
			assert.equal(process.env.ATOMIC_CODING_AGENT_DIR, original);
		} finally {
			child.emit("close", 0, null);
			await fixture.cleanup();
			socket.destroy();
			if (saved === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = saved;
		}
	},
);

test("cleanup also waits for stdio close when exit happened before teardown", async () => {
	const { agentDir, files, fixture, child, kill } = resources();
	Object.assign(child, { exitCode: 1 });
	child.emit("exit", 1, null);
	assert.throws(() => fixture.assertRunning(), /Broker exited during startup: code 1/);
	const cleanup = fixture.cleanup();
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(kill.mock.calls.length, 0);
		for (const file of files) assert.equal(existsSync(file), true);
	} finally {
		child.emit("close", 1, null);
		await cleanup;
	}
	assert.equal(existsSync(agentDir), false);
});

test("cleanup accepts forced termination only after close and clears its timers", async () => {
	const { agentDir, fixture, child, kill } = resources();
	kill.mockImplementation((signal) => {
		if (signal === "SIGKILL") child.emit("close", null, signal);
		return true;
	});
	const cleanup = fixture.cleanup();
	try {
		await vi.runAllTimersAsync();
		await cleanup;
		assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
		assert.equal(existsSync(agentDir), false);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		child.emit("close", 0, null);
		await cleanup;
	}
});

test.each(["throws", "hangs"])(
	"a client cleanup that %s cannot prevent other cleanup or broker termination",
	async (mode) => {
		const { agentDir, fixture, child, kill } = resources();
		const original = process.env.ATOMIC_CODING_AGENT_DIR;
		fixture.overrideAgentDir();
		fixture.onCleanup(() => {
			if (mode === "throws") throw new Error("client cleanup failed");
			return new Promise<void>(() => {});
		});
		const socket = new net.Socket();
		fixture.onCleanup(() => {
			socket.destroy();
		});
		kill.mockImplementation(() => {
			child.emit("close", 0, null);
			return true;
		});
		try {
			await Promise.all([
				assert.rejects(fixture.cleanup(), /client cleanup failed|Broker clients did not close/),
				vi.runAllTimersAsync(),
			]);
			assert.equal(socket.destroyed, true);
			assert.deepEqual(kill.mock.calls, [["SIGTERM"]]);
			assert.equal(process.env.ATOMIC_CODING_AGENT_DIR, original);
			assert.equal(vi.getTimerCount(), 0);
		} finally {
			child.emit("close", 0, null);
			await fixture.cleanup();
			socket.destroy();
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
);

test("cleanup restores the environment when setup failed before spawning a child", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "intercom-not-spawned-"));
	const fixture = new IntercomBrokerFixture(agentDir);
	const original = process.env.ATOMIC_CODING_AGENT_DIR;
	fixture.overrideAgentDir();
	await fixture.cleanup();
	assert.equal(process.env.ATOMIC_CODING_AGENT_DIR, original);
	assert.equal(existsSync(agentDir), false);
	assert.equal(vi.getTimerCount(), 0);
});

test("a real failed spawn closes and can be cleaned without an unhandled error", async () => {
	vi.useRealTimers();
	const agentDir = mkdtempSync(join(tmpdir(), "intercom-spawn-failure-"));
	const fixture = new IntercomBrokerFixture(agentDir);
	const child = spawn(join(agentDir, "missing-executable"), [], { stdio: "ignore" });
	// Never send a real signal without a pid, even if this regression fails.
	const kill = vi.spyOn(child, "kill").mockImplementation(() => assert.fail("cannot signal an unspawned child"));
	fixture.trackBroker(child);
	try {
		await fixture.cleanup();
		assert.throws(() => fixture.assertRunning(), { code: "ENOENT" });
		assert.equal(kill.mock.calls.length, 0);
		assert.equal(existsSync(agentDir), false);
	} finally {
		await fixture.cleanup();
	}
});
