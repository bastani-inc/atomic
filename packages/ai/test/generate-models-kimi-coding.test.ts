import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";

// #3105 prerequisite: models.dev renamed the .com coding plan; generation must retain the provider import closure.
test.each(["kimi-code-plan-cn", "kimi-for-coding"])(
	"generates Kimi Coding from %s with its Chat Completions transport",
	(provider) => {
		const root = mkdtempSync(join(tmpdir(), "pi-kimi-catalog-"));
		try {
			const packageRoot = fileURLToPath(new URL("..", import.meta.url));
			for (const entry of ["package.json", "scripts", "src"])
				cpSync(join(packageRoot, entry), join(root, entry), { recursive: true });
			// Observed models.dev metadata for the existing canonical coding model, with zero subscription costs.
			const catalog = {
				[provider]: {
					models: {
						"kimi-for-coding": {
							id: "kimi-for-coding",
							name: "kimi-for-coding",
							tool_call: true,
							reasoning: true,
							reasoning_options: [{ type: "effort", values: ["none", "low", "high", "max"] }],
							modalities: { input: ["text", "image", "video"] },
							limit: { context: 1048576, output: 32768 },
							cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
						},
					},
				},
			};
			const preload = join(root, "catalog.mjs");
			writeFileSync(
				preload,
				`globalThis.fetch = async url => new Response(JSON.stringify(String(url) === "https://models.dev/api.json" ? ${JSON.stringify(catalog)} : {data: []}), {status: 200});`,
			);
			const output = join(root, "catalog");
			const result = spawnSync(
				process.execPath,
				["--import", pathToFileURL(preload).href, "scripts/generate-models.ts", "--json-output", output],
				{ cwd: root, encoding: "utf8", timeout: 30000 },
			);
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
			const shard = readFileSync(join(root, "src/providers/kimi-coding.models.ts"), "utf8");
			assert.match(shard, /export const KIMI_CODING_MODELS/);
			assert.match(shard, /data\/kimi-coding.json/);
			const models = JSON.parse(readFileSync(join(output, "providers/kimi-coding.json"), "utf8"));
			assert.deepEqual(Object.keys(models), ["kimi-for-coding"]);
			const model = models["kimi-for-coding"];
			assert.equal(model.provider, "kimi-coding");
			assert.equal(model.api, "openai-completions");
			assert.equal(model.baseUrl, "https://api.kimi.com/coding/v1");
			assert.deepEqual(model.input, ["text", "image"]);
			assert.equal(model.contextWindow, 1048576);
			assert.equal(model.maxTokens, 32768);
			assert.equal(model.reasoning, true);
			assert.deepEqual(model.compat, {
				supportsStrictMode: false,
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "openai",
				requiresReasoningContentOnAssistantMessages: true,
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolAdditions: true,
			});
			assert.deepEqual(model.cost, { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
