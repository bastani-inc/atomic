#!/usr/bin/env bun
/**
 * Builds the two shipped forms of Atomic from a built checkout, as users install them, for the startup benchmark:
 *
 *   --npm DIR     packs every workspace package `@bastani/atomic` depends on, and this host's platform package of
 *                 `@bastani/atomic-natives` (the binary the build wrote, as publish.yml packs it), and installs the
 *                 tarballs together under DIR, as `npm install -g` lays them out. Its bin directory is
 *                 DIR/node_modules/.bin.
 *   --binary DIR  builds this platform's release archive contents (the compiled launcher, `app.js` and assets)
 *                 into DIR, as the installer unpacks them.
 *
 * --repo DIR names the checkout (default: this one). It must already be built (`npm run build`).
 */
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const NPM_WORKSPACES = [
	"@bastani/atomic-natives",
	"@bastani/atomic-schema",
	"@bastani/atomic-telemetry",
	"@bastani/atomic-ai",
	"@bastani/atomic-agent-core",
	"@bastani/atomic-tui",
	"@bastani/atomic-codemode",
	"@bastani/atomic",
] as const;

function run(command: string, args: readonly string[], cwd: string): void {
	const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}`);
}

async function prepareNpm(repo: string, prefix: string): Promise<void> {
	const packs = join(prefix, "packs");
	await rm(prefix, { recursive: true, force: true });
	await mkdir(packs, { recursive: true });
	for (const workspace of NPM_WORKSPACES) {
		run("npm", ["pack", `--workspace=${workspace}`, "--pack-destination", packs, "--ignore-scripts"], repo);
	}
	await packNativePlatformPackage(repo, join(prefix, "platform-package"), packs);
	await writeFile(
		join(prefix, "package.json"),
		`${JSON.stringify({ name: "atomic-startup-benchmark", private: true })}\n`,
	);
	const tarballs = (await readdir(packs)).filter((name) => name.endsWith(".tgz")).map((name) => join(packs, name));
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", ...tarballs], prefix);
}

/** This host's napi target, as the platform package of `@bastani/atomic-natives` names it. */
function hostNativeTarget(): string {
	if (process.platform === "win32") return `win32-${process.arch}-msvc`;
	if (process.platform !== "linux") return `${process.platform}-${process.arch}`;
	const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
	return `linux-${process.arch}-${header?.glibcVersionRuntime ? "gnu" : "musl"}`;
}

/** `@bastani/atomic-natives` carries no binary of its own: pack this host's platform package from the built one. */
async function packNativePlatformPackage(repo: string, directory: string, packs: string): Promise<void> {
	const natives = join(repo, "packages", "natives");
	const target = hostNativeTarget();
	const binary = `atomic_natives.${target}.node`;
	const { version } = JSON.parse(await readFile(join(natives, "package.json"), "utf8")) as { version: string };
	await mkdir(directory, { recursive: true });
	await copyFile(join(natives, "native", binary), join(directory, binary));
	await writeFile(
		join(directory, "package.json"),
		`${JSON.stringify({ name: `@bastani/atomic-natives-${target}`, version, main: binary, files: [binary] })}\n`,
	);
	run("npm", ["pack", "--pack-destination", packs, "--ignore-scripts"], directory);
}

function hostPlatform(): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (process.platform === "win32") return `windows-${arch}`;
	if (process.platform === "darwin") return `darwin-${arch}`;
	return `linux-${arch}`;
}

async function prepareBinary(repo: string, directory: string): Promise<void> {
	const platform = hostPlatform();
	run(
		"bash",
		[
			"./scripts/build-binaries.sh",
			"--skip-install",
			"--skip-package-build",
			"--offline-model-data",
			"--platform",
			platform,
		],
		repo,
	);
	await rm(directory, { recursive: true, force: true });
	await cp(join(repo, "packages", "coding-agent", "binaries", platform), directory, { recursive: true });
}

const argv = process.argv.slice(2);
const values = new Map<string, string>();
for (let index = 0; index < argv.length; index += 2) {
	const flag = argv[index];
	const value = argv[index + 1];
	if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${flag ?? "<end>"}`);
	values.set(flag.slice(2), resolve(value));
}
const repo = values.get("repo") ?? resolve(import.meta.dir, "..", "..", "..");
const npmPrefix = values.get("npm");
const binaryDirectory = values.get("binary");
if (!npmPrefix && !binaryDirectory) throw new Error("required: --npm DIR and/or --binary DIR [--repo DIR]");
// Pack first: the binary build leaves dist/ as it found it, but the npm tarball should not depend on that.
if (npmPrefix) await prepareNpm(repo, npmPrefix);
if (binaryDirectory) await prepareBinary(repo, binaryDirectory);
