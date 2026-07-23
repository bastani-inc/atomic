import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../../../..");

describe("regression #1728 web-access native heavy import", () => {
	it("loads the real heavy graph before returning normal lazy-tool validation errors", () => {
		const extensionUrl = pathToFileURL(resolve(repoRoot, "packages/web-access/index.ts")).href;
		const script = `
const { default: webAccess } = await import(${JSON.stringify(extensionUrl)});
const tools = new Map();
const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand() {},
  registerShortcut() {},
  registerMessageRenderer() {},
  on() {},
};
webAccess(pi);
const calls = [
  ["web_search", {}],
  ["code_search", { query: "" }],
  ["fetch_content", {}],
  ["get_search_content", { responseId: "missing-1728-regression" }],
];
const signal = new AbortController().signal;
const results = {};
for (const [name, params] of calls) {
  const tool = tools.get(name);
  if (!tool?.execute) throw new Error("Web-access lazy tool was not registered: " + name);
  const result = await tool.execute("1728-" + name, params, signal, undefined, undefined);
  results[name] = result;
}
console.log(JSON.stringify(results));
`;
		const result = spawnSync("bun", ["--eval", script], {
			cwd: repoRoot,
			encoding: "utf-8",
			timeout: 20_000,
		});

		expect(result.status, result.stderr || result.stdout).toBe(0);
		const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<
			string,
			{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }
		>;
		expect(output.web_search).toMatchObject({
			content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
			details: { error: "No query provided" },
		});
		expect(output.code_search).toMatchObject({
			content: [{ type: "text", text: "Error: No query provided." }],
			details: { error: "No query provided" },
		});
		expect(output.fetch_content).toMatchObject({
			content: [{ type: "text", text: "Error: No URL provided." }],
			details: { error: "No URL provided" },
		});
		expect(output.get_search_content).toMatchObject({
			content: [{ type: "text", text: 'Error: No stored results for "missing-1728-regression"' }],
			details: { error: "Not found", responseId: "missing-1728-regression" },
		});
	});
});
