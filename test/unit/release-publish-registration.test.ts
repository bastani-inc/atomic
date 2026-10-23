import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { parse } from "yaml";
import { moduleDir, readTextSync, spawnSyncCollect } from "../helpers/runtime.js";

// Execute the shipped publication function, with npm replaced at its external process boundary.
const workflow = parse(
	readTextSync(join(moduleDir(import.meta.url), "../../.github/workflows/publish.yml"), "utf8"),
) as {
	jobs: { "publish-npm": { steps: Array<{ name?: string; run?: string }> } };
};
const script = workflow.jobs["publish-npm"].steps.find(
	(step) => step.name === "Publish native packages then coding agent",
)?.run;
assert.ok(script);
const publication = script.match(/publish_package\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(publication);

function publishWithRegistration(exitCode: number, output: string) {
	return spawnSyncCollect(
		[
			"bash",
			"-c",
			`
set -euo pipefail
declare -A tarballs=([@bastani/atomic-storage-libsql]=fixture.tgz)
requires_registered_name=(@bastani/atomic-storage-libsql)
VERSION=0.0.0
NPM_TAG=latest
npm() {
  if [[ "$1" == "publish" ]]; then echo PUBLISHED; return 0; fi
  if [[ "$3" == "name" ]]; then
    printf '%s\\n' "$REGISTRATION_OUTPUT"
    return "$REGISTRATION_EXIT"
  fi
  return 1
}
${publication}
publish_package @bastani/atomic-storage-libsql
`,
		],
		{ env: { ...process.env, REGISTRATION_EXIT: String(exitCode), REGISTRATION_OUTPUT: output } },
	);
}

test("publication refuses indeterminate package registration instead of silently skipping the adapter (#3857)", () => {
	for (const code of ["ETIMEDOUT", "E429", "E500"]) {
		const result = publishWithRegistration(1, `npm error code ${code}`);
		assert.notEqual(result.exitCode, 0, `${code} must fail publication`);
		assert.equal(result.stdout.toString().includes("PUBLISHED"), false);
	}
});

test("publication skips only confirmed missing names and publishes registered ones (#3857)", () => {
	const registered = publishWithRegistration(0, "@bastani/atomic-storage-libsql");
	assert.equal(registered.exitCode, 0, registered.stderr.toString());
	assert.match(registered.stdout.toString(), /PUBLISHED/);
	for (const output of ["npm error code E404", "404 Not Found", "package is not in this registry"]) {
		const missing = publishWithRegistration(1, output);
		assert.equal(missing.exitCode, 0, missing.stderr.toString());
		assert.match(missing.stdout.toString(), /not registered.*skipping/);
		assert.doesNotMatch(missing.stdout.toString(), /PUBLISHED/);
	}
	const killed = publishWithRegistration(143, "npm error code E404");
	assert.notEqual(killed.exitCode, 0);
});
