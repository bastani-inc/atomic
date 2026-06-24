import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";

const tempDirs: string[] = [];
async function createTempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "atomic-bash-intercept-")); tempDirs.push(dir); return dir; }
function text(result: { content: Array<{ type: string; text?: string }> }): string { return result.content.map((item) => item.text ?? "").join("\n"); }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("bash interceptor parity", () => {
	it("does not run an interceptor unless it is explicitly configured", async () => {
		const dir = await createTempDir();
		let calls = 0;
		const bash = createBashToolDefinition(dir, {
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("local")); return { exitCode: 0 }; } },
		});
		const output = text(await bash.execute("bash-1", { command: "echo local" }, undefined, undefined, {} as ExtensionContext));
		expect(calls).toBe(0);
		expect(output).toBe("local");
	});

	it("honors cwd/env inputs and built-in interception when enabled", async () => {
		const dir = await createTempDir();
		let seenCwd = "";
		let seenEnv = "";
		const bash = createBashToolDefinition(dir, {
			interceptorEnabled: true,
			operations: { exec: async (_command, cwd, { onData, env }) => { seenCwd = cwd; seenEnv = env?.VALUE ?? ""; onData(Buffer.from("ok")); return { exitCode: 0 }; } },
		});
		await expect(bash.execute("bash-block", { command: "cat file.txt" }, undefined, undefined, {} as ExtensionContext)).rejects.toThrow(/Use the read tool/);
		const output = text(await bash.execute("bash-cwd", { command: "echo ok", cwd: "sub", env: { VALUE: "set" } }, undefined, undefined, {} as ExtensionContext));
		expect(seenCwd).toBe(join(dir, "sub"));
		expect(seenEnv).toBe("set");
		expect(output).toBe("ok");
		await expect(bash.execute("bash-bad-env", { command: "echo ok", env: { "BAD-NAME": "x" } }, undefined, undefined, {} as ExtensionContext)).rejects.toThrow(/Invalid bash env name/);
	});

	it("does not block rules for unavailable tools and rejects unsupported runtime modes", async () => {
		const dir = await createTempDir();
		const bash = createBashToolDefinition(dir, {
			interceptorEnabled: true,
			availableTools: ["bash"],
			asyncEnabled: true,
			operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("allowed")); return { exitCode: 0 }; } },
		});
		expect(text(await bash.execute("bash-cat", { command: "cat file.txt" }, undefined, undefined, {} as ExtensionContext))).toBe("allowed");
		const asyncResult = await bash.execute("bash-async", { command: "echo hi", async: true }, undefined, undefined, {} as ExtensionContext);
		expect(asyncResult.details?.async?.jobId).toBeTruthy();
		expect(text(await bash.execute("bash-custom-pty", { command: "echo hi", pty: true }, undefined, undefined, {} as ExtensionContext))).toBe("allowed");
		expect(text(await createBashToolDefinition(dir).execute("bash-pty", { command: "echo hi", pty: true }, undefined, undefined, {} as ExtensionContext)).trim()).toBe("hi");
	});

	it("runs an explicitly configured interceptor before local execution", async () => {
		const dir = await createTempDir();
		let interceptedCommand = "";
		const bash = createBashToolDefinition(dir, {
			interceptor: (context) => {
				interceptedCommand = context.command;
				return { result: { output: "intercepted", exitCode: 0, cancelled: false, truncated: false } };
			},
		});
		const output = text(await bash.execute("bash-1", { command: "echo local" }, undefined, undefined, {} as ExtensionContext));
		expect(interceptedCommand).toBe("echo local");
		expect(output).toBe("intercepted");
	});

	it("executes custom operations with the accepted cd-stripped interceptor context", async () => {
		const dir = await createTempDir();
		let execCommand = "";
		let execCwd = "";
		const bash = createBashToolDefinition(dir, {
			interceptor: (context) => context.command === "pwd" ? { operations: { exec: async (command, cwd, { onData }) => { execCommand = command; execCwd = cwd; onData(Buffer.from(cwd)); return { exitCode: 0 }; } } } : undefined,
		});
		await bash.execute("bash-1", { command: "cd sub && pwd" }, undefined, undefined, {} as ExtensionContext);
		expect(execCommand).toBe("pwd");
		expect(execCwd).toBe(join(dir, "sub"));
	});

	it("executes semicolon separated leading cd with the stripped cwd", async () => {
		const dir = await createTempDir();
		let execCommand = "";
		let execCwd = "";
		const bash = createBashToolDefinition(dir, {
			interceptor: (context) => context.command === "pwd" ? { operations: { exec: async (command, cwd, { onData }) => { execCommand = command; execCwd = cwd; onData(Buffer.from(cwd)); return { exitCode: 0 }; } } } : undefined,
		});
		await bash.execute("bash-cd-semicolon", { command: "cd sub; pwd" }, undefined, undefined, {} as ExtensionContext);
		expect(execCommand).toBe("pwd");
		expect(execCwd).toBe(join(dir, "sub"));
	});

	it("does not rewrite leading cd paths that require shell expansion", async () => {
		const dir = await createTempDir();
		let execCommand = "";
		let execCwd = "";
		const bash = createBashToolDefinition(dir, { operations: { exec: async (command, cwd, { onData }) => { execCommand = command; execCwd = cwd; onData(Buffer.from("ok")); return { exitCode: 0 }; } } });
		await bash.execute("bash-shell-expanded-cd", { command: "cd \"$PROJECT\" && pwd" }, undefined, undefined, {} as ExtensionContext);
		expect(execCommand).toBe("cd \"$PROJECT\" && pwd");
		expect(execCwd).toBe(dir);
	});


	it("does not rewrite leading cd when cwd is explicit", async () => {
		const dir = await createTempDir();
		let execCommand = "";
		let execCwd = "";
		const bash = createBashToolDefinition(dir, { operations: { exec: async (command, cwd, { onData }) => { execCommand = command; execCwd = cwd; onData(Buffer.from("ok")); return { exitCode: 0 }; } } });
		await bash.execute("bash-explicit-cwd", { command: "cd sub && pwd", cwd: "other" }, undefined, undefined, {} as ExtensionContext);
		expect(execCommand).toBe("cd sub && pwd");
		expect(execCwd).toBe(join(dir, "other"));
	});

	it("checks bash interceptor rules before internal URL expansion", async () => {
		const dir = await createTempDir();
		const bash = createBashToolDefinition(dir, { interceptorEnabled: true, interceptorRules: [{ pattern: "artifact://secret", tool: "read", message: "raw internal URL blocked" }], operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("unexpected")); return { exitCode: 0 }; } } });
		const ctx = { resolveInternalUrl: (url: string) => url === "artifact://secret" ? join(dir, "secret.txt") : undefined };
		await expect(bash.execute("bash-raw-intercept", { command: "echo artifact://secret" }, undefined, undefined, ctx as ExtensionContext)).rejects.toThrow(/raw internal URL blocked/);
	});

	it("checks built-in interceptor rules after internal URL expansion", async () => {
		const dir = await createTempDir();
		const secret = join(dir, "secret.txt");
		const bash = createBashToolDefinition(dir, { interceptorEnabled: true, interceptorRules: [{ pattern: "secret\\.txt", tool: "read", message: "expanded internal URL blocked" }], operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("unexpected")); return { exitCode: 0 }; } } });
		const ctx = { resolveInternalUrl: (url: string) => url === "artifact://secret" ? secret : undefined };
		await expect(bash.execute("bash-expanded-intercept", { command: "echo artifact://secret" }, undefined, undefined, ctx as ExtensionContext)).rejects.toThrow(/expanded internal URL blocked/);
	});

	it("checks built-in interceptor rules despite command prefixes", async () => {
		const dir = await createTempDir();
		const bash = createBashToolDefinition(dir, { commandPrefix: "echo setup", interceptorEnabled: true, operations: { exec: async (_command, _cwd, { onData }) => { onData(Buffer.from("unexpected")); return { exitCode: 0 }; } } });
		await expect(bash.execute("bash-prefix-intercept", { command: "cat file.txt" }, undefined, undefined, {} as ExtensionContext)).rejects.toThrow(/Use the read tool/);
	});
	it("expands internal URLs in command cwd and env before execution", async () => {
		const dir = await createTempDir();
		let seenCommand = "";
		let seenCwd = "";
		let seenEnv = "";
		const bash = createBashToolDefinition(dir, { operations: { exec: async (command, cwd, { env, onData }) => { seenCommand = command; seenCwd = cwd; seenEnv = env?.VALUE ?? ""; onData(Buffer.from("ok")); return { exitCode: 0 }; } } });
		const ctx = { resolveInternalUrl: (url: string) => url === "artifact://cmd" ? join(dir, "cmd.txt") : url === "artifact://env" ? join(dir, "env.txt") : undefined };
		await bash.execute("bash-url", { command: "cat artifact://cmd", cwd: "local://sub", env: { VALUE: "artifact://env" } }, undefined, undefined, ctx as ExtensionContext);
		expect(seenCommand).toContain(`'${join(dir, "cmd.txt")}'`);
		expect(seenCwd).toBe(join(dir, "sub"));
		expect(seenEnv).toBe(join(dir, "env.txt"));
	});
});
