import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	MINIMUM_NODE_VERSION,
	unsupportedNodeVersionMessage,
} from "../../packages/coding-agent/src/utils/node-version-floor.js";

const cli = fileURLToPath(new URL("../../packages/coding-agent/dist/cli.js", import.meta.url));

/** Runs the built CLI on this Node.js, reporting `node` as its version (Node's own `process.versions.node`). */
function runCliReportingNode(node: string, args: readonly string[]) {
	const preload = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:${JSON.stringify(node)}})`;
	return spawnSync(process.execPath, ["--import", preload, cli, ...args], { encoding: "utf8", timeout: 60_000 });
}

test("the minimum is the floor of the published package's engines.node", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../../packages/coding-agent/package.json", import.meta.url), "utf8"),
	) as { engines: { node: string } };
	assert.equal(manifest.engines.node, `>=${MINIMUM_NODE_VERSION}`);
});

test("Node.js releases older than 24.20.0 are refused, and 24.20.0 and later ones are not", () => {
	for (const node of ["24.19.0", "24.19.9", "24.11.1", "22.23.5", "22.19.0", "20.19.0"]) {
		assert.ok(unsupportedNodeVersionMessage({ node } as NodeJS.ProcessVersions), node);
	}
	for (const node of ["24.20.0", "24.20.1", "24.22.3", "25.0.0", "26.13.1", "27.0.0-nightly20261101"]) {
		assert.equal(unsupportedNodeVersionMessage({ node } as NodeJS.ProcessVersions), undefined, node);
	}
});

test("Bun is not refused, whatever Node.js version it reports", () => {
	assert.equal(unsupportedNodeVersionMessage({ node: "22.6.0", bun: "1.4.5" } as NodeJS.ProcessVersions), undefined);
});

test("the CLI stops on Node.js 24.19.0 before doing anything, naming the version it needs and the install guide", () => {
	const result = runCliReportingNode("24.19.0", ["--version"]);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		[
			"Atomic needs Node.js 24.20.0 or newer, but this is Node.js 24.19.0.",
			"Install the current Node.js 24 LTS release, then reinstall Atomic with `npm install -g @bastani/atomic`.",
			"See https://docs.bastani.ai/getting-started/installation#nodejs-version",
			"",
		].join("\n"),
	);
});

test("the CLI runs on Node.js 24.20.0", () => {
	const result = runCliReportingNode("24.20.0", ["--version"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^\d+\.\d+\.\d+\S*\n$/);
});
