import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@bastani/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { hyperlink, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import type { ExtensionMode } from "../../src/core/extensions/context-types.ts";
import type { ExtensionCustomComponent, ExtensionUIContext } from "../../src/core/extensions/types.js";
import { KeybindingsManager } from "../../src/core/keybindings.js";
import { runMcpCommand } from "../../src/extensions/mcp/cli.ts";
import type { McpOAuthConfig, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { startOAuthMcpServer } from "./native-oauth-server.js";
import { createTestUiContext } from "./native-test-ui.js";

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn(async (_text: string) => {}) }));
vi.mock("../../src/utils/clipboard.js", () => ({ copyToClipboard }));
describe("AgentSession MCP OAuth", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(
		browser: "follow" | "paste",
		oauth?: McpOAuthConfig,
		mode: ExtensionMode = "print",
		uiOverrides: Partial<ExtensionUIContext> = {},
	) {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const backend = new InMemoryAuthStorageBackend();
		const entry: McpServerEntry = {
			name: "issues",
			config: { url: server.url, exposure: "direct", ...(oauth ? { oauth } : {}) },
			source: "test",
		};
		const notifications: string[] = [];
		const opened: URL[] = [];
		let redirectLocation: Promise<string> | undefined;
		const harness: Harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					credentials: new McpOAuthCredentialStore(backend),
					openUrl: (url) => {
						opened.push(new URL(url));
						if (browser === "follow") {
							// The browser follows the authorization redirect to the loopback callback.
							void fetch(url);
						} else {
							// The browser cannot reach the callback; the user pastes the redirect URL.
							redirectLocation = fetch(url, { redirect: "manual" }).then(
								(response) => response.headers.get("location") ?? "",
							);
						}
					},
				}),
			],
		});
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({
			mode,
			onError: (error) => notifications.push(JSON.stringify(error)),
			uiContext: createTestUiContext({
				notify: (message) => notifications.push(message),
				// The paste prompt waits until sign-in completes unless the user pastes the redirect URL.
				input: (_title, _placeholder, opts) =>
					browser === "paste"
						? Promise.resolve(redirectLocation)
						: new Promise((resolve) =>
								opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
							),
				...uiOverrides,
			}),
		});
		return { harness, server, notifications, backend, opened, getRedirectUrl: () => redirectLocation };
	}

	async function callWhoami(harness: Harness): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__issues__whoami", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const before = harness.session.messages.length;
		await harness.session.prompt("who am i");
		const result = harness.session.messages
			.slice(before)
			.find((message): message is ToolResultMessage => message.role === "toolResult");
		if (!result) throw new Error("no tool result");
		return result;
	}

	it("signs in through the browser, refreshes expired tokens, and signs out", async () => {
		const { harness, server, notifications, backend } = await setup("follow");

		await harness.session.prompt("/mcp");
		// Startup problems are reported once, pointing to /mcp.
		expect(notifications).toContain("MCP servers need attention:\n  issues: needs sign-in\nRun /mcp to fix.");
		expect(notifications.at(-1)).toBe("issues: needs sign-in, run /mcp login issues (direct)");

		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(server.log).toEqual(["401 none", "register", "token code"]);
		expect(backend.withLock((current) => ({ result: current }))).toContain('"access_token": "access-1"');

		expect(getMessageText(await callWhoami(harness))).toBe("token access-1");

		// An expired access token is refreshed without user interaction.
		server.expireAccessTokens();
		expect(getMessageText(await callWhoami(harness))).toBe("token access-2");
		expect(server.log.slice(-3)).toEqual(["401 access-1", "token refresh", "call access-2"]);

		// A token past its expiry is refreshed before the request, without a 401 round trip.
		backend.withLock((current) => {
			const states = JSON.parse(current ?? "{}") as Record<string, { tokensExpireAt?: number }>;
			for (const state of Object.values(states)) state.tokensExpireAt = Date.now() - 1_000;
			return { result: undefined, next: JSON.stringify(states) };
		});
		expect(getMessageText(await callWhoami(harness))).toBe("token access-3");
		expect(server.log.slice(-2)).toEqual(["token refresh", "call access-3"]);

		await harness.session.prompt("/mcp logout issues");
		expect(notifications.at(-1)).toBe('Signed out of MCP server "issues".');
		const result = await callWhoami(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe('MCP server "issues" requires sign-in. Run /mcp to sign in.');
	});
	it("#10186 shows a clickable sign-in URL in the manager and copies it before completing sign-in", async () => {
		initTheme("dark");
		let view: ExtensionCustomComponent | undefined;
		const tui = await setup("paste", undefined, "tui", {
			custom: (factory) =>
				new Promise((resolve) => {
					void Promise.resolve(
						factory({ requestRender: () => {} } as TUI, theme, new KeybindingsManager(), resolve),
					).then((component) => {
						view = component;
					});
				}),
		});
		const login = tui.harness.session.prompt("/mcp login issues");
		const rendered = () => view?.render(4096).join("\n") ?? "";
		await vi.waitFor(() => assert.ok(rendered().includes("to copy"), tui.notifications.join("\n")));
		const href = tui.opened[0].href;
		const hint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		assert.ok(rendered().includes("Sign in to issues"));
		assert.ok(rendered().includes(hyperlink(href, href)));
		assert.ok(rendered().includes(hyperlink(hint, href)));
		assert.ok(view?.handleInput);
		void view.handleInput("\x18");
		await vi.waitFor(() => assert.ok(rendered().includes("Copied URL to clipboard")));
		assert.deepEqual(copyToClipboard.mock.calls, [[href]]);
		const redirect = await tui.getRedirectUrl();
		assert.ok(redirect);
		void view.handleInput(redirect);
		void view.handleInput("\r");
		await login;
		assert.equal(getMessageText(await callWhoami(tui.harness)), "token access-1");
	});

	it("does not announce sign-in success when the TUI sign-in callback rejects", async () => {
		initTheme("dark");
		const tui = await setup("follow", undefined, "tui", {
			custom: (factory) =>
				new Promise((resolve) => {
					void factory(
						{
							requestRender: () => {
								throw new Error("Sign-in view failed to render");
							},
						} as TUI,
						theme,
						new KeybindingsManager(),
						resolve,
					);
				}),
		});

		await tui.harness.session.prompt("/mcp login issues");
		assert.ok(tui.notifications.includes("Sign-in view failed to render"));
		assert.equal(
			tui.notifications.some((message) => message.startsWith("Signed in")),
			false,
		);
	});

	it.each(["print", "rpc"] as const)("keeps the plain sign-in URL in %s mode", async (mode) => {
		const plain = await setup("follow", undefined, mode);
		await plain.harness.session.prompt("/mcp login issues");
		const plainShown = plain.notifications.find((message) => message.startsWith('Sign in to MCP server "issues"'));
		assert.equal(plainShown, `Sign in to MCP server "issues" in your browser:\n${plain.opened[0].href}`);
		assert.equal(getMessageText(await callWhoami(plain.harness)), "token access-1");
	});

	it("accepts a pasted redirect URL when the browser cannot reach the callback", async () => {
		const { harness, server, notifications } = await setup("paste");

		await harness.session.prompt("/mcp login");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(getMessageText(await callWhoami(harness))).toBe(`token access-1`);
		expect(server.log).toContain("token code");
	});

	async function freePort(): Promise<number> {
		return new Promise<number>((resolve) => {
			const probe = createServer().listen(0, "127.0.0.1", () => {
				const address = probe.address() as AddressInfo;
				probe.close(() => resolve(address.port));
			});
		});
	}

	it("uses the configured callback URL and scope", async () => {
		const callbackUrl = `http://localhost:${await freePort()}/callback`;
		const { harness, notifications, opened } = await setup("follow", { callbackUrl, scope: "issues:read" });

		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(opened[0].searchParams.get("redirect_uri")).toBe(callbackUrl);
		expect(opened[0].searchParams.get("scope")).toBe("issues:read");
		expect(getMessageText(await callWhoami(harness))).toBe("token access-1");
	});

	// #10226
	it("registers with the configured client name", async () => {
		const { harness, server, notifications } = await setup("follow", { clientName: "Claude Code" });
		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(server.registrations.map((metadata) => metadata.client_name)).toEqual(["Claude Code"]);

		const fallback = await setup("follow");
		await fallback.harness.session.prompt("/mcp login issues");
		expect(fallback.server.registrations.map((metadata) => metadata.client_name)).toEqual(["atomic"]);
	});

	it("adds the listening port to a callback URL without one", async () => {
		const { harness, notifications, opened } = await setup("follow", { callbackUrl: "http://127.0.0.1/oauth/done" });
		await harness.session.prompt("/mcp login issues");
		expect(notifications.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');
		expect(opened[0].searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/done$/);

		const port = await freePort();
		const fixed = await setup("follow", { callbackUrl: "http://127.0.0.1/oauth/done", callbackPort: port });
		await fixed.harness.session.prompt("/mcp login issues");
		expect(fixed.opened[0].searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/oauth/done`);
	});

	it("uses credentials from pi mcp login on the next turn", async () => {
		const { harness, server, backend } = await setup("follow");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-login-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { issues: { url: server.url } } }));

		// The agent runs `pi mcp login issues` through bash; the user approves in the browser.
		const output: string[] = [];
		const exitCode = await runMcpCommand(["login", "issues"], {
			cwd: agentDir,
			agentDir,
			credentials: new McpOAuthCredentialStore(backend),
			openUrl: (url) => void fetch(url),
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		expect(exitCode).toBe(0);
		expect(output.at(-1)).toBe('Signed in to MCP server "issues" (1 tools).');

		// The session still waits for a sign-in, and reconnects when the next turn starts.
		expect(getMessageText(await callWhoami(harness))).toBe("token access-1");
	});
});
