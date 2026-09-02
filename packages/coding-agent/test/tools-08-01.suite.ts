import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n") ?? ""
	);
}

function tagFrom(output: string): string {
	const tag = output.match(/#([0-9A-F]{4})/)?.[1];
	if (!tag) throw new Error(`missing hashline tag in output: ${output}`);
	return tag;
}

function fakeCtx(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

// Upstream pi #8627 ("use ctx.cwd for cwd-sensitive tools when available"). Upstream keeps these
// cases in `test/tools.test.ts`; in Atomic that file is a seven-line aggregator of `tools-NN-01`
// suites, so the block lands here and is registered from the aggregator.
describe("tool cwd resolution", () => {
	let testDir: string;
	// The factory cwd is deliberately unrelated to `testDir`, so a tool that ignored `ctx.cwd`
	// would resolve against it and fail rather than accidentally finding the fixture.
	let factoryDir: string;

	beforeEach(() => {
		const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		testDir = join(tmpdir(), `coding-agent-cwd-test-${stamp}`);
		factoryDir = join(tmpdir(), `coding-agent-cwd-factory-${stamp}`);
		mkdirSync(testDir, { recursive: true });
		mkdirSync(factoryDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		rmSync(factoryDir, { recursive: true, force: true });
	});

	it("read uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-read.txt"), "hello from ctx.cwd");
		const tool = createReadToolDefinition(factoryDir);
		const result = await tool.execute(
			"test-read-ctx-cwd",
			{ path: "ctx-cwd-read.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		expect(getTextOutput(result)).toContain("hello from ctx.cwd");
	});

	it("write uses ctx.cwd when provided", async () => {
		const tool = createWriteToolDefinition(factoryDir);
		await tool.execute(
			"test-write-ctx-cwd",
			{ path: "ctx-cwd-write.txt", content: "written via ctx.cwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		expect(readFileSync(join(testDir, "ctx-cwd-write.txt"), "utf-8")).toBe("written via ctx.cwd");
	});

	// Adapted: Atomic's edit tool is the hashline patcher, so the edit is a `[PATH#TAG]` script
	// whose tag comes from a read through the same snapshot store, not upstream's
	// `{ path, edits: [{ oldText, newText }] }` shape.
	it("edit uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-edit.txt");
		writeFileSync(testFile, "old text\n");
		const store = createHashlineSnapshotStore();
		const read = createReadToolDefinition(factoryDir, { hashlineStore: store });
		const edit = createEditToolDefinition(factoryDir, { hashlineStore: store });
		const ctx = fakeCtx(testDir);

		const tag = tagFrom(
			getTextOutput(await read.execute("read", { path: "ctx-cwd-edit.txt" }, undefined, undefined, ctx)),
		);
		await edit.execute(
			"test-edit-ctx-cwd",
			{ input: `[ctx-cwd-edit.txt#${tag}]\nreplace 1..1:\n+new text` },
			undefined,
			undefined,
			ctx,
		);

		expect(readFileSync(testFile, "utf-8")).toBe("new text\n");
	});

	it("grep uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-grep.txt"), "match in ctx.cwd");
		const tool = createGrepToolDefinition(factoryDir);
		const result = await tool.execute(
			"test-grep-ctx-cwd",
			{ pattern: "match" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		expect(getTextOutput(result)).toContain("ctx-cwd-grep.txt");
	});

	// Adapted: Atomic's find schema takes `paths: string[]`, not upstream's single `pattern`.
	it("find uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-find.txt"), "find me");
		const tool = createFindToolDefinition(factoryDir);
		const result = await tool.execute(
			"test-find-ctx-cwd",
			{ paths: ["ctx-cwd-find.txt"] },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		expect(getTextOutput(result)).toContain("ctx-cwd-find.txt");
	});

	it("ls uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-ls.txt"), "list me");
		const tool = createLsToolDefinition(factoryDir);
		const result = await tool.execute("test-ls-ctx-cwd", {}, undefined, undefined, fakeCtx(testDir));
		expect(getTextOutput(result)).toContain("ctx-cwd-ls.txt");
	});

	it("bash uses ctx.cwd when provided", async () => {
		const tool = createBashToolDefinition(factoryDir, { exposeSessionEnvironment: false });
		const result = await tool.execute(
			"test-bash-ctx-cwd",
			{ command: "pwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		// MSYS/Git Bash maps Windows temp directories to POSIX paths such as `/tmp`,
		// but the unique final segment still distinguishes the ctx cwd from factoryDir.
		expect(getTextOutput(result)).toContain(basename(testDir));
	});

	// The contract is `ctx?.cwd || cwd`, so the factory cwd must still win when no ctx arrives.
	// Added beyond the upstream block, which only covers the ctx-present direction.
	it("falls back to the factory cwd when no ctx is provided", async () => {
		writeFileSync(join(factoryDir, "factory-cwd-read.txt"), "hello from the factory cwd");
		const read = createReadToolDefinition(factoryDir);
		expect(getTextOutput(await read.execute("test-read-no-ctx", { path: "factory-cwd-read.txt" }))).toContain(
			"hello from the factory cwd",
		);

		const ls = createLsToolDefinition(factoryDir);
		expect(getTextOutput(await ls.execute("test-ls-no-ctx", {}))).toContain("factory-cwd-read.txt");

		const write = createWriteToolDefinition(factoryDir);
		await write.execute("test-write-no-ctx", { path: "factory-cwd-write.txt", content: "factory" });
		expect(readFileSync(join(factoryDir, "factory-cwd-write.txt"), "utf-8")).toBe("factory");
	});

	// Atomic-specific: the hashline patcher keeps per-cwd state (filesystem, patcher, no-op
	// counters, parallel-edit batcher), so two execution cwds must not share a scope.
	it("keeps edit scopes separate per execution cwd", async () => {
		writeFileSync(join(testDir, "same-name.txt"), "from ctx dir\n");
		writeFileSync(join(factoryDir, "same-name.txt"), "from factory dir\n");
		const store = createHashlineSnapshotStore();
		const read = createReadToolDefinition(factoryDir, { hashlineStore: store });
		const edit = createEditToolDefinition(factoryDir, { hashlineStore: store });
		const ctx = fakeCtx(testDir);

		const factoryTag = tagFrom(getTextOutput(await read.execute("read-factory", { path: "same-name.txt" })));
		await edit.execute("edit-factory", { input: `[same-name.txt#${factoryTag}]\nreplace 1..1:\n+factory edited` });

		const ctxTag = tagFrom(
			getTextOutput(await read.execute("read-ctx", { path: "same-name.txt" }, undefined, undefined, ctx)),
		);
		await edit.execute(
			"edit-ctx",
			{ input: `[same-name.txt#${ctxTag}]\nreplace 1..1:\n+ctx edited` },
			undefined,
			undefined,
			ctx,
		);

		expect(readFileSync(join(factoryDir, "same-name.txt"), "utf-8")).toBe("factory edited\n");
		expect(readFileSync(join(testDir, "same-name.txt"), "utf-8")).toBe("ctx edited\n");
	});

	// `search`, not `grep`, is the invokable Atomic builtin: `grep` is absent from `ToolName` and
	// is not SDK-exported, so an extension only ever reaches content search through `search`.
	// `search` is an Atomic-owned wrapper with no upstream counterpart, so upstream #8627 could
	// not have covered it.
	it("search uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-only.txt"), "NEEDLE in the ctx root\n");
		const search = createSearchToolDefinition(factoryDir);

		const result = await search.execute(
			"test-search-ctx-cwd",
			{ pattern: "NEEDLE", paths: "ctx-only.txt:1" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);

		expect(getTextOutput(result)).toContain("NEEDLE in the ctx root");
	});

	// The decisive case. `search` stamps hashline tags on the content it returns, so if the
	// content comes from `ctx.cwd` while the tag is computed against the factory cwd, `edit`
	// rejects a tag `search` just issued and the search-then-edit round-trip is broken.
	it("search and edit agree on hashline tags across execution cwds", async () => {
		writeFileSync(join(factoryDir, "target.txt"), "decoy NEEDLE factory\n");
		writeFileSync(join(testDir, "target.txt"), "real NEEDLE ctx\n");
		const store = createHashlineSnapshotStore();
		const search = createSearchToolDefinition(factoryDir, { hashlineStore: store });
		const edit = createEditToolDefinition(factoryDir, { hashlineStore: store });
		const ctx = fakeCtx(testDir);

		const output = getTextOutput(
			await search.execute("search-ctx", { pattern: "NEEDLE", paths: "target.txt" }, undefined, undefined, ctx),
		);
		expect(output).toContain("real NEEDLE ctx");
		expect(output).not.toContain("decoy NEEDLE factory");

		await edit.execute(
			"edit-after-search",
			{ input: `[target.txt#${tagFrom(output)}]\nreplace 1..1:\n+edited via search tag` },
			undefined,
			undefined,
			ctx,
		);

		expect(readFileSync(join(testDir, "target.txt"), "utf-8")).toBe("edited via search tag\n");
		expect(readFileSync(join(factoryDir, "target.txt"), "utf-8")).toBe("decoy NEEDLE factory\n");
	});

	// powershell spreads its definition from createBashToolDefinition, so it inherits the same
	// executionCwd. Injected operations keep this runnable where pwsh is absent.
	it("powershell uses ctx.cwd when provided", async () => {
		const seen: string[] = [];
		const operations: BashOperations = {
			exec: async (_command, execCwd, { onData }) => {
				seen.push(execCwd);
				onData(Buffer.from(execCwd), "stdout");
				return { exitCode: 0 };
			},
		};

		const tool = createPowerShellToolDefinition(factoryDir, { operations, exposeSessionEnvironment: false });
		await tool.execute("test-pwsh-ctx-cwd", { command: "pwd" }, undefined, undefined, fakeCtx(testDir));
		await tool.execute("test-pwsh-no-ctx", { command: "pwd" });

		expect(seen).toEqual([testDir, factoryDir]);
	});
});
