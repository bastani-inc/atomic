import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const fallback = { provider: " custom ", model: " fallback ", cost };
const paths = ["provider", "model", "override"] as const;
async function load(value: object | null | string | undefined, path: (typeof paths)[number], extraCompat = {}) {
	const root = mkdtempSync(join(tmpdir(), "atomic-fallback-config-"));
	roots.push(root);
	const compat = { ...extraCompat, allowedFallbackModels: value };
	const provider =
		path === "provider"
			? { compat }
			: path === "model"
				? { models: [{ id: "custom", compat }] }
				: { modelOverrides: { custom: { compat } } };
	const file = join(root, "models.json");
	writeFileSync(file, JSON.stringify({ providers: { custom: { api: "anthropic-messages", ...provider } } }));
	return ModelConfig.load(file);
}

for (const path of paths) {
	test(`fallback ${path} accepts zero through three ordered, verbatim, duplicate entries`, async () => {
		for (let length = 0; length <= 3; length++) {
			const values = [fallback, { ...fallback, model: " second " }, fallback].slice(0, length);
			const config = await load(values, path);
			assert.equal(config.getError(), undefined);
			const provider = config.getProvider("custom")!;
			const compat =
				path === "provider"
					? provider.compat
					: path === "model"
						? provider.models![0].compat
						: provider.modelOverrides!.custom.compat;
			assert.deepEqual(compat, { allowedFallbackModels: values });
		}
	});
	test(`fallback ${path} accepts complete pricing tiers`, async () => {
		assert.equal(
			(await load([{ ...fallback, cost: { ...cost, tiers: [{ inputTokensAbove: 0, ...cost }] } }], path)).getError(),
			undefined,
		);
	});
	test(`fallback ${path} preserves unrelated compat permissiveness and Atomic fields`, async () => {
		const extraCompat = {
			futureExtension: { value: null },
			supportsStore: true,
			vllmPriority: -1,
			enforcesPreservedThinkingBinding: true,
		};
		for (const value of [undefined, [fallback]]) {
			const config = await load(value, path, extraCompat);
			assert.equal(config.getError(), undefined);
			const provider = config.getProvider("custom")!;
			const compat =
				path === "provider"
					? provider.compat
					: path === "model"
						? provider.models![0].compat
						: provider.modelOverrides!.custom.compat;
			assert.deepEqual(compat, value === undefined ? extraCompat : { ...extraCompat, allowedFallbackModels: value });
		}
	});
	test(`fallback ${path} rejects malformed or more than three entries`, async () => {
		for (const value of [
			null,
			"model",
			[fallback, fallback, fallback, fallback],
			[{ ...fallback, provider: "" }],
			[{ ...fallback, model: "" }],
			[{ provider: "custom", model: "model" }],
			[{ ...fallback, cost: { input: 1 } }],
			[{ ...fallback, cost: { ...cost, tiers: [{ inputTokensAbove: 0 }] } }],
		]) {
			assert.match((await load(value, path)).getError() ?? "", /Invalid models.json schema/, JSON.stringify(value));
		}
	});
}
