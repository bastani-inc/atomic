import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import type { JsonTestResults } from "vitest/reporters";
import { repositoryRoot } from "../../vitest.base.js";
import {
	bunExecutable,
	fileExistsSync,
	makeDirectorySync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";

// Structural: each scenario starts a real configured Vitest suite and Node/Bun descendants.
const REAL_VITEST_ISOLATION_TIMEOUT_MS = 120_000;
const REAL_VITEST_PROCESS_TIMEOUT_MS = 90_000;
const DESCENDANT_PROCESS_TIMEOUT_MS = 10_000;

for (const [label, root, projectCount] of [
	["repository projects", repositoryRoot, 4],
	["coding-agent projects", join(repositoryRoot, "packages/coding-agent"), 1],
] as const) {
	test(
		`${label} isolate inherited Herdr pane credentials before collection and subprocess creation`,
		() => {
			const directory = makeTempDirectory("atomic-herdr-test-isolation [fixture]-");
			// #2963: Windows TEMP can contain an 8.3 alias (RUNNER~1) that ancestor
			// directory listings never return. A case alias exercises the same discovery
			// failure on case-insensitive filesystems; other hosts still run the real suites.
			const caseAlias = join(dirname(directory), basename(directory).toUpperCase());
			const fixtureDirectory = fileExistsSync(caseAlias) ? caseAlias : directory;
			const configPath = join(directory, "vitest.config.mjs");
			const fixturePath = join(fixtureDirectory, "isolation.test.ts");
			const reportPath = join(directory, "results.json");
			const configUrl = pathToFileURL(join(root, "vitest.config.ts")).href;
			const vitestUrl = pathToFileURL(join(repositoryRoot, "node_modules/vitest/dist/index.js")).href;
			const environmentUrl = pathToFileURL(
				join(repositoryRoot, "packages/coding-agent/src/extensions/herdr/environment.ts"),
			).href;
			const snapshot = `({ keys: Object.keys(process.env).filter(key => key.startsWith("HERDR_")).sort(), eligible: captureHerdrEnvironment(process.env) !== undefined })`;
			const childSource = `import { captureHerdrEnvironment } from ${JSON.stringify(environmentUrl)}; console.log(JSON.stringify(${snapshot}));`;
			try {
				// Retain the real projects' setup and runner settings; only substitute the collected file.
				// Keep root for real setup resolution, but start discovery at the fixture.
				writeTextSync(
					configPath,
					`import config from ${JSON.stringify(configUrl)};
export default {
  ...config,
  test: {
    ...config.test,
    projects: config.test.projects.map(project => ({
      ...project,
      test: {...project.test, root: ${JSON.stringify(root)}, dir: ${JSON.stringify(fixtureDirectory)}, include: ["isolation.test.ts"]},
    })),
  },
};\n`,
				);
				writeTextSync(
					fixturePath,
					`import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from ${JSON.stringify(vitestUrl)};
import { captureHerdrEnvironment } from ${JSON.stringify(environmentUrl)};
const atCollection = ${snapshot};
test("worker cannot activate inherited pane reporting at collection", () => {
  assert.deepEqual(atCollection, {keys: [], eligible: false});
});
for (const runtime of ${JSON.stringify([process.execPath, bunExecutable()])}) {
  test(runtime + " descendant cannot activate inherited pane reporting", () => {
    const child = spawnSync(runtime, ["--input-type=module", "-e", ${JSON.stringify(childSource)}], {encoding: "utf8", timeout: ${DESCENDANT_PROCESS_TIMEOUT_MS}});
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {keys: [], eligible: false});
  });
}\n`,
				);
				const artifacts = join(directory, "artifacts");
				makeDirectorySync(artifacts);
				const result = spawnSyncCollect(
					[
						process.execPath,
						join(repositoryRoot, "node_modules/vitest/vitest.mjs"),
						"--run",
						"--config",
						configPath,
						"--reporter=default",
						"--reporter=json",
						`--outputFile=${reportPath}`,
					],
					{
						cwd: root,
						timeout: REAL_VITEST_PROCESS_TIMEOUT_MS,
						env: {
							...process.env,
							ATOMIC_WORKFLOW_ARTIFACT_DIR: artifacts,
							HERDR_ENV: "1",
							// Never point a regression, including its RED run, at a real binary or pane.
							HERDR_BIN_PATH: join(directory, "nonexistent-herdr"),
							HERDR_PANE_ID: "test-pane",
							HERDR_SOCKET_PATH: join(directory, "nonexistent.sock"),
							HERDR_TAB_ID: "test-tab",
							HERDR_WORKSPACE_ID: "test-workspace",
						},
					},
				);
				assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
				const report = JSON.parse(readTextSync(reportPath, "utf8")) as JsonTestResults;
				assert.equal(report.testResults.length, projectCount, "every configured project must collect the fixture");
				assert.equal(report.numPassedTests, projectCount * 3, "collection and both descendants must assert");
				for (const project of report.testResults) {
					assert.equal(project.assertionResults.length, 3);
					assert.ok(project.assertionResults.every((assertion) => assertion.status === "passed"));
				}
			} finally {
				removeTempDirectory(directory);
			}
		},
		REAL_VITEST_ISOLATION_TIMEOUT_MS,
	);
}
