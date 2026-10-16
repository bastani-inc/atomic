import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../../../..");

describe("regression #1728 web-access native heavy import", () => {
	it("loads the real heavy graph and returns normal lazy-tool errors with the current fetch contract", () => {
		const extensionUrl = pathToFileURL(resolve(repoRoot, "packages/web-access/index.ts")).href;
		const script = `
const { default: webAccess } = await import(${JSON.stringify(extensionUrl)});
const assert = (await import("node:assert/strict")).default;
const { validateToolArguments } = await import("@earendil-works/pi-ai");
const tools = new Map();
const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand() {},
  registerShortcut() {},
  registerMessageRenderer() {},
  on() {},
  async appendEntry() {},
};
webAccess(pi);
// Missing, legacy singular, and empty inputs fail at the host boundary, before execute.
const fetchTool = tools.get("fetch_content");
for (const args of [{}, { url: "https://example.com" }, { urls: [] }, { urls: [""] }]) {
  assert.throws(
    () => validateToolArguments(fetchTool, { type: "toolCall", id: "invalid-fetch", name: "fetch_content", arguments: args }),
    /Validation failed for tool "fetch_content":.*urls/s,
  );
}
const calls = [
  ["web_search", {}],
  ["code_search", { repoName: "owner/repo", query: "" }],
  ["fetch_content", { urls: ["not-a-url"] }],
  ["get_search_content", { responseId: "missing-1728-regression" }],
];
const signal = new AbortController().signal;
const results = {};
for (const [name, params] of calls) {
  const tool = tools.get(name);
  if (!tool?.execute) throw new Error("Web-access lazy tool was not registered: " + name);
  // A nonempty string is schema-valid, but URL parsing fails without network access.
  if (name === "fetch_content") {
    validateToolArguments(tool, { type: "toolCall", id: "1728-fetch", name, arguments: params });
  }
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
			content: [{ type: "text", text: "Error: Invalid URL" }],
			details: {
				outcome: "all_failed",
				stage: "fetch",
				urls: ["not-a-url"],
				urlCount: 1,
				successful: 0,
				error: "Invalid URL",
			},
		});
		expect(output.get_search_content).toMatchObject({
			content: [{ type: "text", text: 'Error: No stored results for "missing-1728-regression"' }],
			details: { error: "Not found", responseId: "missing-1728-regression" },
		});
	});
});
