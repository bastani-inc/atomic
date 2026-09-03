import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

type NativeBinding = typeof import("@bastani/atomic-natives");

const requireNativeBinding = process.env.ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE === "1";
let binding: NativeBinding | undefined;
let loadError: Error | undefined;
try {
	binding = createRequire(import.meta.url)("@bastani/atomic-natives") as NativeBinding;
} catch (error) {
	loadError = error instanceof Error ? error : new Error(String(error));
}

const roots: string[] = [];
const CONCURRENT_WAIT_TIMEOUT_MS = 40;
const RETAINED_REAP_TIMEOUT_MS = 2_000;

afterEach(() => {
	// The dropped retained child deliberately outlives its wrapper, and it holds
	// `root` as its working directory and the inherited log file as stdout. Those
	// stay locked on Windows until the process itself exits, which happens after
	// it writes the marker this test waits on, so an immediate rmdir raced the
	// exit and failed with EBUSY. Retry, then give up: reclaiming an OS temp dir
	// is never the assertion.
	for (const root of roots.splice(0)) {
		if (!existsSync(root)) continue;
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		} catch {
			// Left for the OS to reclaim.
		}
	}
});

function requiredBinding(): NativeBinding {
	if (!binding) throw loadError ?? new Error("Native binding is required but unavailable");
	return binding;
}

function forceGc(): void {
	const globalWithGc = globalThis as typeof globalThis & { gc?: () => void };
	let gc = globalWithGc.gc;
	if (!gc) {
		v8.setFlagsFromString("--expose-gc");
		try {
			gc = vm.runInNewContext("gc") as () => void;
		} finally {
			v8.setFlagsFromString("--no-expose-gc");
		}
	}
	for (let index = 0; index < 4; index += 1) gc();
}

