#!/usr/bin/env bun
/*
 * Package acceptance test for temporary patched Pi dependencies. The test packs
 * @bastani/atomic, inspects the .tgz for bundled patched Pi package markers,
 * installs the tarball into an external Bun consumer, proves Atomic resolves
 * pi-agent-core from its bundled node_modules, and runs a delayed-onUpdate
 * smoke test against that bundled core.
 *
 * Usage:
 *   bun run scripts/verify-bundled-patched-pi-install.ts
 *   SKIP_BUILD=1 bun run scripts/verify-bundled-patched-pi-install.ts
 *   KEEP_FIXTURE=1 bun run scripts/verify-bundled-patched-pi-install.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	bundledPackageJsonTarPath,
	bundledPackageTarPath,
	bundledPatchedPiRoots,
	bundledPiAgentCoreRootPackageName,
} from "./bundled-patched-pi-config.js";

const codingAgentRoot = resolve(import.meta.dir, "..");
const distIndexPath = join(codingAgentRoot, "dist", "index.js");
const skipBuild = process.env["SKIP_BUILD"] === "1";
const keepFixture = process.env["KEEP_FIXTURE"] === "1";

const REQUIRED_PACKAGE_JSON_PATHS = uniqueSorted(
	bundledPatchedPiRoots.flatMap((root) => [...root.expectedRuntimePackages]),
).map((packageName) => bundledPackageJsonTarPath(packageName));
const REQUIRED_MARKER_PATHS = bundledPatchedPiRoots.flatMap((root) =>
	root.markerFiles.map((markerFile) => ({
		path: bundledPackageTarPath(root.packageName, markerFile.relativePath),
		marker: markerFile.marker,
		description: markerFile.description,
	})),
);

interface CommandResult {
	readonly status: number;
	readonly output: string;
}

interface TarEntry {
	readonly name: string;
	readonly body: Buffer;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function run(command: string, args: readonly string[], cwd: string): CommandResult {
	const result = spawnSync(command, [...args], { cwd, encoding: "utf8", env: process.env });
	return {
		status: result.status ?? 1,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function fail(message: string): never {
	console.error(`\n❌ ${message}`);
	process.exit(1);
}

function readNullTerminated(buffer: Buffer, start: number, length: number): string {
	const slice = buffer.subarray(start, start + length);
	const nullIndex = slice.indexOf(0);
	const end = nullIndex >= 0 ? nullIndex : slice.length;
	return slice.subarray(0, end).toString("utf8");
}

function readOctal(buffer: Buffer, start: number, length: number): number {
	const raw = readNullTerminated(buffer, start, length).trim();
	return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

function stripTrailingNulls(value: string): string {
	return value.replace(/\0.*$/u, "");
}

function parseTarGz(tarballPath: string): TarEntry[] {
	const tar = gunzipSync(readFileSync(tarballPath));
	const entries: TarEntry[] = [];
	let offset = 0;
	let pendingLongName: string | undefined;

	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;

		const name = readNullTerminated(header, 0, 100);
		const size = readOctal(header, 124, 12);
		const typeflag = readNullTerminated(header, 156, 1);
		const prefix = readNullTerminated(header, 345, 155);
		const bodyStart = offset + 512;
		const bodyEnd = bodyStart + size;
		const body = Buffer.from(tar.subarray(bodyStart, bodyEnd));
		offset = bodyStart + Math.ceil(size / 512) * 512;

		if (typeflag === "L") {
			pendingLongName = stripTrailingNulls(body.toString("utf8"));
			continue;
		}

		const tarName = pendingLongName ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
		pendingLongName = undefined;
		entries.push({ name: tarName, body });
	}

	return entries;
}

function requireTarEntry(entries: readonly TarEntry[], path: string): TarEntry {
	const entry = entries.find((candidate) => candidate.name === path);
	if (!entry) fail(`Packed tarball is missing required entry: ${path}`);
	return entry;
}

function requireMarker(source: string, marker: string, label: string): void {
	if (!source.includes(marker)) {
		fail(`${label} does not contain the expected patched marker.`);
	}
}

function verifyTarballContents(tarballPath: string): void {
	const entries = parseTarGz(tarballPath);
	for (const packageJsonPath of REQUIRED_PACKAGE_JSON_PATHS) {
		requireTarEntry(entries, packageJsonPath);
	}

	for (const markerPath of REQUIRED_MARKER_PATHS) {
		const entry = requireTarEntry(entries, markerPath.path);
		requireMarker(entry.body.toString("utf8"), markerPath.marker, `Packed ${markerPath.path} (${markerPath.description})`);
	}

	console.log("• Tarball contains bundled patched Pi packages and required markers.");
}

function installedPackagePath(atomicRoot: string, tarEntryPath: string): string {
	return join(atomicRoot, ...tarEntryPath.replace(/^package\//u, "").split("/"));
}

function verifyInstalledBundledFiles(consumerDir: string): void {
	const atomicRoot = join(consumerDir, "node_modules", "@bastani", "atomic");
	for (const packageJsonPath of REQUIRED_PACKAGE_JSON_PATHS) {
		const installedPath = installedPackagePath(atomicRoot, packageJsonPath);
		if (!existsSync(installedPath)) {
			fail(`Installed consumer is missing bundled dependency entry: ${installedPath}`);
		}
	}

	for (const markerPath of REQUIRED_MARKER_PATHS) {
		const installedPath = installedPackagePath(atomicRoot, markerPath.path);
		requireMarker(readFileSync(installedPath, "utf8"), markerPath.marker, `Installed consumer ${installedPath}`);
	}
}

const consumerSmokeScript = String.raw`
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const atomicPackageJson = require.resolve("@bastani/atomic/package.json");
const atomicRoot = dirname(atomicPackageJson);
const corePackageJson = require.resolve("@earendil-works/pi-agent-core/package.json", { paths: [atomicPackageJson] });
const expectedCorePrefix = resolve(atomicRoot, "node_modules", "@earendil-works", "pi-agent-core");
if (corePackageJson !== resolve(expectedCorePrefix, "package.json")) {
	throw new Error("Expected bundled pi-agent-core under " + expectedCorePrefix + ", got " + corePackageJson);
}

await import("@bastani/atomic");

const { Agent } = await import(pathToFileURL(resolve(expectedCorePrefix, "dist", "index.js")).href);
const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let streamCalls = 0;
let delayedUpdate;
const events = [];
const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
try {
	const agent = new Agent({
		streamFn: async () => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "done" };
			},
			async result() {
				streamCalls += 1;
				if (streamCalls === 1) {
					return {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "delayed_tool", arguments: {} }],
						api: "test",
						provider: "test",
						model: "test",
						usage: emptyUsage,
						stopReason: "toolUse",
						timestamp: Date.now(),
					};
				}
				return {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: emptyUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
			},
		}),
		initialState: {
			tools: [{
				name: "delayed_tool",
				label: "Delayed Tool",
				description: "Streams updates for bundled patched core smoke tests",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				execute: async (_toolCallId, _params, _signal, onUpdate) => {
					onUpdate?.({ content: [{ type: "text", text: "running" }], details: { status: "running" } });
					delayedUpdate = onUpdate;
					return {
						content: [{ type: "text", text: "ok" }],
						details: { status: "done" },
						terminate: true,
					};
				},
			}],
		},
	});
	agent.subscribe((event) => events.push(event));
	await agent.prompt("run");
	const updatesBeforeLateCallback = events.filter((event) => event.type === "tool_execution_update").length;
	if (updatesBeforeLateCallback !== 1) {
		throw new Error("Expected one active tool_execution_update, got " + updatesBeforeLateCallback);
	}
	const eventCountAfterPrompt = events.length;
	delayedUpdate?.({ content: [{ type: "text", text: "late" }], details: { status: "late" } });
	await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
	if (events.length !== eventCountAfterPrompt) {
		throw new Error("Delayed onUpdate emitted an event after tool settlement");
	}
	if (unhandled.length > 0) {
		throw new Error("Delayed onUpdate produced unhandled rejection: " + String(unhandled[0]));
	}
	console.log("bundled core ok: " + corePackageJson);
} finally {
	process.off("unhandledRejection", onUnhandled);
}
`;

const packageVersion = (JSON.parse(readFileSync(join(codingAgentRoot, "package.json"), "utf8")) as { version?: string }).version;
console.log(`Verifying bundled patched Pi packages for @bastani/atomic@${packageVersion ?? "?"}\n`);

const workRoot = mkdtempSync(join(tmpdir(), "atomic-bundled-patched-pi-"));
console.log(`• Fixture root: ${workRoot}`);

try {
	if (!skipBuild) {
		console.log("• Building @bastani/atomic (set SKIP_BUILD=1 to reuse current dist)...");
		const build = run("bun", ["run", "build"], codingAgentRoot);
		if (build.status !== 0) {
			console.error(build.output);
			fail("Build failed.");
		}
	} else {
		console.log("• SKIP_BUILD=1 — reusing current dist.");
	}

	if (!existsSync(distIndexPath)) {
		fail(`Missing ${distIndexPath}; run bun run --cwd packages/coding-agent build first or omit SKIP_BUILD=1.`);
	}

	// `bun pm pack` is what materializes the bundled patched Pi packages: it fires the package's
	// `prepack` (materialize) and `postpack` (--clean) lifecycle hooks, so we deliberately do not
	// run the non-clean materialize ourselves here — only the explicit `--clean` below as a belt-and-
	// suspenders cleanup. A Bun version that changes pack lifecycle behavior would break both this
	// verifier and publishing, which relies on the same prepack/postpack hooks.
	console.log("• Packing @bastani/atomic with bun pm pack...");
	const pack = run("bun", ["pm", "pack", "--destination", workRoot], codingAgentRoot);
	const explicitCleanup = run("bun", ["run", "scripts/materialize-bundled-patched-pi.ts", "--clean"], codingAgentRoot);
	if (explicitCleanup.status !== 0) {
		console.error(explicitCleanup.output);
		fail("Bundled patched Pi cleanup failed after pack attempt.");
	}
	if (pack.status !== 0) {
		console.error(pack.output);
		fail("bun pm pack failed.");
	}

	const tarball = readdirSync(workRoot).find((fileName) => fileName.endsWith(".tgz"));
	if (!tarball) fail("No .tgz produced by bun pm pack.");
	const tarballPath = join(workRoot, tarball);
	console.log(`• Tarball: ${tarballPath}`);
	verifyTarballContents(tarballPath);

	const consumerDir = join(workRoot, "consumer");
	rmSync(consumerDir, { recursive: true, force: true });
	mkdirSync(consumerDir, { recursive: true });
	writeFileSync(
		join(consumerDir, "package.json"),
		JSON.stringify(
			{
				name: "atomic-bundled-patched-pi-consumer",
				private: true,
				type: "module",
				dependencies: { "@bastani/atomic": `file:${tarballPath}` },
			},
			null,
			2,
		),
		"utf8",
	);

	console.log("• Installing tarball into isolated Bun consumer...");
	const install = run("bun", ["install", "--no-progress"], consumerDir);
	if (install.status !== 0) {
		console.error(install.output);
		fail("Isolated consumer bun install failed.");
	}
	verifyInstalledBundledFiles(consumerDir);

	console.log("• Verifying isolated consumer resolution and delayed onUpdate smoke...");
	const smokePath = join(consumerDir, "verify-bundled-patched-pi-consumer.mjs");
	writeFileSync(smokePath, consumerSmokeScript, "utf8");
	const smoke = run("bun", [smokePath], consumerDir);
	if (smoke.status !== 0) {
		console.error(smoke.output);
		fail(`Isolated consumer smoke failed for ${bundledPiAgentCoreRootPackageName}.`);
	}
	console.log(smoke.output.trim());
	console.log("\n✓ Bundled patched Pi tarball installed, resolved, and smoked successfully.");
} finally {
	if (!keepFixture) {
		rmSync(workRoot, { recursive: true, force: true });
	} else {
		console.log(`• KEEP_FIXTURE=1 — left fixtures at ${workRoot}`);
	}
}
