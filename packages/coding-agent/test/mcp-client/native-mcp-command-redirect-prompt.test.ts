import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage-backends.js";
import { runMcpCommand } from "../../src/extensions/mcp/cli.js";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.js";
import { startOAuthMcpServer } from "./native-oauth-server.js";

const { openBrowser } = vi.hoisted(() => ({ openBrowser: vi.fn((_url: string) => {}) }));
vi.mock("../../src/utils/open-browser.js", () => ({ openBrowser }));

const PASTE_PROMPT = "If the browser cannot reach this machine, paste the URL it was redirected to: ";

describe("atomic mcp login in a terminal", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		openBrowser.mockReset();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/** `atomic mcp login issues` with stdin as a terminal, so the paste prompt is shown. */
	async function login(stdin: object) {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-mcp-login-prompt-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { issues: { url: server.url } } }));
		vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as typeof process.stdin);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const output: string[] = [];
		const exitCode = await runMcpCommand(["login", "issues", "--timeout", "60"], {
			cwd: agentDir,
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		const prompts = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
		return { exitCode, output, prompts };
	}

	function terminalInput() {
		const input = Object.assign(new PassThrough(), { isTTY: true });
		cleanups.push(() => void input.destroy());
		return input;
	}

	it("finishes the sign-in with the redirect URL pasted on stderr's prompt", async () => {
		const input = terminalInput();
		openBrowser.mockImplementation((url) => {
			void fetch(url, { redirect: "manual" }).then((response) => {
				input.write(`${response.headers.get("location")}\n`);
			});
		});

		const { exitCode, output, prompts } = await login(input);

		assert.equal(exitCode, 0, output.join("\n"));
		assert.equal(output.at(-1), 'Signed in to MCP server "issues" (1 tools).');
		assert.ok(prompts.includes(PASTE_PROMPT), prompts);
		assert.equal(openBrowser.mock.calls.length, 1);
	});

	it("cancels the sign-in at once when stdin ends", async () => {
		const input = terminalInput();
		// The prompt starts right after the URL is shown; stdin ends while it waits.
		openBrowser.mockImplementation(() => setImmediate(() => input.end()));

		const { exitCode, output } = await login(input);

		assert.equal(exitCode, 1);
		assert.equal(output.at(-1), 'Sign-in to MCP server "issues" was cancelled or not completed within 60 seconds.');
	});

	it("reports a terminal that cannot be read instead of treating it as a cancellation", async () => {
		const { exitCode, output } = await login({ isTTY: true });

		assert.equal(exitCode, 1);
		assert.match(output.at(-1) ?? "", /^Sign-in to MCP server "issues" failed: /u);
		assert.doesNotMatch(output.at(-1) ?? "", /cancelled/u);
	});
});