async function waitForLog(logFile: string, text: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (existsSync(logFile) && readFileSync(logFile, "utf8").includes(text)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${JSON.stringify(text)} in ${logFile}`);
}

function expectInvalidReceiver(method: (...args: never[]) => unknown, receiver: object, args: unknown[] = []): void {
	expect(() => Reflect.apply(method, receiver, args)).toThrow(Error);
}

describe("N-API class ownership boundary", () => {
	it.skipIf(!requireNativeBinding && !binding)(
		"rejects plain and prototype-spoofed receivers without crashing",
		() => {
			const native = requiredBinding();
			for (const receiver of [{}, Object.create(native.PtySession.prototype)]) {
				expectInvalidReceiver(native.PtySession.prototype.write, receiver, ["input"]);
			}
			for (const receiver of [{}, Object.create(native.SubagentControl.prototype)]) {
				expectInvalidReceiver(native.SubagentControl.prototype.listChildren, receiver);
			}
			const pid = Object.getOwnPropertyDescriptor(native.RetainedPostgres.prototype, "pid")?.get;
			expect(pid).toBeTypeOf("function");
			for (const receiver of [{}, Object.create(native.RetainedPostgres.prototype)]) {
				expect(() => Reflect.apply(pid as () => number | null, receiver, [])).toThrow(Error);
			}
		},
	);

	it.skipIf(!requireNativeBinding && !binding)(
		"keeps a PTY run alive through asynchronous control, wrapper GC, and the running-state guard",
		async () => {
			if (process.platform === "win32") return;
			const native = requiredBinding();
			const root = mkdtempSync(join(tmpdir(), "atomic-napi-pty-ownership-"));
			roots.push(root);
			let output = "";
			let session: InstanceType<typeof native.PtySession> | undefined = new native.PtySession();
			const run = session.start(
				{
					command: "read value; printf 'received:%s' \"$value\"; exit 0",
					cwd: root,
					shell: "/bin/sh",
					commandTransport: "stdin",
					timeoutMs: 2_000,
				},
				(_error, chunk) => {
					output += chunk;
				},
			);
			expect(() => session?.start({ command: "true", cwd: root, shell: "/bin/sh", timeoutMs: 500 })).toThrow(
				/already running/,
			);
			session.resize(100, 30);
			session.write("owned\n");
			session = undefined;
			forceGc();
			const result = await run;
			expect(result.exitCode).toBe(0);
			expect(result.timedOut).toBe(false);
			expect(output).toContain("received:owned");
		},
	);

	it.skipIf(!requireNativeBinding && !binding)(
		"retains one child across concurrent waits and preserves it across wrapper drop",
		async () => {
			const native = requiredBinding();
			const root = mkdtempSync(join(tmpdir(), "atomic-napi-retained-ownership-"));
			roots.push(root);
			const exitGate = join(root, "exit.gate");
			const waitedLog = join(root, "waited.log");
			const waited = native.spawnRetainedPostgres({
				executable: process.execPath,
				args: [
					"-e",
					"const fs=require('node:fs');" +
						"console.log('ready');" +
						"const timer=setInterval(() => {" +
						"if (fs.existsSync(process.argv[1])) {" +
						"clearInterval(timer);" +
						"console.log('done');" +
						"process.exit(0);" +
						"}}, 10);",
					exitGate,
				],
				cwd: root,
				logFile: waitedLog,
			});
			const waitedPid = waited.pid;
			expect(waitedPid).toBeTypeOf("number");
			await waitForLog(waitedLog, "ready");
			const firstWait = waited.wait(CONCURRENT_WAIT_TIMEOUT_MS);
			const secondWait = waited.wait(CONCURRENT_WAIT_TIMEOUT_MS);
			await Promise.all([
				expect(firstWait).rejects.toThrow(/Timed out/),
				expect(secondWait).rejects.toThrow(/Timed out/),
			]);
			expect(waited.pid).toBe(waitedPid);
			writeFileSync(exitGate, "exit");
			await expect(waited.wait(RETAINED_REAP_TIMEOUT_MS)).resolves.toEqual({ exited: true, signaled: false });
			expect(waited.pid).toBeNull();

			const droppedLog = join(root, "dropped.log");
			let dropped: ReturnType<typeof native.spawnRetainedPostgres> | undefined = native.spawnRetainedPostgres({
				executable: process.execPath,
				args: [
					"-e",
					"console.log('ready'); setTimeout(() => { console.log('survived-drop'); process.exit(0) }, 150)",
				],
				cwd: root,
				logFile: droppedLog,
			});
			await waitForLog(droppedLog, "ready");
			expect(dropped.pid).toBeTypeOf("number");
			dropped = undefined;
			forceGc();
			await waitForLog(droppedLog, "survived-drop");
		},
	);

	it.skipIf(!requireNativeBinding && !binding)(
		"holds SubagentControl capacity and host ownership through continued and terminated attempts",
		async () => {
			const native = requiredBinding();
			let control: InstanceType<typeof native.SubagentControl> | undefined = new native.SubagentControl("parent");
			expect(control.parentPath).toBe("parent");
			control.registerAgent("worker");
			const guards = Array.from({ length: 4 }, () => control?.tryAcquireExecutionGuard().token);
			expect(guards.every((token) => typeof token === "number")).toBe(true);
			expect(control.tryAcquireExecutionGuard().refusal?.kind).toBe("capacityExhausted");
			for (const token of guards) expect(control.releaseExecutionGuard(token as number)).toBe(true);

			const admission = control.admitChildSession(
				{ taskName: "analysis", agentName: "worker", cwd: undefined },
				{ path: "parent", depth: 0 },
			);
			expect(admission.child?.path).toBe("parent/analysis_1");
			const attempt = control.beginChildAttempt(admission.child?.path as string);
			expect(attempt.token).toBeTypeOf("number");
			control.finishChildAttempt(attempt.token as number, "continued");
			const termination = control.terminateChildAttempt(attempt.token as number, "interrupt");
			control = undefined;
			forceGc();
			await expect(termination).resolves.toMatchObject({ cause: "interrupt", graceMs: 100 });
		},
	);
});
