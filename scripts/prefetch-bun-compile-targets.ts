/**
 * Puts the Bun runtimes that `bun build --compile --target=<target>` embeds where Bun
 * looks for them, so scripts/build-binaries.sh never downloads one itself.
 *
 * Bun 1.4.4 resolves a cross-compile target to `$BUN_INSTALL_CACHE_DIR/<name>-v<version>`
 * (`$HOME/.bun/install/cache` when the variable is unset) and, if that file is missing,
 * fetches `https://registry.npmjs.org/@oven/<name>/-/<name>-<version>.tgz` on one
 * connection with no retry. On CI runners that fetch has run at about 45 KB/s, which
 * takes the ~52 MB tarball past the job's timeout.
 *
 * This script keeps the tarballs in `<tarball-dir>`, which CI caches. Every tarball,
 * cached or freshly downloaded, is checked against the registry's published sha512
 * before its runtime is extracted, so a cache entry cannot swap the runtime that ships.
 * A download that stalls is resumed on a new connection rather than waited out.
 *
 * Usage: bun run scripts/prefetch-bun-compile-targets.ts <tarball-dir> <platform>...
 * Platforms are the scripts/build-binaries.sh names (linux-x64, windows-arm64, ...).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = "https://registry.npmjs.org";
const PLATFORMS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
	"windows-x64",
	"windows-arm64",
] as const;
type Platform = (typeof PLATFORMS)[number];
/** Consecutive attempts that add no bytes before the download is abandoned. */
const ATTEMPTS_WITHOUT_PROGRESS = 5;

function isPlatform(value: string): value is Platform {
	return (PLATFORMS as readonly string[]).includes(value);
}

/** Bun's cache and npm name for the runtime build-binaries.sh compiles `platform` with. */
function runtimeName(platform: Platform): string {
	const [os, arch, libc] = platform.split("-");
	// build-binaries.sh compiles every x64 target, musl included, against the baseline runtime.
	const baseline = arch === "x64" ? "-baseline" : "";
	return `bun-${os}-${arch === "arm64" ? "aarch64" : arch}${libc ? `-${libc}` : ""}${baseline}`;
}

async function publishedIntegrity(name: string, version: string): Promise<string> {
	const url = `${REGISTRY}/@oven/${name}/${version}`;
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const manifest = (await response.json()) as { dist?: { integrity?: string } };
			const integrity = manifest.dist?.integrity;
			if (!integrity?.startsWith("sha512-")) throw new Error("no sha512 integrity in the manifest");
			return integrity;
		} catch (error) {
			if (attempt >= 3) throw new Error(`Cannot read ${url}: ${error instanceof Error ? error.message : error}`);
			console.log(`Retrying ${url} after: ${error instanceof Error ? error.message : error}`);
		}
	}
}

function sha512Integrity(file: string): string {
	return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

function sizeOf(file: string): number {
	return existsSync(file) ? statSync(file).size : 0;
}

/**
 * Downloads `url` to `file`, resuming on a fresh connection whenever a transfer stalls or
 * drops. A slow transfer keeps going as long as it makes progress; the job's own timeout
 * bounds it, as it bounded Bun's download.
 */
function download(url: string, file: string): void {
	const partial = `${file}.partial`;
	rmSync(partial, { force: true });
	let withoutProgress = 0;
	for (let attempt = 1; withoutProgress < ATTEMPTS_WITHOUT_PROGRESS; attempt++) {
		const before = sizeOf(partial);
		const result = Bun.spawnSync(
			[
				"curl",
				"--fail",
				"--location",
				"--silent",
				"--show-error",
				"--connect-timeout",
				"15",
				// Below 100 KB/s for 20 s is a stalled connection: drop it and resume on another.
				"--speed-limit",
				"102400",
				"--speed-time",
				"20",
				"--continue-at",
				"-",
				"--output",
				partial,
				url,
			],
			{ stdout: "inherit", stderr: "inherit" },
		);
		if (result.exitCode === 0) {
			renameSync(partial, file);
			return;
		}
		const after = sizeOf(partial);
		withoutProgress = after > before ? 0 : withoutProgress + 1;
		console.log(`Download attempt ${attempt} of ${url} ended with curl exit ${result.exitCode} at ${after} bytes`);
	}
	rmSync(partial, { force: true });
	throw new Error(`Cannot download ${url}`);
}

async function prefetch(platform: Platform, tarballDir: string, runtimeDir: string, version: string): Promise<void> {
	const name = runtimeName(platform);
	const tarball = join(tarballDir, `${name}-${version}.tgz`);
	const integrity = await publishedIntegrity(name, version);
	if (existsSync(tarball) && sha512Integrity(tarball) === integrity) {
		console.log(`${name} ${version}: verified cached tarball`);
	} else {
		if (existsSync(tarball)) console.log(`${name} ${version}: cached tarball fails its sha512, downloading again`);
		const started = performance.now();
		download(`${REGISTRY}/@oven/${name}/-/${name}-${version}.tgz`, tarball);
		const actual = sha512Integrity(tarball);
		if (actual !== integrity) {
			rmSync(tarball, { force: true });
			throw new Error(`${name} ${version}: downloaded tarball is ${actual}, registry publishes ${integrity}`);
		}
		console.log(
			`${name} ${version}: downloaded and verified in ${((performance.now() - started) / 1000).toFixed(1)}s`,
		);
	}

	const entry = `package/bin/${platform.startsWith("windows-") ? "bun.exe" : "bun"}`;
	const files = await new Bun.Archive(readFileSync(tarball)).files();
	const runtime = files.get(entry);
	if (!runtime) throw new Error(`${tarball} has no ${entry}`);
	const destination = join(runtimeDir, `${name}-v${version}`);
	writeFileSync(destination, await runtime.bytes(), { mode: 0o755 });
	console.log(`${name} ${version}: runtime at ${destination}`);
}

async function main(): Promise<void> {
	const [tarballDir, ...platforms] = process.argv.slice(2);
	if (!tarballDir || platforms.length === 0) {
		throw new Error("Usage: bun run scripts/prefetch-bun-compile-targets.ts <tarball-dir> <platform>...");
	}
	const invalid = platforms.filter((platform) => !isPlatform(platform));
	if (invalid.length > 0) throw new Error(`Invalid platform: ${invalid.join(", ")}; valid: ${PLATFORMS.join(", ")}`);

	// The same resolution Bun 1.4.4 applies when `bun build --compile` looks for a target runtime.
	const runtimeDir =
		process.env.BUN_INSTALL_CACHE_DIR ||
		(process.env.HOME ? join(process.env.HOME, ".bun", "install", "cache") : ".bun-cache");
	mkdirSync(tarballDir, { recursive: true });
	mkdirSync(runtimeDir, { recursive: true });
	for (const platform of new Set(platforms.filter(isPlatform))) {
		await prefetch(platform, tarballDir, runtimeDir, Bun.version);
	}
}

await main();
