#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const MINIMUM_BUN_WITH_TYPE_CHECKER = [1, 4, 3];
const bunExecutable = process.env.ATOMIC_BUN_EXECUTABLE || "bun";

function parseVersion(text) {
	return text
		.trim()
		.split("-")[0]
		.split(".")
		.map((part) => Number.parseInt(part, 10));
}

function isAtLeast(actual, minimum) {
	for (let index = 0; index < minimum.length; index++) {
		const difference = (actual[index] ?? 0) - minimum[index];
		if (difference !== 0) return difference > 0;
	}
	return true;
}

const versionProbe = spawnSync(bunExecutable, ["--version"], { encoding: "utf8" });
if (versionProbe.error || versionProbe.status !== 0) {
	console.error(`bun-typecheck: could not run "${bunExecutable} --version". Install Bun >= 1.4.4.`);
	process.exit(1);
}
const bunVersion = versionProbe.stdout.trim();
if (!isAtLeast(parseVersion(bunVersion), MINIMUM_BUN_WITH_TYPE_CHECKER)) {
	console.error(`bun-typecheck: Bun ${bunVersion} has no type checker. Install Bun >= 1.4.4.`);
	process.exit(1);
}

const runAsCheckLifecycleSoPackageCheckScriptCannotShadowTypeChecker = {
	...process.env,
	npm_lifecycle_event: "check",
};
const result = spawnSync(bunExecutable, ["check", ...process.argv.slice(2)], {
	stdio: "inherit",
	env: runAsCheckLifecycleSoPackageCheckScriptCannotShadowTypeChecker,
});
if (result.error) {
	console.error(`bun-typecheck: ${result.error.message}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
