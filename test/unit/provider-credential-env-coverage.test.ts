import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { PROVIDER_CREDENTIAL_ENV_VARS } from "../helpers/provider-credential-env.js";
import { readDirectorySync, readTextSync } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Read through the provider env lookup, but neither a credential nor an endpoint. */
const NOT_CREDENTIALS = new Set([
	// Prompt-cache retention preference.
	"PI_CACHE_RETENTION",
	// The interactive engine's own control variable, already scrubbed by utils/interactive-engine-env.ts.
	"ATOMIC_INTERACTIVE_ENGINE_API_KEY",
]);

function productSources(directory: string): string[] {
	return readDirectorySync(directory, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".test.ts") &&
				!join(entry.parentPath, entry.name).includes("node_modules"),
		)
		.map((entry) => join(entry.parentPath, entry.name));
}

test("every provider credential the product reads from the environment is stripped from test runs", () => {
	const sources = [
		...productSources(join(root, "packages/ai/src")),
		...productSources(join(root, "packages/coding-agent/src")),
		...readDirectorySync(join(root, "packages/web-access"))
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
			.map((name) => join(root, "packages/web-access", name)),
	];
	const read = new Set<string>();
	for (const file of sources) {
		const text = readTextSync(file, "utf8");
		for (const match of text.matchAll(/getProviderEnvValue\(\s*"([A-Z][A-Z0-9_]+)"/g)) read.add(match[1]!);
		for (const match of text.matchAll(/"([A-Z][A-Z0-9_]*_API_KEY)"/g)) read.add(match[1]!);
		// Direct reads such as `process.env.EXA_API_KEY` or `env.GITHUB_COPILOT_BASE_URL`.
		const direct =
			/env(?:\.|\[")([A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_TOKEN_PATH|_BASE_URL|_API_TARGET|_OAUTH_HOST|_SERVER_URL))\b/g;
		for (const match of text.matchAll(direct)) read.add(match[1]!);
	}
	// Every quoted name in the provider key table and its credential checks is an environment variable.
	const keyTable = readTextSync(join(root, "packages/ai/src/env-api-keys.ts"), "utf8");
	for (const match of keyTable.matchAll(/"([A-Z][A-Z0-9_]+)"/g)) read.add(match[1]!);
	assert.ok(read.has("COPILOT_GITHUB_TOKEN") && read.has("OPENAI_API_KEY"), "the source scan found the key table");
	const listed = new Set(PROVIDER_CREDENTIAL_ENV_VARS);
	const unlisted = [...read].filter((name) => !listed.has(name) && !NOT_CREDENTIALS.has(name)).sort();
	assert.deepEqual(unlisted, [], "add these to test/helpers/provider-credential-env.ts");
});
