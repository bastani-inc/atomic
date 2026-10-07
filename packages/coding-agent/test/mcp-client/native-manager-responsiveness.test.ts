import assert from "node:assert/strict";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.js";
import type { ExtensionCustomComponent } from "../../src/core/extensions/types.js";
import { KeybindingsManager } from "../../src/core/keybindings.js";
import { TransportEvents } from "../../src/extensions/mcp/client/transports/transport.js";
import { createMcpExtension } from "../../src/extensions/mcp/index.js";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.js";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.js";
import { createHarness } from "../suite/harness.js";
import { createTestUiContext } from "./native-test-ui.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("native MCP manager responsiveness", () => {
	it.each([true, false])(
		"keeps the manager usable while enabled=%s connection work is pending (#10562)",
		async (enabled) => {
			initTheme("dark");
			const release = deferred();
			let started = false;
			let view: ExtensionCustomComponent | undefined;
			class WaitingTransport extends TransportEvents {
				async start() {
					started = true;
					await release.promise;
					throw new Error("connection released");
				}
				async send() {}
				async close() {
					await release.promise;
				}
			}
			const harness = await createHarness({
				initialActiveToolNames: [],
				extensionFactories: [
					createMcpExtension({
						loadConfig: () => ({
							servers: [{ name: "waiting", source: "test", config: { command: "unused", enabled } }],
							errors: [],
						}),
						credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
						createTransport: () => new WaitingTransport(),
						updateConfig: () => {},
					}),
				],
			});
			try {
				await harness.session.bindExtensions({
					mode: "tui",
					uiContext: createTestUiContext({
						custom: (factory) =>
							new Promise((resolve) => {
								void Promise.resolve(
									factory({ requestRender: () => {} } as TUI, theme, new KeybindingsManager(), resolve),
								).then((component) => {
									view = component;
								});
							}),
					}),
				});
				const manager = harness.session.prompt("/mcp");
				const rendered = () => view?.render(160).join("\n") ?? "";
				await vi.waitFor(() => assert.match(rendered(), /MCP servers/));
				assert.ok(view?.handleInput);
				view.handleInput("\r");
				await vi.waitFor(() => assert.match(rendered(), /MCP server waiting/));
				if (enabled) {
					await vi.waitFor(() => assert.equal(started, true));
					view.handleInput("\x1b[B");
				}
				view.handleInput("\r");
				await vi.waitFor(() => assert.match(rendered(), enabled ? /disabled/ : /connecting/));
				if (!enabled) await vi.waitFor(() => assert.equal(started, true));
				view.handleInput("\x1b");
				await vi.waitFor(() => assert.match(rendered(), /MCP servers/));
				view.handleInput("\x1b");
				await manager;
			} finally {
				release.resolve();
				await harness.cleanup();
			}
		},
	);
	it.each(["replacement", "shutdown"])("allows %s after closing a still-pending startup", async (action) => {
		initTheme("dark");
		const release = deferred();
		let starts = 0;
		let closes = 0;
		let view: ExtensionCustomComponent | undefined;
		class StuckTransport extends TransportEvents {
			async start() {
				starts++;
				if (starts === 1) await release.promise;
				throw new Error("startup released");
			}
			async send() {}
			async close() {
				closes++;
			}
		}
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({
						servers: [{ name: "stuck", source: "test", config: { command: "unused" } }],
						errors: [],
					}),
					credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
					createTransport: () => new StuckTransport(),
					updateConfig: () => {},
				}),
			],
		});
		let manager: Promise<void> | undefined;
		try {
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createTestUiContext({
					custom: (factory) =>
						new Promise((resolve) => {
							void Promise.resolve(
								factory({ requestRender: () => {} } as TUI, theme, new KeybindingsManager(), resolve),
							).then((component) => {
								view = component;
							});
						}),
				}),
			});
			manager = harness.session.prompt("/mcp");
			const rendered = () => view?.render(160).join("\n") ?? "";
			await vi.waitFor(() => assert.match(rendered(), /MCP servers/));
			await vi.waitFor(() => assert.equal(starts, 1));
			assert.ok(view?.handleInput);
			view.handleInput("\r");
			await vi.waitFor(() => assert.match(rendered(), /MCP server stuck/));
			view.handleInput("\x1b[B");
			view.handleInput("\r");
			await vi.waitFor(() => assert.match(rendered(), /disabled/));
			await vi.waitFor(() => assert.ok(closes > 0));
			if (action === "replacement") {
				view.handleInput("\r");
				await vi.waitFor(() => assert.equal(starts, 2), { timeout: 5000 });
			}
			view.handleInput("\x1b");
			await vi.waitFor(() => assert.match(rendered(), /MCP servers/));
			view.handleInput("\x1b");
			await manager;
			let shutDown = false;
			const shutdown = harness.session.dispose().then(() => {
				shutDown = true;
			});
			await vi.waitFor(() => assert.equal(shutDown, true), { timeout: 5000 });
			await shutdown;
		} finally {
			release.resolve();
			try {
				if (view) {
					view.handleInput?.("\x1b");
					await vi.waitFor(() => assert.match(view?.render(160).join("\n") ?? "", /MCP servers/));
					view.handleInput?.("\x1b");
					await manager;
				}
			} finally {
				await harness.cleanup();
			}
		}
	});
});
