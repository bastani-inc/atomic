import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { instantiateExtensions } from "../../../src/core/extensions/loader.js";
import type { LoadExtensionsResult, ToolRenderContext } from "../../../src/core/extensions/types.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createMcpExtension } from "../../../src/extensions/mcp/index.js";
import { createMcpToolName } from "../../../src/extensions/mcp/tools.js";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../../../src/utils/ansi.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.js";
import { createHarness } from "../harness.js";

const mcpExtension = createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) });
const shortenedName = createMcpToolName("a", "search".repeat(15));
const shortenedServerName = createMcpToolName("a".repeat(55), "search");
const fallbackLabels = [
	["mcp__my_docs__search", "my_docs/search"],
	["mcp__a__b__search", "mcp__a__b__search"],
	["mcp__a__search__more", "mcp__a__search__more"],
	["mcp__a___search", "mcp__a___search"],
	["mcp__a_b__search", "a_b/search"],
	["mcp__a__search_1234abcd", "mcp__a__search_1234abcd"],
	[shortenedName, shortenedName],
	[shortenedServerName, shortenedServerName],
] as const;

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
			assert.equal(
				harness.session.extensionRunner.resolveToolRenderers("tool", () => undefined)?.renderShell,
				"self",
			);
			assert.deepEqual(
				harness.session.extensionRunner
					.resolveToolRenderers("tool", () => undefined)
					?.renderCall?.({}, theme, {} as ToolRenderContext)
					.render(80),
				["true"],
			);
			harness.settingsManager.setQuietStartup(false);
			await harness.session.reload();
			assert.equal(
				harness.session.extensionRunner.resolveToolRenderers("tool", () => undefined)?.renderShell,
				"self",
			);
			assert.deepEqual(
				harness.session.extensionRunner
					.resolveToolRenderers("tool", () => undefined)
					?.renderCall?.({}, theme, {} as ToolRenderContext)
					.render(80),
				["false"],
			);
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
			assert.deepEqual(
				runner.resolveToolRenderers("a", () => undefined),
				{ renderCall },
			);
			assert.deepEqual(
				runner.resolveToolRenderers("b", () => undefined),
				{ renderShell: "self" },
			);
			assert.deepEqual(
				runner.resolveToolRenderers("b", () => ({ renderCall })),
				{ renderCall },
			);
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
			for (const [name, label] of fallbackLabels) {
				const call = resolve(name)?.renderCall?.({ query: "pi" }, theme, {
					expanded: false,
				} as ToolRenderContext);
				assert.ok(stripAnsi(call?.render(100).join("\n") ?? "").includes(`${label} query="pi"`), name);
			}
			assert.equal(resolve("not_mcp"), undefined);
			assert.equal(resolve("read")?.renderCall, harness.session.getToolDefinition("read")?.renderCall);
			const renderCall = () => ({ render: () => ["a__b/search"], invalidate: () => {} });
			assert.equal(
				harness.session.extensionRunner.resolveToolRenderers("mcp__a__b__search", () => ({ renderCall }))
					?.renderCall,
				renderCall,
			);
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
				content: fallbackLabels.map(([name], index) => ({
					type: "toolCall",
					id: `call-${index}`,
					name,
					arguments: { query: "pi" },
				})),
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
			const session: { renderedTools?: Record<string, { callHtml?: string }> } = JSON.parse(
				Buffer.from(data, "base64").toString("utf8"),
			);
			for (const [index, [, label]] of fallbackLabels.entries()) {
				assert.ok(stripAnsi(session.renderedTools?.[`call-${index}`]?.callHtml ?? "").includes(label), label);
			}
		} finally {
			await harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
