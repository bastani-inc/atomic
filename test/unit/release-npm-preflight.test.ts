import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
	classifyNpmViewOutcome,
	DEFAULT_NPM_REGISTRY,
	describeUnregisteredPackages,
	PUBLISH_WORKFLOW_PATH,
	parseReleasePayloadPackages,
	RELEASE_PAYLOAD_PACKAGE_COUNT,
	readReleasePayloadPackages,
	resolveNpmRegistry,
	verifyReleasePackagesRegistered,
} from "../../scripts/release-npm-preflight.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

const payload = (names: readonly string[]): string =>
	`          packages=(${names.join(" ")})\n          for name in "\${packages[@]}"; do\n`;

/** A probe that answers from a set, and records every name it was asked about. */
function probeFrom(registered: Set<string>, asked: string[] = []) {
	return {
		asked,
		isRegistered: async (name: string): Promise<boolean> => {
			asked.push(name);
			return registered.has(name);
		},
	};
}

describe("scripts/release-npm-preflight.ts", () => {
	test("the publish payload is read from the workflow that publishes it", () => {
		const names = readReleasePayloadPackages(root);
		assert.equal(names.length, RELEASE_PAYLOAD_PACKAGE_COUNT);
		assert.deepEqual(names, [
			"@bastani/atomic-natives-darwin-arm64",
			"@bastani/atomic-natives-darwin-x64",
			"@bastani/atomic-natives-linux-arm64-gnu",
			"@bastani/atomic-natives-linux-arm64-musl",
			"@bastani/atomic-natives-linux-x64-gnu",
			"@bastani/atomic-natives-linux-x64-musl",
			"@bastani/atomic-natives-win32-arm64-msvc",
			"@bastani/atomic-natives-win32-x64-msvc",
			"@bastani/atomic-natives",
			"@bastani/atomic",
		]);
	});

	test("a payload array that is missing, doubled, empty, malformed, or duplicated is refused", () => {
		assert.throws(
			() => parseReleasePayloadPackages("jobs:\n  publish-npm:\n"),
			/must declare exactly one `packages=\(…\)` publish payload array; found 0/u,
		);
		assert.throws(
			() => parseReleasePayloadPackages(payload(["@bastani/atomic"]) + payload(["@bastani/atomic-natives"])),
			/found 2/u,
		);
		assert.throws(() => parseReleasePayloadPackages(payload([])), /empty `packages=\(…\)`/u);
		assert.throws(
			() => parseReleasePayloadPackages(payload(["@bastani/atomic", '"$name"'])),
			/is not a publishable npm package name/u,
		);
		assert.throws(
			() => parseReleasePayloadPackages(payload(["@bastani/atomic", "@bastani/atomic"])),
			/duplicate publish payload packages: @bastani\/atomic/u,
		);
	});

	test("a missing publisher names the file it could not read", () => {
		assert.throws(
			() => readReleasePayloadPackages(fileURLToPath(new URL("./fixtures-that-do-not-exist", import.meta.url))),
			new RegExp(`Cannot read the release payload from .*${PUBLISH_WORKFLOW_PATH.replace(/[./]/gu, ".")}`, "u"),
		);
	});

	test("npm's own registry configuration is honored, and nothing else changes the default", () => {
		assert.equal(resolveNpmRegistry({}), DEFAULT_NPM_REGISTRY);
		assert.equal(resolveNpmRegistry({ npm_config_registry: "   " }), DEFAULT_NPM_REGISTRY);
		assert.equal(
			resolveNpmRegistry({ npm_config_registry: " https://npm.example.com/ " }),
			"https://npm.example.com/",
		);
	});

	test("only exit 0 and a 404 are answers; everything else is unknown and throws", () => {
		assert.equal(
			classifyNpmViewOutcome("@bastani/atomic", { exitCode: 0, stdout: "@bastani/atomic\n", stderr: "" }),
			true,
		);
		assert.equal(
			classifyNpmViewOutcome("@bastani/atomic-new", {
				exitCode: 1,
				stdout: "",
				stderr:
					"npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@bastani%2fatomic-new\n",
			}),
			false,
		);
		assert.equal(
			classifyNpmViewOutcome("@bastani/atomic-new", {
				exitCode: 1,
				stdout: "",
				stderr: "npm ERR! 404 '@bastani/atomic-new@latest' is not in this registry.\n",
			}),
			false,
		);
		assert.throws(
			() =>
				classifyNpmViewOutcome("@bastani/atomic", {
					exitCode: 1,
					stdout: "",
					stderr: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed\n",
				}),
			/`npm view @bastani\/atomic` exited 1 without a 404, so its registration is unknown.*ENOTFOUND/su,
		);
		assert.throws(
			() => classifyNpmViewOutcome("@bastani/atomic", { exitCode: null, stdout: "", stderr: "" }),
			/exited with a signal without a 404/u,
		);
	});

	test("a fully registered payload passes and probes every package exactly once", async () => {
		const names = readReleasePayloadPackages(root);
		const probe = probeFrom(new Set(names));
		const result = await verifyReleasePackagesRegistered({
			packages: names,
			isRegistered: probe.isRegistered,
			allowNew: false,
		});
		assert.deepEqual(result.unregistered, []);
		assert.deepEqual(result.checked, names);
		assert.deepEqual([...probe.asked].sort(), [...names].sort());
	});

	test("an unregistered package aborts, naming every missing package and the escape", async () => {
		const names = readReleasePayloadPackages(root);
		const registered = new Set(names);
		registered.delete("@bastani/atomic-natives-win32-arm64-msvc");
		registered.delete("@bastani/atomic");
		await assert.rejects(
			verifyReleasePackagesRegistered({
				packages: names,
				isRegistered: probeFrom(registered).isRegistered,
				allowNew: false,
			}),
			(error: Error) => {
				assert.match(error.message, /2 of 10 publish-payload packages are not registered on npm/u);
				assert.match(error.message, /^ {2}- @bastani\/atomic-natives-win32-arm64-msvc$/mu);
				assert.match(error.message, /^ {2}- @bastani\/atomic$/mu);
				assert.match(error.message, /Re-run with --allow-new/u);
				return true;
			},
		);
	});

	test("--allow-new permits a first publish and reports which names are new", async () => {
		const result = await verifyReleasePackagesRegistered({
			packages: ["@bastani/atomic", "@bastani/atomic-natives-new"],
			isRegistered: probeFrom(new Set(["@bastani/atomic"])).isRegistered,
			allowNew: true,
		});
		assert.deepEqual(result.unregistered, ["@bastani/atomic-natives-new"]);
		assert.deepEqual(result.checked, ["@bastani/atomic", "@bastani/atomic-natives-new"]);
	});

	test("--allow-new does not cover a probe that could not answer", async () => {
		await assert.rejects(
			verifyReleasePackagesRegistered({
				packages: ["@bastani/atomic", "@bastani/atomic-natives"],
				isRegistered: async (name) => {
					if (name === "@bastani/atomic-natives") throw new Error("registry unreachable");
					return true;
				},
				allowNew: true,
			}),
			(error: Error) => {
				assert.match(error.message, /could not be determined for 1 of 2 publish-payload packages/u);
				assert.match(error.message, /@bastani\/atomic-natives: registry unreachable/u);
				assert.match(error.message, /--allow-new does not cover an unreadable registry answer/u);
				return true;
			},
		);
	});

	test("an empty payload is refused rather than vacuously passing", async () => {
		await assert.rejects(
			verifyReleasePackagesRegistered({ packages: [], isRegistered: async () => true, allowNew: true }),
			/requires at least one package name/u,
		);
	});

	test("one missing package reads as singular", () => {
		assert.match(describeUnregisteredPackages(["@bastani/atomic"], 10), /1 of 10 publish-payload packages is not/u);
	});
});
