import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

afterEach(() => {
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
