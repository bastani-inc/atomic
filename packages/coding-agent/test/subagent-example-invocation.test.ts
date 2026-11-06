import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { APP_NAME } from "../src/config.js";

useTemporaryAgentDir();

const spawned = vi.hoisted(() => ({ calls: [] as { command: string; args: string[] }[] }));
const existingPaths = vi.hoisted(() => new Set<string>());

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		spawn: (command: string, args: string[]) => {
			spawned.calls.push({ command, args });
			const proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				killed: false,
				kill: () => true,
			});
			queueMicrotask(() => proc.emit("close", 0));
			return proc;
		},
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	const existsSync = (target: Parameters<typeof original.existsSync>[0]) =>
		(typeof target === "string" && existingPaths.has(target)) || original.existsSync(target);
	return { ...original, default: { ...original, existsSync }, existsSync };
});

const { runSingleAgent } = await import("../examples/extensions/subagent/runner.js");

const agent = {
	name: "worker",
	description: "test worker",
	systemPrompt: "",
	source: "user" as const,
	filePath: "worker.md",
};

async function invocationFor(entryScript: string | undefined): Promise<{ command: string; args: string[] }> {
	const previousArgv = [...process.argv];
	process.argv.length = 1;
	if (entryScript !== undefined) {
		existingPaths.add(entryScript);
		process.argv.push(entryScript);
	}
	try {
		spawned.calls.length = 0;
		await runSingleAgent(process.cwd(), [agent], "worker", "say hi", undefined, undefined, undefined, (results) => ({
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results,
		}));
		expect(spawned.calls).toHaveLength(1);
		return spawned.calls[0];
	} finally {
		process.argv.splice(0, process.argv.length, ...previousArgv);
	}
}

describe("subagent example child invocation", () => {
	afterEach(() => {
		existingPaths.clear();
	});

	test.each([
		"B:/~BUN/root/atomic.exe",
		"B:\\~BUN\\root\\atomic.exe",
		"b:/~BUN\\root/atomic.exe",
		"/$bunfs/root/atomic",
	])("does not pass the Bun virtual entry %s to the child (#11865)", async (entryScript) => {
		const invocation = await invocationFor(entryScript);
		expect(invocation.args).not.toContain(entryScript);
		expect(invocation.args.slice(0, 4)).toEqual(["--mode", "json", "-p", "--no-session"]);
		expect(invocation.args.at(-1)).toBe("Task: say hi");
	});

	test.each([
		"/home/user/atomic/dist/cli.js",
		"C:/projects/~BUN/root/cli.js",
		"C:/~BUNDLE/root/cli.js",
		"1:/~BUN/root/cli.js",
		"/home/user/c:/~BUN/root/cli.js",
	])("runs a real entry script %s with the current runtime", async (entryScript) => {
		const invocation = await invocationFor(entryScript);
		expect(invocation.command).toBe(process.execPath);
		expect(invocation.args[0]).toBe(entryScript);
		expect(invocation.args.slice(1, 5)).toEqual(["--mode", "json", "-p", "--no-session"]);
	});

	test("runs the app by name when there is no entry script", async () => {
		const invocation = await invocationFor(undefined);
		expect(invocation.command).toBe(APP_NAME);
		expect(invocation.args.slice(0, 4)).toEqual(["--mode", "json", "-p", "--no-session"]);
	});
});
