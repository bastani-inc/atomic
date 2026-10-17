import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import { renderReferences } from "../scripts/generate-references.js";
import { getPackageDir } from "../src/config.js";

describe("generated reference pages", () => {
	it("matches the committed model configuration reference (#10790)", () => {
		const rendered = renderReferences();
		assert.deepEqual([...rendered.keys()], ["docs/models-configuration.md"]);
		for (const [relativePath, expected] of rendered) {
			assert.equal(
				readFileSync(resolve(getPackageDir(), relativePath), "utf-8"),
				expected,
				`${relativePath} is stale; run npm run generate:references --workspace=@bastani/atomic`,
			);
		}
	});

	it("documents model defaults without assigning them to overrides (#10790)", () => {
		const reference = renderReferences().get("docs/models-configuration.md")!;
		const models = reference.split("## Models\n")[1].split("## Model overrides\n")[0];
		const overrides = reference.split("## Model overrides\n")[1].split("## Input limits\n")[0];
		assert.ok(models.includes("| `contextWindow` | number | `128000` | Context window in tokens. |"));
		assert.ok(overrides.includes("| `contextWindow` | number |  | Context window in tokens. |"));
		assert.ok(reference.includes("Also applies to `azure-openai-responses` and `openai-codex-responses`."));
		assert.ok(reference.includes("| `supportsGrammarTools` | boolean |  | Atomic alias"));
	});
});
