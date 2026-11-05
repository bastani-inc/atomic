import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function recordingBash() {
	const dir = await mkdtemp(join(tmpdir(), "atomic-bash-cwd-"));
	tempDirs.push(dir);
	const seen = { command: "", cwd: "", env: "" };
	const bash = createBashToolDefinition(dir, {
		operations: {
			exec: async (command, cwd, { env, onData }) => {
				seen.command = command;
				seen.cwd = cwd;
				seen.env = env?.VALUE ?? "";
				onData(Buffer.from("ok"));
				return { exitCode: 0 };
			},
		},
	});
	const run = (args: { command: string; cwd?: string; env?: Record<string, string> }, ctx: object = {}) =>
		bash.execute("bash", args, undefined, undefined, ctx as ExtensionContext);
	return { dir, seen, run };
}

describe("bash working directory and internal URLs", () => {
	it("runs a command after a semicolon-separated leading cd in that directory", async () => {
		const { dir, seen, run } = await recordingBash();
		await run({ command: "cd sub; pwd" });
		expect(seen.command).toBe("pwd");
		expect(seen.cwd).toBe(join(dir, "sub"));
	});

	it("leaves a leading cd that needs shell expansion to the shell", async () => {
		const { dir, seen, run } = await recordingBash();
		await run({ command: 'cd "$PROJECT" && pwd' });
		expect(seen.command).toBe('cd "$PROJECT" && pwd');
		expect(seen.cwd).toBe(dir);
	});

	it("keeps a leading cd when cwd is given explicitly", async () => {
		const { dir, seen, run } = await recordingBash();
		await run({ command: "cd sub && pwd", cwd: "other" });
		expect(seen.command).toBe("cd sub && pwd");
		expect(seen.cwd).toBe(join(dir, "other"));
	});

	it("expands internal URLs in the command, cwd and env before execution", async () => {
		const { dir, seen, run } = await recordingBash();
		const ctx = {
			resolveInternalUrl: (url: string) =>
				url === "artifact://cmd"
					? join(dir, "cmd.txt")
					: url === "artifact://env"
						? join(dir, "env.txt")
						: undefined,
		};
		await run({ command: "cat artifact://cmd", cwd: "local://sub", env: { VALUE: "artifact://env" } }, ctx);
		expect(seen.command).toContain(`'${join(dir, "cmd.txt")}'`);
		expect(seen.cwd).toBe(join(dir, "sub"));
		expect(seen.env).toBe(join(dir, "env.txt"));
	});
});
