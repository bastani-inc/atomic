import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const integrationDir = join(root, "test/integration");
const FAMILY = "sdk-builtin-host-parity";
const TOPICS = ["host-routing", "shared-siblings", "retirement", "concurrency", "ownership", "mcp-web"] as const;
const BUDGET_CONSTANT = "BUILT_NODE_HOST_PROCESS_TIMEOUT_MS";
const SPAWN_CONSTANT = "FIXTURE_PROCESS_TIMEOUT_MS";
const EXPECTED_TIMEOUT_MS = 60_000;

const NO_BARREL_REASON =
	`${FAMILY} is split into topic files so vitest's file-level parallelism spreads its built-Node fixtures ` +
	"across workers. A barrel importing the topic files re-executes every registration inside one worker, " +
	"which restores the single-file serial critical path (607.6 s of the 614.6 s Windows integration wall).";

function familyTestFiles(): string[] {
	return readdirSync(integrationDir)
		.filter((name) => name.startsWith(`${FAMILY}-`) && name.endsWith(".test.ts"))
		.sort();
}

/** Match `const NAME = 60_000;` the same way scripts/test-duration-guard.ts resolves budgets. */
function literalConstant(source: string, name: string): number | undefined {
	const match = new RegExp(`^\\s*const\\s+${name}\\s*(?::\\s*number\\s*)?=\\s*([0-9][0-9_]*)\\s*;?\\s*$`, "mu").exec(
		source,
	);
	return match?.[1] === undefined ? undefined : Number(match[1].replaceAll("_", ""));
}

test("the sdk-builtin-host-parity family has no barrel re-serialising it into one worker", () => {
	assert.equal(existsSync(join(integrationDir, `${FAMILY}.test.ts`)), false, NO_BARREL_REASON);

	const familyImport = new RegExp(
		`(?:from|import|require\\()\\s*["'\`][^"'\`]*${FAMILY}-[a-z-]+\\.test\\.(?:js|ts)["'\`]`,
		"u",
	);
	for (const name of readdirSync(integrationDir).filter((entry) => entry.endsWith(".ts"))) {
		const source = readFileSync(join(integrationDir, name), "utf8");
		assert.doesNotMatch(
			source,
			familyImport,
			`test/integration/${name} imports a ${FAMILY} topic file. ${NO_BARREL_REASON}`,
		);
	}
});

test("every sdk-builtin-host-parity topic file exists", () => {
	assert.deepEqual(
		familyTestFiles(),
		[...TOPICS].sort().map((topic) => `${FAMILY}-${topic}.test.ts`),
	);
});

test("each topic file declares the built-Node budget literally and the helper spawn timeout matches it", () => {
	for (const name of familyTestFiles()) {
		const source = readFileSync(join(integrationDir, name), "utf8");
		if (!source.includes(BUDGET_CONSTANT)) continue;
		assert.equal(
			literalConstant(source, BUDGET_CONSTANT),
			EXPECTED_TIMEOUT_MS,
			`test/integration/${name} must declare \`const ${BUDGET_CONSTANT} = 60_000;\` in-file: the duration guard resolves timeout expressions only from numeric consts in the reporting file, so an imported constant would score every test against the 30 s default`,
		);
	}

	const helpers = readFileSync(join(integrationDir, `${FAMILY}-helpers.ts`), "utf8");
	assert.equal(
		literalConstant(helpers, SPAWN_CONSTANT),
		EXPECTED_TIMEOUT_MS,
		`${SPAWN_CONSTANT} in ${FAMILY}-helpers.ts is the spawnSync kill timeout for every built-Node fixture and must equal ${BUDGET_CONSTANT} (${EXPECTED_TIMEOUT_MS}): a child killed after the vitest budget derived from it would fail on exit code rather than time out`,
	);
});
