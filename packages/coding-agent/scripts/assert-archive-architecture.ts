import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * `scripts/build-binaries.sh` builds every release archive on one runner and copies that
 * runner's `node_modules` into all of them. Atomic 0.9.12 therefore shipped
 * `@esbuild/linux-x64` inside `atomic-linux-arm64.tar.gz` and `atomic-darwin-arm64.tar.gz`.
 * This check reads each staged package's own `os`/`cpu`/`libc` declaration and fails the build
 * when a package cannot run on the archive it was placed in, so the next verbatim-copied native
 * dependency cannot repeat that silently.
 */

export interface ArchiveTarget {
	readonly os: string;
	readonly cpu: string;
	/** Only meaningful on Linux; npm omits `libc` elsewhere. */
	readonly libc?: string;
}

export const ARCHIVE_TARGETS = {
	"darwin-arm64": { os: "darwin", cpu: "arm64" },
	"darwin-x64": { os: "darwin", cpu: "x64" },
	"linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
	"linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
	"linux-x64-musl": { os: "linux", cpu: "x64", libc: "musl" },
	"linux-arm64-musl": { os: "linux", cpu: "arm64", libc: "musl" },
	"windows-x64": { os: "win32", cpu: "x64" },
	"windows-arm64": { os: "win32", cpu: "arm64" },
} satisfies Record<string, ArchiveTarget>;

export type ArchivePlatform = keyof typeof ARCHIVE_TARGETS;

interface MultiTargetFamily {
	readonly prefix: string;
	readonly reason: string;
}

/**
 * Package families the build stages for every release target on purpose. Each entry needs a
 * reason naming the script that stages it, so an accidental verbatim copy is never mistaken
 * for a deliberate one.
 */
export const MULTI_TARGET_PACKAGE_FAMILIES: readonly MultiTargetFamily[] = [
	{
		prefix: "@mariozechner/clipboard-",
		reason:
			"copy-clipboard-native-bindings.ts stages every release target's clipboard binding into the shared runtime directory; the loader selects one at runtime",
	},
];

interface PlatformManifest {
	readonly name?: string;
	readonly os?: readonly string[];
	readonly cpu?: readonly string[];
	readonly libc?: readonly string[];
}

export interface ArchiveArchitectureMismatch {
	/** Package directory relative to the archive root. */
	readonly path: string;
	readonly name: string;
	readonly declared: { os?: readonly string[]; cpu?: readonly string[]; libc?: readonly string[] };
}

export interface AssertArchiveArchitectureOptions {
	readonly archiveRoot: string;
	readonly platform: ArchivePlatform;
}

/** npm field semantics: a leading `!` excludes, and a list of inclusions is exhaustive. */
function fieldMatches(declared: readonly string[] | undefined, value: string | undefined): boolean {
	if (declared === undefined || declared.length === 0) return true;
	if (value === undefined) return true;
	const excluded = declared.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));
	if (excluded.includes(value)) return false;
	const included = declared.filter((entry) => !entry.startsWith("!"));
	return included.length === 0 || included.includes(value);
}

function isMultiTargetFamily(packageName: string): boolean {
	return MULTI_TARGET_PACKAGE_FAMILIES.some((family) => packageName.startsWith(family.prefix));
}

function readManifest(packageJsonPath: string): PlatformManifest | undefined {
	try {
		return JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PlatformManifest;
	} catch {
		// A package directory without a readable manifest declares no platform constraint.
		return undefined;
	}
}

function collectPackageDirectories(root: string, found: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	if (entries.includes("package.json")) found.push(root);
	for (const entry of entries) {
		if (entry === "package.json") continue;
		const candidate = join(root, entry);
		let isDirectory = false;
		try {
			isDirectory = statSync(candidate).isDirectory();
		} catch {
			continue;
		}
		if (isDirectory) collectPackageDirectories(candidate, found);
	}
}

/** Every platform-specific package staged into the archive that cannot run on its target. */
export function findArchiveArchitectureMismatches(
	options: AssertArchiveArchitectureOptions,
): ArchiveArchitectureMismatch[] {
	const target: ArchiveTarget = ARCHIVE_TARGETS[options.platform];
	const archiveRoot = resolve(options.archiveRoot);
	const nodeModules = join(archiveRoot, "node_modules");
	if (!existsSync(nodeModules)) return [];

	const packageDirectories: string[] = [];
	collectPackageDirectories(nodeModules, packageDirectories);

	const mismatches: ArchiveArchitectureMismatch[] = [];
	for (const directory of packageDirectories) {
		const manifest = readManifest(join(directory, "package.json"));
		if (manifest === undefined) continue;
		const declaresPlatform =
			(manifest.os?.length ?? 0) > 0 || (manifest.cpu?.length ?? 0) > 0 || (manifest.libc?.length ?? 0) > 0;
		if (!declaresPlatform) continue;

		const name = manifest.name ?? relative(nodeModules, directory).split(/[\\/]/u).join("/");
		if (isMultiTargetFamily(name)) continue;

		const matches =
			fieldMatches(manifest.os, target.os) &&
			fieldMatches(manifest.cpu, target.cpu) &&
			fieldMatches(manifest.libc, target.libc);
		if (matches) continue;

		mismatches.push({
			path: relative(archiveRoot, directory).split(/[\\/]/u).join("/"),
			name,
			declared: { os: manifest.os, cpu: manifest.cpu, libc: manifest.libc },
		});
	}

	return mismatches.sort((left, right) => left.path.localeCompare(right.path));
}

export function assertArchiveArchitecture(options: AssertArchiveArchitectureOptions): void {
	const target: ArchiveTarget | undefined = ARCHIVE_TARGETS[options.platform];
	if (target === undefined) throw new Error(`Unknown archive platform: ${options.platform}`);

	const mismatches = findArchiveArchitectureMismatches(options);
	if (mismatches.length === 0) return;

	const details = mismatches
		.map((mismatch) => {
			const declared = [
				mismatch.declared.os ? `os=${mismatch.declared.os.join(",")}` : undefined,
				mismatch.declared.cpu ? `cpu=${mismatch.declared.cpu.join(",")}` : undefined,
				mismatch.declared.libc ? `libc=${mismatch.declared.libc.join(",")}` : undefined,
			]
				.filter((entry) => entry !== undefined)
				.join(" ");
			return `  ${mismatch.path} (${mismatch.name}) declares ${declared}`;
		})
		.join("\n");

	const expected = [`os=${target.os}`, `cpu=${target.cpu}`, target.libc ? `libc=${target.libc}` : undefined]
		.filter((entry) => entry !== undefined)
		.join(" ");

	throw new Error(
		`Wrong-architecture packages staged for the ${options.platform} archive (expected ${expected}):\n${details}`,
	);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let archiveRoot: string | undefined;
	let platform: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--platform") {
			platform = args[index + 1];
			if (!platform) throw new Error("--platform requires a value");
			index += 1;
			continue;
		}
		if (archiveRoot === undefined && arg !== undefined) {
			archiveRoot = arg;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (!archiveRoot) throw new Error("Usage: assert-archive-architecture.ts <archive-root> --platform <name>");
	if (!platform || !(platform in ARCHIVE_TARGETS)) {
		throw new Error(`--platform must be one of: ${Object.keys(ARCHIVE_TARGETS).join(", ")}`);
	}
	assertArchiveArchitecture({ archiveRoot, platform: platform as ArchivePlatform });
	console.log(`Archive architecture verified for ${platform}.`);
}
