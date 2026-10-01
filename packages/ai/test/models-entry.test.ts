import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceEntry = new URL("../src/models.ts", import.meta.url).href;
const preload = `data:text/javascript,${encodeURIComponent(`
	import { registerHooks } from "node:module";
	const forbidden = ["/node_modules/typebox/", "/node_modules/@anthropic-ai/sdk/", "/node_modules/openai/", "/node_modules/@google/genai/", "/node_modules/@aws-sdk/", "/providers/data/", "/models.generated."];
	registerHooks({ load(url, context, nextLoad) {
		if (forbidden.some((part) => url.includes(part))) throw new Error("Heavy models dependency: " + url);
		return nextLoad(url, context);
	} });
`)}`;

for (const entry of [sourceEntry, "@bastani/pi-ai/models"]) {
	test(`models entry completes a faux response without SDKs, TypeBox or catalogs: ${entry}`, () => {
		const script = `
			import assert from "node:assert/strict";
			import { createModels, createProvider } from ${JSON.stringify(entry)};
			import { fauxAssistantMessage, fauxProvider } from "@bastani/pi-ai/providers/faux";
			assert.equal(typeof createProvider, "function");
			const models = createModels();
			assert.deepEqual(models.getModels(), []);
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			faux.setResponses([fauxAssistantMessage("OK")]);
			const response = await models.completeSimple(faux.getModel(), { messages: [] });
			assert.equal(response.stopReason, "stop");
			assert.deepEqual(response.content, [{ type: "text", text: "OK" }]);
		`;
		const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "--eval", script], {
			cwd: packageRoot,
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stderr);
	});
}
