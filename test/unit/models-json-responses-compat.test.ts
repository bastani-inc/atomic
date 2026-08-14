import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { ModelConfig, type ModelsJsonModel } from "../../packages/coding-agent/src/core/model-config.js";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function writeModelsJson(content: unknown): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "atomic-models-json-"));
	directories.push(directory);
	const path = join(directory, "models.json");
	await writeFile(path, JSON.stringify(content));
	return path;
}

/**
 * Upstream `e47b8e37` added the `supportsAdditionalTools` compat flag; the
 * behavior itself ships in pi-ai 0.84.2. Atomic owns the models.json schema
 * that has to declare it.
 *
 * The declaration is load-bearing at the type level, not at the validator:
 * typebox accepts unknown compat keys, so only this literal proves the schema
 * knows the flag. Excess-property checking on a union target reports a property
 * no constituent declares, so `tsc --noEmit` fails when the field is dropped
 * from `OpenAIResponsesCompatSchema`.
 */
const responsesCompat = { supportsDeveloperRole: true, supportsAdditionalTools: true } satisfies NonNullable<
	ModelsJsonModel["compat"]
>;

test("openai-responses compat declares supportsAdditionalTools and carries it through models.json", async () => {
	const path = await writeModelsJson({
		providers: {
			custom: {
				api: "openai-responses",
				baseUrl: "https://example.test/v1",
				models: [{ id: "custom-model", api: "openai-responses", compat: responsesCompat }],
			},
		},
	});

	const config = await ModelConfig.load(path);
	assert.equal(config.getError(), undefined);

	const compat = config.getProvider("custom")?.models?.[0]?.compat;
	assert.deepEqual(compat, responsesCompat);
});
