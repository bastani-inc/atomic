import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(__dirname, "../../../../..");

function readRepoFile(path: string): string {
	return readFileSync(resolve(repoRoot, path), "utf-8");
}

function staticImportSpecifiers(source: string): string[] {
	return [...source.matchAll(/^import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["'];/gm)]
		.filter((match) => !match[0].startsWith("import type"))
		.map((match) => match[1]);
}

function textBeforeLoadHeavy(source: string): string {
	const loadHeavyIndex = source.indexOf("async function loadHeavy");
	expect(loadHeavyIndex).toBeGreaterThan(-1);
	return source.slice(0, loadHeavyIndex);
}

function dynamicHeavyImportCount(source: string): number {
	return [...source.matchAll(/import\(["']\.\/index-heavy\.js["']\)/g)].length;
}

function assertColdRegistrationDoesNotImportHeavy(packagePath: string): void {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-lazy-builtins-"));
	const sentinelPath = join(tempDir, "heavy-imports.txt");
	try {
		const extensionPath = resolve(repoRoot, packagePath);
		const loaderUrl = pathToFileURL(resolve(repoRoot, "packages/coding-agent/src/core/extensions/loader.ts")).href;
		const script = `
const { loadExtensions } = await import(${JSON.stringify(loaderUrl)});
const result = await loadExtensions([${JSON.stringify(extensionPath)}], ${JSON.stringify(repoRoot)});
if (result.errors.length > 0) throw new Error(JSON.stringify(result.errors));
await new Promise((resolve) => setTimeout(resolve, 250));
`;
		const result = spawnSync("bun", ["--eval", script], {
			cwd: repoRoot,
			env: {
				...process.env,
				ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE: sentinelPath,
			},
			encoding: "utf-8",
		});

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(existsSync(sentinelPath)).toBe(false);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function assertMcpColdStartupTools(options: { withCache: boolean; expectedTools: string[] }): void {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-mcp-startup-"));
	const agentDir = join(tempDir, "agent");
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
			settings: { disableProxyTool: true },
			mcpServers: {
				demo: {
					command: "bun",
					args: ["--version"],
					directTools: true,
				},
			},
		}, null, 2));

		const mcpUrl = pathToFileURL(resolve(repoRoot, "packages/mcp/index.ts")).href;
		const metadataUrl = pathToFileURL(resolve(repoRoot, "packages/mcp/metadata-cache.ts")).href;
		const script = `
const { default: mcpAdapter } = await import(${JSON.stringify(mcpUrl)});
const { computeServerHash } = await import(${JSON.stringify(metadataUrl)});
const { writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const agentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const server = { command: "bun", args: ["--version"], directTools: true };
if (${JSON.stringify(options.withCache)}) {
  writeFileSync(join(agentDir, "mcp-cache.json"), JSON.stringify({
    version: 1,
    servers: {
      demo: {
        configHash: computeServerHash(server),
        tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }],
        resources: [],
        cachedAt: Date.now()
      }
    }
  }, null, 2));
}
const handlers = [];
const tools = [];
const pi = {
  registerFlag() {},
  registerCommand() {},
  registerShortcut() {},
  registerMessageRenderer() {},
  registerTool(tool) { tools.push(tool.name); },
  getAllTools() { return []; },
  refreshTools() {},
  on(event, handler) { if (event === "session_start") handlers.push(handler); },
  events: { on() { return () => {}; }, emit() {} }
};
mcpAdapter(pi);
for (const handler of handlers) {
  await handler({ type: "session_start", reason: "new" }, { cwd: ${JSON.stringify(repoRoot)} });
}
console.log(JSON.stringify(tools));
process.exit(0);
`;
		// The agent/subagent runtime exports MCP_DIRECT_TOOLS=__none__ for child processes,
		// which suppresses cached direct-tool registration and would make this cold-start
		// assertion environment-dependent (registering the proxy ['mcp'] instead of the cached
		// direct tool). Neutralize it so the test deterministically exercises the
		// config/cache-driven registration path regardless of the ambient environment.
		const childEnv = {
			...process.env,
			ATOMIC_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_DIR: "",
		};
		delete childEnv.MCP_DIRECT_TOOLS;
		const result = spawnSync("bun", ["--eval", script], {
			cwd: repoRoot,
			env: childEnv,
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "[]")).toEqual(options.expectedTools);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("regression #1223 lazy built-in startup imports", () => {
	it("does not statically import heavy web-access provider modules from the registration surface", () => {
		const source = readRepoFile("packages/web-access/index.ts");
		const imports = staticImportSpecifiers(source);

		expect(imports).not.toContain("@mariozechner/pi-ai");
		expect(imports).not.toContain("./extract.js");
		expect(imports).not.toContain("./github-extract.js");
		expect(imports).not.toContain("./gemini-search.js");
		expect(imports).not.toContain("./code-search.js");
		expect(imports).not.toContain("./curator-server.js");
		expect(imports).not.toContain("./summary-review.js");
		expect(imports).not.toContain("./perplexity.js");
		expect(imports).not.toContain("./exa.js");
		expect(imports).not.toContain("./gemini-api.js");
		expect(imports).not.toContain("./gemini-web.js");
		expect(source).toContain('import("./index-heavy.js")');
		expect(source).toContain('pi.on("session_start"');
		expect(source).toContain('pi.on("session_tree"');
		expect(source).toContain('pi.on("session_shutdown"');
		expect(source).toContain('prop === "registerShortcut"');
		expect(source).toContain('pi.registerShortcut(shortcut');
		expect(source).toContain('renderResult: (...args) => renderHeavyToolResult(loadedHeavy, "web_search", args)');
		expect(source).not.toContain('prop === "registerShortcut" || prop === "on" || prop === "registerMessageRenderer"');
	});

	it("does not statically import heavy intercom broker or overlay modules from the registration surface", () => {
		const source = readRepoFile("packages/intercom/index.ts");
		const imports = staticImportSpecifiers(source);

		expect(imports).not.toContain("./broker/client.ts");
		expect(imports).not.toContain("./broker/spawn.ts");
		expect(imports).not.toContain("./ui/session-list.ts");
		expect(imports).not.toContain("./ui/compose.ts");
		expect(imports).not.toContain("./ui/inline-message.ts");
		expect(source).toContain('import("./index-heavy.js")');
		expect(source).toContain('"session_shutdown"');
		expect(source).toContain('"tool_execution_start"');
		expect(source).toContain('"model_select"');
		expect(source).toContain('prop === "registerShortcut"');
		expect(source).toContain('pi.registerShortcut("alt+m"');
		expect(source).toContain('SUBAGENT_CONTROL_INTERCOM_EVENT');
		expect(source).toContain('dispatchEventHandlers(heavy, eventName, payload)');
		expect(source).toContain('renderResult: (...args) => renderHeavyToolResult(loadedHeavy, "intercom", args)');
		expect(source).not.toContain('return () => undefined');
	});

	it("executes cold registration without importing heavy provider modules", () => {
		const webSource = readRepoFile("packages/web-access/index.ts");
		const intercomSource = readRepoFile("packages/intercom/index.ts");

		expect(dynamicHeavyImportCount(webSource)).toBe(1);
		expect(dynamicHeavyImportCount(intercomSource)).toBe(1);
		expect(textBeforeLoadHeavy(webSource)).not.toContain('import("./index-heavy.js")');
		expect(textBeforeLoadHeavy(intercomSource)).not.toContain('import("./index-heavy.js")');
		expect(webSource).not.toMatch(/void\s+loadHeavy\(/);
		expect(intercomSource).not.toMatch(/void\s+import\(["']\.\/index-heavy\.js["']\)/);
		expect(webSource).toContain('handler: async (ctx) => {\n\t\t\t\tconst heavy = await loadHeavy();');
		expect(intercomSource).toContain('handler: async (ctx) => {\n\t\t\tconst heavy = await loadHeavy(ctx);');

		assertColdRegistrationDoesNotImportHeavy("packages/web-access/index.ts");
		assertColdRegistrationDoesNotImportHeavy("packages/intercom/index.ts");
	});

	it("keeps the MCP proxy fallback until cached direct tools are available", () => {
		assertMcpColdStartupTools({ withCache: false, expectedTools: ["mcp"] });
		assertMcpColdStartupTools({ withCache: true, expectedTools: ["demo_echo"] });
	});
});
