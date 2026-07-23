import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
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
				'test -t 1 && printf "tty:$FOO:$(basename "$PWD")"',
				testDir,
				{ pty: true, env: { ...process.env, FOO: "bar" }, onData: (chunk) => { output += chunk.toString(); } },
			);
			expect(result.exitCode).toBe(0);
		} catch (error) {
			if (isNativeUnavailable(error)) return;
			throw error;
		}
		expect(output).toContain(`tty:bar:${basename(testDir)}`);
		expect(output).not.toContain("not a tty");
	});

	it("preserves configured shell args instead of using login shell", async () => {
		if (process.platform === "win32") return;
		mkdirSync(join(testDir, "home"), { recursive: true });
		writeFileSync(join(testDir, "home", ".bash_profile"), "echo PROFILE\n");
		let output = "";
		try {
			await createLocalBashOperations({ shellPath: "/bin/bash" }).exec("echo COMMAND", testDir, { pty: true, env: { ...process.env, HOME: join(testDir, "home") }, onData: (chunk) => { output += chunk.toString(); } });
		} catch (error) {
			if (isNativeUnavailable(error)) return;
			throw error;
		}
		expect(output).toContain("COMMAND");
		expect(output).not.toContain("PROFILE");
	});

	it("runs stdin-transport shells without feeding synthetic exit", async () => {
		if (process.platform === "win32") return;
		let native: { PtySession: new () => { start(options: Record<string, unknown>, cb: (error: Error | null, chunk: string) => void): Promise<{ exitCode?: number; exit_code?: number; timedOut?: boolean; timed_out?: boolean }>; write(data: string): void } };
		try { native = createRequire(import.meta.url)("@bastani/atomic-natives") as typeof native; } catch { return; }
		let output = "";
		const session = new native.PtySession();
		const resultPromise = session.start({ command: "sleep 0.2; read x; echo got:$x; exit", cwd: testDir, shell: "/bin/bash", commandTransport: "stdin", timeoutMs: 1500 }, (_error, chunk) => { output += chunk; });
		await new Promise((resolve) => setTimeout(resolve, 500));
		session.write("hello\n");
		const result = await resultPromise;
		expect(result.timedOut ?? result.timed_out).not.toBe(true);
		expect(result.exitCode ?? result.exit_code).toBe(0);
		expect(output).toContain("got:hello");
	});

	it("honors the PI_NO_PTY opt-out by using normal pipe execution", async () => {
		if (process.platform === "win32") return;
		const previous = process.env.PI_NO_PTY;
		process.env.PI_NO_PTY = "1";
		let output = "";
		try {
			const result = await createLocalBashOperations().exec("tty", testDir, { pty: true, onData: (chunk) => { output += chunk.toString(); } });
			expect(result.exitCode).not.toBe(0);
			expect(output).toContain("not a tty");
		} finally {
			if (previous === undefined) delete process.env.PI_NO_PTY;
			else process.env.PI_NO_PTY = previous;
		}
	});

	it("honors headless pty:true tool calls", async () => {
		if (process.platform === "win32") return;
		const result = await createBashToolDefinition(testDir).execute("headless-pty", { command: "[ -t 1 ] && echo tty || echo pipe", pty: true }, undefined, undefined, {} as never);
		if (result.content[0]?.text?.includes("Native PTY package")) return;
		expect(result.content[0]?.text).toContain("tty");
	});

	it("honors pty:true for async tool calls", async () => {
		if (process.platform === "win32") return;
		const bash = createBashToolDefinition(testDir, { asyncEnabled: true });
		const started = await bash.execute("async-pty", { command: "if [ -t 1 ]; then echo tty; else echo no; fi", pty: true, async: true }, undefined, undefined, {} as never);
		if (started.content[0]?.text?.includes("Native PTY package")) return;
		const jobId = started.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		let output = "";
		for (let attempt = 0; attempt < 20; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const polled = await bash.execute("async-pty-poll", { command: `__atomic_bash_job ${jobId}` }, undefined, undefined, {} as never);
			output = polled.content[0]?.text ?? "";
			if (output.includes("completed")) break;
		}
		expect(output).toContain("tty");
	});

	it("checks bashInterceptor before commandPrefix is prepended", async () => {
		const bash = createBashToolDefinition(testDir, { commandPrefix: "echo setup", interceptorEnabled: true, operations: { exec: async () => ({ exitCode: 0 }) } });
		await expect(bash.execute("prefix-intercept", { command: "cat file.txt" }, undefined, undefined, {} as never)).rejects.toThrow(/Use the read tool/);
	});

	it("honors dynamic bashInterceptor setting changes", async () => {
		let enabled = false;
		const bash = createBashToolDefinition(testDir, { interceptorEnabled: () => enabled, operations: { exec: async () => ({ exitCode: 0 }) } });
		await bash.execute("dynamic-off", { command: "cat file.txt" }, undefined, undefined, {} as never);
		enabled = true;
		await expect(bash.execute("dynamic-on", { command: "cat file.txt" }, undefined, undefined, {} as never)).rejects.toThrow(/Use the read tool/);
	});
	it("returns timeout and wall-time metadata for valid local execution", async () => {
		const bash = createBashToolDefinition(testDir, { operations: { exec: async () => ({ exitCode: 0 }) } });
		const result = await bash.execute("timing", { command: "true", timeout: 3600 }, undefined, undefined, {} as never);
		expect(result.details?.timeoutSeconds).toBe(3600);
		expect(result.details?.requestedTimeoutSeconds).toBeUndefined();
		expect(typeof result.details?.wallTimeMs).toBe("number");
	});


	it("reports pty timeouts with the normal bash timeout marker", async () => {
		if (process.platform === "win32") return;
		let thrown: unknown;
		try {
			await createLocalBashOperations().exec("sleep 2", testDir, { pty: true, timeout: 0.05, onData: () => {} });
		} catch (error) {
			thrown = error;
		}
		if (isNativeUnavailable(thrown)) return;
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("timeout:0.05");
	});
});
