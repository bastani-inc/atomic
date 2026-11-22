import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { runAuthCommand } from "../src/cli/auth-cli.ts";
import { runBlueprintCommand } from "../src/cli/blueprint-command.ts";
import { runIntercomCommand } from "../src/cli/intercom-command.ts";
import { runStorageCommand } from "../src/cli/storage-command.ts";
import { runTeamCommand } from "../src/cli/team-command.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import { handleConfigCommand } from "../src/package-manager-cli.ts";
import { handlePackageCommandParseOutcome, parsePackageCommand } from "../src/package-manager-cli-parser.ts";

const tempDirs: string[] = [];

afterEach(() => {
	process.exitCode = undefined;
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI subcommand and sub-subcommand --help / -h sweep", () => {
	test.each([
		["install", "--help"],
		["install", "-h"],
		["remove", "--help"],
		["remove", "-h"],
		["uninstall", "--help"],
		["uninstall", "-h"],
		["update", "--help"],
		["update", "-h"],
		["list", "--help"],
		["list", "-h"],
	])("package command %s %s prints help to stdout and exits 0", (subcommand, flag) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.map(String).join(" ")));
		vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.map(String).join(" ")));

		const parsed = parsePackageCommand([subcommand, flag]);
		assert.ok(parsed);
		assert.equal(handlePackageCommandParseOutcome(parsed), true);
		assert.equal(process.exitCode ?? 0, 0);
		assert.match(stdout.join("\n"), /Usage:/);
		assert.equal(stderr.join(""), "");
	});

	test.each(["--help", "-h"])("config %s prints help to stdout and exits 0", async (flag) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.map(String).join(" ")));
		vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.map(String).join(" ")));

		const handled = await handleConfigCommand(["config", flag]);
		assert.equal(handled, true);
		assert.equal(process.exitCode ?? 0, 0);
		assert.match(stdout.join("\n"), /Usage:/);
		assert.equal(stderr.join(""), "");
	});

	test.each([
		[["auth"]],
		[["auth", "help"]],
		[["auth", "--help"]],
		[["auth", "-h"]],
		[["auth", "login", "--help"]],
		[["auth", "login", "-h"]],
		[["auth", "logout", "--help"]],
		[["auth", "logout", "-h"]],
		[["auth", "print-api-key", "--help"]],
		[["auth", "print-api-key", "-h"]],
		[["auth", "print-bearer-token", "--help"]],
		[["auth", "print-bearer-token", "-h"]],
		[["auth", "check", "--help"]],
		[["auth", "check", "-h"]],
	])("auth command %j prints help to stderr with empty stdout and exits 0", async (argv) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.map(String).join(" ")));
		vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.map(String).join(" ")));

		const handled = await runAuthCommand(argv);
		assert.equal(handled, true);
		assert.equal(process.exitCode ?? 0, 0);
		assert.equal(stdout.join(""), "");
		assert.match(stderr.join("\n"), /Usage:\n\s+atomic auth login/);
	});

	test.each([
		[[]],
		[["help"]],
		[["--help"]],
		[["-h"]],
		[["add", "--help"]],
		[["add", "-h"]],
		[["add", "demo", "--help"]],
		[["remove", "--help"]],
		[["remove", "-h"]],
		[["list", "--help"]],
		[["list", "-h"]],
		[["login", "--help"]],
		[["login", "-h"]],
		[["logout", "--help"]],
		[["logout", "-h"]],
	])("mcp %j prints help to stdout and exits 0", async (args) => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-help-mcp-"));
		tempDirs.push(dir);
		const stdout: string[] = [];
		const stderr: string[] = [];

		const exitCode = await runMcpCommand(args, {
			cwd: dir,
			agentDir: join(dir, "agent"),
			log: (line) => stdout.push(line),
			error: (line) => stderr.push(line),
		});
		assert.equal(exitCode, 0);
		assert.match(stdout.join("\n"), /Usage:/);
		assert.equal(stderr.join(""), "");
	});

	test("mcp add passes --help after -- to the server command instead of printing MCP help", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-help-mcp-add-"));
		tempDirs.push(dir);
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const stdout: string[] = [];
		const stderr: string[] = [];

		const exitCode = await runMcpCommand(["add", "demo", "--", "my-mcp-bin", "--help"], {
			cwd: dir,
			agentDir,
			log: (line) => stdout.push(line),
			error: (line) => stderr.push(line),
		});
		assert.equal(exitCode, 0, stderr.join("\n"));
		assert.equal(stderr.join(""), "");
		const saved = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")) as {
			mcpServers: Record<string, { command: string; args?: string[] }>;
		};
		assert.deepEqual(saved.mcpServers.demo, { command: "my-mcp-bin", args: ["--help"] });
	});

	test("mcp add passes --help as --description value instead of printing MCP help", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-help-mcp-desc-"));
		tempDirs.push(dir);
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const stdout: string[] = [];
		const stderr: string[] = [];

		const exitCode = await runMcpCommand(["add", "demo", "--description", "--help", "--url", "https://example.com"], {
			cwd: dir,
			agentDir,
			log: (line) => stdout.push(line),
			error: (line) => stderr.push(line),
		});
		assert.equal(exitCode, 0, stderr.join("\n"));
		assert.equal(stderr.join(""), "");
		const saved = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")) as {
			mcpServers: Record<string, { url: string; description?: string }>;
		};
		assert.deepEqual(saved.mcpServers.demo, { url: "https://example.com", description: "--help" });
	});

	test.each([
		[[]],
		[["help"]],
		[["--help"]],
		[["-h"]],
		[["status", "--help"]],
		[["status", "-h"]],
		[["join", "--help"]],
		[["join", "-h"]],
		[["migrate", "--help"]],
		[["migrate", "-h"]],
		[["move-snapshot-chunks", "--help"]],
		[["move-snapshot-chunks", "-h"]],
		[["export", "--help"]],
		[["export", "-h"]],
		[["import", "--help"]],
		[["import", "-h"]],
		[["search-session", "--help"]],
		[["search-session", "-h"]],
	])("storage %j prints help to stdout and exits 0", async (args) => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-help-storage-"));
		tempDirs.push(dir);
		const stdout: string[] = [];
		const stderr: string[] = [];

		const exitCode = await runStorageCommand(args, {
			cwd: dir,
			agentDir: join(dir, "agent"),
			log: (line) => stdout.push(line),
			error: (line) => stderr.push(line),
		});
		assert.equal(exitCode, 0);
		assert.match(stdout.join("\n"), /Usage:/);
		assert.equal(stderr.join(""), "");
	});

	test.each([
		[[]],
		[["help"]],
		[["--help"]],
		[["-h"]],
		[["join", "--help"]],
		[["join", "-h"]],
		[["status", "--help"]],
		[["status", "-h"]],
		[["leave", "--help"]],
		[["leave", "-h"]],
	])("team %j prints help to stdout and exits 0", async (args) => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-help-team-"));
		tempDirs.push(dir);
		const stdout: string[] = [];
		const stderr: string[] = [];

		const exitCode = await runTeamCommand(args, {
			cwd: dir,
			agentDir: join(dir, "agent"),
			log: (line) => stdout.push(line),
			error: (line) => stderr.push(line),
		});
		assert.equal(exitCode, 0);
		assert.match(stdout.join("\n"), /Usage:/);
		assert.equal(stderr.join(""), "");
	});

	test.each([
		[[]],
		[["help"]],
		[["--help"]],
		[["-h"]],
		[["status", "--help"]],
		[["status", "-h"]],
		[["restart", "--help"]],
		[["restart", "-h"]],
		[["upgrade", "--help"]],
		[["upgrade", "-h"]],
	])("intercom %j prints help to stdout and exits 0", async (args) => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-help-intercom-"));
		tempDirs.push(dir);
		const stdout: string[] = [];
		const stderr: string[] = [];

		const exitCode = await runIntercomCommand(args, {
			agentDir: join(dir, "agent"),
			log: (line) => stdout.push(line),
			error: (line) => stderr.push(line),
		});
		assert.equal(exitCode, 0);
		assert.match(stdout.join("\n"), /Usage:/);
		assert.equal(stderr.join(""), "");
	});

	test.each([
		[[]],
		[["help"]],
		[["--help"]],
		[["-h"]],
		[["cache-key", "--help"]],
		[["cache-key", "-h"]],
		[["prebuild", "--help"]],
		[["prebuild", "-h"]],
	])("blueprint %j prints help to stdout and exits 0", async (args) => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-help-blueprint-"));
		tempDirs.push(dir);
		const stdout: string[] = [];
		const stderr: string[] = [];

		const exitCode = await runBlueprintCommand(args, {
			cwd: dir,
			agentDir: join(dir, "agent"),
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
		});
		assert.equal(exitCode, 0);
		assert.match(stdout.join(""), /Usage:/);
		assert.equal(stderr.join(""), "");
	});
});
