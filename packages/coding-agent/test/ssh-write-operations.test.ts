import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import sshExtension from "../examples/extensions/ssh.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";

const remote = vi.hoisted(() => ({ cwd: "" }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: string[], options: import("node:child_process").SpawnOptions) => {
			if (command !== "ssh") return actual.spawn(command, args, options);
			assert.equal(args[0], "fixture-host");
			// Run the remote shell command locally, translating the fixture host's namespace into a temp directory.
			const shellCommand = args[1]
				.replaceAll("\\\\", "/")
				.replaceAll("/ssh-fixture", remote.cwd.replaceAll("\\", "/"));
			return actual.spawn("bash", ["-c", shellCommand], { ...options, cwd: remote.cwd });
		},
	};
});

type SessionStart = (event: { type: "session_start" }, ctx: ExtensionContext) => Promise<void>;

async function remoteTools(remoteCwd = "/ssh-fixture") {
	const tools: ToolDefinition[] = [];
	let start: SessionStart | undefined;
	sshExtension({
		registerFlag: () => {},
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		getFlag: () => `fixture-host:${remoteCwd}`,
		on: (event: string, handler: SessionStart) => {
			if (event === "session_start") start = handler;
		},
	} as unknown as ExtensionAPI);
	assert.ok(start);
	const ctx = {
		ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_color: string, text: string) => text } },
	} as unknown as ExtensionContext;
	await start({ type: "session_start" }, ctx);
	const tool = (name: string) => {
		const found = tools.find((entry) => entry.name === name);
		assert.ok(found);
		return found;
	};
	return { tool, ctx };
}

describe("SSH example write and edit operations", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "atomic-ssh-write-"));
		remote.cwd = dir;
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates an absent file in newly created remote parents", async () => {
		const { tool, ctx } = await remoteTools();
		await tool("write").execute(
			"create",
			{ path: "new/parents/fresh.txt", content: "fresh bytes\n" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(await readFile(join(dir, "new/parents/fresh.txt"), "utf8"), "fresh bytes\n");
	});

	it("overwrites a remote file without reading it first (#4328)", async () => {
		const { tool, ctx } = await remoteTools();
		await writeFile(join(dir, "existing.txt"), "remote bytes\n");
		await tool("write").execute(
			"overwrite",
			{ path: "existing.txt", content: "replacement\n" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(await readFile(join(dir, "existing.txt"), "utf8"), "replacement\n");
	});

	it("edits a remote file by exact text after it changed remotely (#4328)", async () => {
		const { tool, ctx } = await remoteTools();
		await writeFile(join(dir, "edited.txt"), "original\n");
		await tool("read").execute("read", { path: "edited.txt" }, undefined, undefined, ctx);
		await writeFile(join(dir, "edited.txt"), "changed remotely\n");
		await tool("edit").execute(
			"edit",
			{ path: "edited.txt", edits: [{ oldText: "changed remotely", newText: "edited" }] },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(await readFile(join(dir, "edited.txt"), "utf8"), "edited\n");
	});

	it("resolves paths against a relative remote working directory", async () => {
		await mkdir(join(dir, "relative"));
		await writeFile(join(dir, "relative/existing.txt"), "retained bytes\n");
		const { tool, ctx } = await remoteTools("relative");
		await tool("write").execute(
			"relative",
			{ path: "existing.txt", content: "replacement\n" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(await readFile(join(dir, "relative/existing.txt"), "utf8"), "replacement\n");
	});
});
