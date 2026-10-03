import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instantiateExtensions } from "../../../src/core/extensions/loader.ts";
import type { LoadExtensionsResult, ToolRenderContext } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createMcpExtension } from "../../../src/extensions/mcp/index.js";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

const mcpExtension = createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) });

describe("MCP tool renderers", () => {
	it("binds copied tool renderer registrations to each session runtime after reload (#10285)", async () => {
		let registerLateRenderer = () => {};
		const discovered = await createTestExtensionsResult([
			(pi) => {
				registerLateRenderer = () =>
					pi.registerToolRenderer(() => ({
						renderShell: "default",
						renderCall: () => {
							const value = String(pi.getSettings().quietStartup);
							return { render: () => [value], invalidate: () => {} };
						},
					}));
			},
		]);
		registerLateRenderer();
		const copied: LoadExtensionsResult = {
			...discovered,
			extensions: discovered.extensions.map((extension) => {
				const original = extension.toolRenderers![0];
				return {
					...extension,
					toolRenderers: [(name, next) => ({ ...original(name, next), renderShell: "self" as const })],
				};
			}),
		};
		let current = copied;
		const resourceLoader = createTestResourceLoader({ extensionsResult: copied });
		resourceLoader.getExtensions = () => current;
		resourceLoader.reload = async () => {
			current = await instantiateExtensions(copied, process.cwd());
		};
		const harness = await createHarness({
			resourceLoader,
			settings: { quietStartup: true },
		});
		try {
			expect(harness.session.extensionRunner.resolveToolRenderers("tool", () => undefined)?.renderShell).toBe(
				"self",
			);
			expect(
				harness.session.extensionRunner
					.resolveToolRenderers("tool", () => undefined)
					?.renderCall?.({}, theme, {} as ToolRenderContext)
					.render(80),
			).toEqual(["true"]);
			harness.settingsManager.setQuietStartup(false);
			await harness.session.reload();
			expect(harness.session.extensionRunner.resolveToolRenderers("tool", () => undefined)?.renderShell).toBe(
				"self",
			);
			expect(
				harness.session.extensionRunner
					.resolveToolRenderers("tool", () => undefined)
					?.renderCall?.({}, theme, {} as ToolRenderContext)
					.render(80),
			).toEqual(["false"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("resolves renderers in extension load order with next and registered-tool fallback (#10285)", async () => {
		const renderCall = () => ({ render: () => [], invalidate: () => {} });
		const harness = await createHarness({
			extensionFactories: [
				(pi) => pi.registerToolRenderer((name, next) => (name === "a" ? { renderCall } : next())),
				(pi) => pi.registerToolRenderer((_name, next) => next() ?? { renderShell: "self" }),
			],
		});
		try {
			const runner = harness.session.extensionRunner;
			expect(runner.resolveToolRenderers("a", () => undefined)).toEqual({ renderCall });
			expect(runner.resolveToolRenderers("b", () => undefined)).toEqual({ renderShell: "self" });
			expect(runner.resolveToolRenderers("b", () => ({ renderCall }))).toEqual({ renderCall });
		} finally {
			await harness.cleanup();
		}
	});

	it("renders calls to unregistered MCP tools before their server connects (#10285)", async () => {
		initTheme("dark");
		const harness = await createHarness({ extensionFactories: [mcpExtension] });
		try {
			const resolve = (toolName: string) =>
				harness.session.extensionRunner.resolveToolRenderers(toolName, () =>
					harness.session.getToolDefinition(toolName),
				);
			const call = resolve("mcp__my_docs__search")?.renderCall?.({ query: "pi" }, theme, {
				expanded: false,
			} as ToolRenderContext);
			expect(stripAnsi(call?.render(100).join("\n") ?? "")).toContain('my_docs/search query="pi"');
			expect(resolve("not_mcp")).toBeUndefined();
			expect(resolve("read")?.renderCall).toBe(harness.session.getToolDefinition("read")?.renderCall);
		} finally {
			await harness.cleanup();
		}
	});

	it("renders unregistered MCP tool calls in HTML exports (#10285)", async () => {
		initTheme("dark");
		const dir = mkdtempSync(join(tmpdir(), "atomic-10285-"));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		const harness = await createHarness({ extensionFactories: [mcpExtension], sessionManager });
		try {
			sessionManager.appendMessage({ role: "user", content: "search", timestamp: 1 });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "mcp__my_docs__search", arguments: { query: "pi" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			});
			const html = readFileSync(await harness.session.exportToHtml(join(dir, "export.html")), "utf8");
			const data = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
			const session = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
			expect(stripAnsi(session.renderedTools?.["call-1"]?.callHtml ?? "")).toContain("my_docs/search");
		} finally {
			await harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
