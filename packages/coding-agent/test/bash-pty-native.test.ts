import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskSupervisor } from "../src/core/tasks/supervisor.js";
import { createBashToolDefinition, createLocalBashOperations } from "../src/core/tools/bash.ts";

function isNativeUnavailable(error: unknown): boolean {
	return error instanceof Error && error.message.includes("Native PTY package @bastani/atomic-natives is unavailable");
}

describe("native bash PTY execution", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `atomic-pty-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("runs pty:true through a real terminal with cwd and env", async () => {
		if (process.platform === "win32") return;
		let output = "";
		try {
			const result = await createLocalBashOperations().exec(
				'test -t 1 && printf "tty:$FOO:$AI_AGENT:$(basename "$PWD")"',
				testDir,
				{
					pty: true,
					env: { ...process.env, FOO: "bar" },
					onData: (chunk) => {
						output += chunk.toString();
					},
				},
			);
			expect(result.exitCode).toBe(0);
		} catch (error) {
			if (isNativeUnavailable(error)) return;
			throw error;
		}
		expect(output).toContain(`tty:bar:atomic:${basename(testDir)}`);
		expect(output).not.toContain("not a tty");
	});

	it("sets Atomic attribution on regular bash children", async () => {
		if (process.platform === "win32") return;
		let output = "";
		const result = await createLocalBashOperations().exec('printf "%s" "$AI_AGENT"', testDir, {
			onData: (chunk) => {
				output += chunk.toString();
			},
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("atomic");
	});

	it("preserves configured shell args instead of using login shell", async () => {
		if (process.platform === "win32") return;
		mkdirSync(join(testDir, "home"), { recursive: true });
		writeFileSync(join(testDir, "home", ".bash_profile"), "echo PROFILE\n");
		let output = "";
		try {
			await createLocalBashOperations({ shellPath: "/bin/bash" }).exec("echo COMMAND", testDir, {
				pty: true,
				env: { ...process.env, HOME: join(testDir, "home") },
				onData: (chunk) => {
					output += chunk.toString();
				},
			});
		} catch (error) {
			if (isNativeUnavailable(error)) return;
			throw error;
		}
		expect(output).toContain("COMMAND");
		expect(output).not.toContain("PROFILE");
	});

	it("runs stdin-transport shells without feeding synthetic exit", async () => {
		if (process.platform === "win32") return;
		let native: {
			PtySession: new () => {
				start(
					options: Record<string, unknown>,
					cb: (error: Error | null, chunk: string) => void,
				): Promise<{ exitCode?: number; exit_code?: number; timedOut?: boolean; timed_out?: boolean }>;
				write(data: string): void;
			};
		};
		try {
			native = createRequire(import.meta.url)("@bastani/atomic-natives") as typeof native;
		} catch {
			return;
		}
		let output = "";
		let markReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			markReady = resolve;
		});
		const session = new native.PtySession();
		// The deadline only bounds a hung session; it is not part of the asserted behavior, so keep it
		// far above anything a CPU-starved runner needs to start a shell.
		const resultPromise = session.start(
			{
				// The marker is computed so the terminal's echo of the command line cannot satisfy the wait.
				command: "echo ready-$((1+1)); read x; echo got:$x; exit",
				cwd: testDir,
				shell: "/bin/bash",
				commandTransport: "stdin",
				timeoutMs: 60_000,
			},
			(_error, chunk) => {
				output += chunk;
				if (output.includes("ready-2")) markReady();
			},
		);
		// Wait for the shell to reach `read` (or for the session to end early) instead of sleeping a fixed time.
		await Promise.race([ready, resultPromise]);
		session.write("hello\n");
		const result = await resultPromise;
		expect(result.timedOut ?? result.timed_out).not.toBe(true);
		expect(result.exitCode ?? result.exit_code).toBe(0);
		// A synthetic EOF/exit fed to stdin would satisfy `read` before "hello" and leave this empty.
		expect(output).toContain("got:hello");
	});

	it("honors the PI_NO_PTY opt-out by using normal pipe execution", async () => {
		if (process.platform === "win32") return;
		const previous = process.env.PI_NO_PTY;
		process.env.PI_NO_PTY = "1";
		let output = "";
		try {
			const result = await createLocalBashOperations().exec("tty", testDir, {
				pty: true,
				onData: (chunk) => {
					output += chunk.toString();
				},
			});
			expect(result.exitCode).not.toBe(0);
			expect(output).toContain("not a tty");
		} finally {
			if (previous === undefined) delete process.env.PI_NO_PTY;
			else process.env.PI_NO_PTY = previous;
		}
	});

	it("honors headless pty:true tool calls", async () => {
		if (process.platform === "win32") return;
		const result = await createBashToolDefinition(testDir).execute(
			"headless-pty",
			{ command: "[ -t 1 ] && echo tty || echo pipe", pty: true },
			undefined,
			undefined,
			{} as never,
		);
		if (result.content[0]?.text?.includes("Native PTY package")) return;
		expect(result.content[0]?.text).toContain("tty");
	});

	it("checks bashInterceptor before commandPrefix is prepended", async () => {
		const bash = createBashToolDefinition(testDir, {
			commandPrefix: "echo setup",
			interceptorEnabled: true,
			operations: { exec: async () => ({ exitCode: 0 }) },
		});
		await expect(
			bash.execute("prefix-intercept", { command: "cat file.txt" }, undefined, undefined, {} as never),
		).rejects.toThrow(/Use the read tool/);
	});

	it("honors dynamic bashInterceptor setting changes", async () => {
		let enabled = false;
		const bash = createBashToolDefinition(testDir, {
			interceptorEnabled: () => enabled,
			operations: { exec: async () => ({ exitCode: 0 }) },
		});
		await bash.execute("dynamic-off", { command: "cat file.txt" }, undefined, undefined, {} as never);
		enabled = true;
		await expect(
			bash.execute("dynamic-on", { command: "cat file.txt" }, undefined, undefined, {} as never),
		).rejects.toThrow(/Use the read tool/);
	});
	it("returns timeout and wall-time metadata for valid local execution", async () => {
		const bash = createBashToolDefinition(testDir, { operations: { exec: async () => ({ exitCode: 0 }) } });
		const result = await bash.execute(
			"timing",
			{ command: "true", timeout: 3600 },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.details?.timeoutSeconds).toBe(3600);
		expect(result.details?.requestedTimeoutSeconds).toBeUndefined();
		expect(typeof result.details?.wallTimeMs).toBe("number");
	});

	it("reports pty timeouts with the normal bash timeout marker", async () => {
		if (process.platform === "win32") return;
		let thrown: unknown;
		try {
			await createLocalBashOperations().exec("sleep 60", testDir, { pty: true, timeout: 0.05, onData: () => {} });
		} catch (error) {
			thrown = error;
		}
		if (isNativeUnavailable(thrown)) return;
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("timeout:0.05");
	});
});

// RFC #2884: owner-aware execution uses native task admission, never the legacy spawn fallback.
describe.runIf(process.platform !== "win32")("supervised bash command seam", () => {
	function ownerContext() {
		const supervisor = new TaskSupervisor();
		const scope = { kind: "session" as const, sessionId: crypto.randomUUID() };
		let authorized = 0;
		const host = supervisor.bindHostSession({
			scope,
			authorizeLaunch() {},
			authorizeCommandLaunch() {
				authorized++;
			},
			createRunner() {
				throw new Error("not an agent");
			},
		});
		const opened = supervisor.openTaskOwner(host, scope);
		assert.ok(opened.ok);
		return { supervisor, owner: opened.value, authorized: () => authorized };
	}
	it("preserves configured bash, cwd, environment and PTY terminal behavior", async () => {
		const context = ownerContext();
		try {
			for (const pty of [false, true]) {
				const chunks: Buffer[] = [];
				const result = await createLocalBashOperations({ shellPath: "/bin/bash", taskOwner: context }).exec(
					`arr=(bash); printf '%s:%s:%s' "\${arr[0]}" "$S2_VALUE" "$AI_AGENT"; ${pty ? "test -t 1" : "test ! -t 1"}`,
					process.cwd(),
					{ pty, env: { S2_VALUE: "raw value" }, onData: (chunk) => chunks.push(chunk) },
				);
				assert.equal(result.exitCode, 0);
				assert.equal(Buffer.concat(chunks).toString(), "bash:raw value:atomic");
			}
			assert.equal(context.authorized(), 2);
		} finally {
			assert.ok((await context.supervisor.closeTaskOwner(context.owner, "session-close")).ok);
		}
	});
	it("returns a yielded observation at the collection budget and leaves cleanup with owner", async () => {
		const context = ownerContext();
		try {
			const result = await createLocalBashOperations({ taskOwner: context }).exec(
				`exec node -e 'setInterval(()=>process.stdout.write("live\\n"),50)'`,
				process.cwd(),
				{ onData() {} },
			);
			assert.equal(result.exitCode, null);
			assert.equal(result.observation?.kind, "yielded");
			const closed = await context.supervisor.closeTaskOwner(context.owner, "session-close");
			assert.ok(closed.ok);
			assert.equal(closed.value.tasks[0].cleanup.kind, "reaped");
		} finally {
			assert.ok((await context.supervisor.closeTaskOwner(context.owner, "session-close")).ok);
		}
	});
});
