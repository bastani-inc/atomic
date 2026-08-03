import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CLIPBOARD_NATIVE_TARGETS,
	CLIPBOARD_PLATFORMS_WITHOUT_BINDING,
	copyClipboardNativeBindings,
} from "../scripts/copy-clipboard-native-bindings.ts";
import { stageClipboardNativePackages } from "../scripts/stage-clipboard-native-bindings.ts";

const tempDirs: string[] = [];

interface ClipboardWrapperMetadata {
	readonly version: string;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface MissingClipboardLeaf {
	readonly platform: string;
	readonly packageName: string;
}

// Missing musl leaves require a real Bun package staging install; this structural network cost exceeds the suite default.
const REAL_CLIPBOARD_STALENESS_GUARD_TIMEOUT_MS = 180_000;

function clipboardPackageDirectory(nodeModulesRoot: string, packageName: string): string {
	return join(nodeModulesRoot, ...packageName.split("/"));
}

function nativeBindingFiles(packageDirectory: string): string[] {
	const nativeFiles: string[] = [];
	for (const entry of readdirSync(packageDirectory, { withFileTypes: true })) {
		const entryPath = join(packageDirectory, entry.name);
		if (entry.isDirectory()) {
			nativeFiles.push(...nativeBindingFiles(entryPath));
		} else if (entry.isFile() && entry.name.endsWith(".node")) {
			nativeFiles.push(entryPath);
		}
	}
	return nativeFiles;
}

function muslClipboardRemediation(platform: string): string {
	return (
		`Upstream now ships a real musl binding for ${platform}; remove ${platform} from ` +
		"CLIPBOARD_PLATFORMS_WITHOUT_BINDING and add it to CLIPBOARD_NATIVE_TARGETS in " +
		"packages/coding-agent/scripts/copy-clipboard-native-bindings.ts."
	);
}

function readClipboardWrapperMetadata(repoRoot: string): ClipboardWrapperMetadata {
	const packageJsonPath = join(repoRoot, "node_modules", "@mariozechner", "clipboard", "package.json");
	if (!existsSync(packageJsonPath)) {
		throw new Error(`Clipboard wrapper metadata is missing: ${packageJsonPath}`);
	}
	try {
		return JSON.parse(readFileSync(packageJsonPath, "utf-8")) as ClipboardWrapperMetadata;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Clipboard wrapper metadata could not be inspected: ${detail}`);
	}
}

function writePackage(root: string, packageName: string, version: string, bindingName?: string): void {
	const packageDir = join(root, ...packageName.split("/"));
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName, version }));
	if (bindingName) {
		writeFileSync(join(packageDir, bindingName), `binding:${packageName}`);
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("standalone clipboard native packaging", () => {
	it("copies every target's 0.3.9-compatible binding beside the generic wrapper", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-packaging-"));
		tempDirs.push(root);
		const sourceNodeModules = join(root, "source");
		const destinationNodeModules = join(root, "destination");
		writePackage(sourceNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(destinationNodeModules, "@mariozechner/clipboard", "0.3.9");

		for (const target of Object.values(CLIPBOARD_NATIVE_TARGETS)) {
			writePackage(sourceNodeModules, target.packageName, "0.3.9", target.bindingName);
		}

		copyClipboardNativeBindings({
			sourceNodeModules,
			destinationNodeModules,
			platforms: Object.keys(CLIPBOARD_NATIVE_TARGETS),
		});

		for (const target of Object.values(CLIPBOARD_NATIVE_TARGETS)) {
			const copied = join(destinationNodeModules, "@mariozechner", "clipboard", target.bindingName);
			expect(readFileSync(copied, "utf-8")).toBe(`binding:${target.packageName}`);
		}
	});
	it("skips the metadata-only musl leaves instead of sending them to the strict copier", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-musl-packaging-"));
		tempDirs.push(root);
		const sourceNodeModules = join(root, "source");
		const destinationNodeModules = join(root, "destination");
		writePackage(sourceNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(destinationNodeModules, "@mariozechner/clipboard", "0.3.9");

		expect(CLIPBOARD_PLATFORMS_WITHOUT_BINDING).toEqual(["linux-x64-musl", "linux-arm64-musl"]);
		expect(() =>
			copyClipboardNativeBindings({
				sourceNodeModules,
				destinationNodeModules,
				platforms: CLIPBOARD_PLATFORMS_WITHOUT_BINDING,
			}),
		).not.toThrow();
		expect(readdirSync(join(destinationNodeModules, "@mariozechner", "clipboard"))).toEqual(["package.json"]);
	});
	it(
		"fails loudly if an excluded musl leaf gains a native binding",
		() => {
			const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
			const wrapperMetadata = readClipboardWrapperMetadata(repoRoot);
			if (!wrapperMetadata.version.trim()) {
				throw new Error("Clipboard wrapper metadata has no version; the staleness guard cannot be evaluated");
			}
			const optionalDependencies = wrapperMetadata.optionalDependencies;
			if (!optionalDependencies) {
				throw new Error("Clipboard wrapper has no optionalDependencies; the staleness guard cannot be evaluated");
			}

			const rootNodeModules = join(repoRoot, "node_modules");
			const packageDirectories = new Map<string, string>();
			const missingLeaves: MissingClipboardLeaf[] = [];
			for (const platform of CLIPBOARD_PLATFORMS_WITHOUT_BINDING) {
				const packageName = `@mariozechner/clipboard-${platform}`;
				const declaredVersion = optionalDependencies[packageName];
				if (!declaredVersion) {
					throw new Error(
						`Clipboard wrapper no longer declares ${packageName}; the musl staleness guard cannot be evaluated`,
					);
				}
				if (declaredVersion !== wrapperMetadata.version) {
					throw new Error(
						`Clipboard wrapper declares ${packageName}@${declaredVersion}, not its own version ${wrapperMetadata.version}; the musl staleness guard cannot be evaluated`,
					);
				}

				const packageDirectory = clipboardPackageDirectory(rootNodeModules, packageName);
				if (existsSync(packageDirectory)) {
					packageDirectories.set(platform, packageDirectory);
				} else {
					missingLeaves.push({ platform, packageName });
				}
			}

			if (missingLeaves.length > 0) {
				const stagingRoot = mkdtempSync(join(tmpdir(), "atomic-clipboard-musl-guard-"));
				tempDirs.push(stagingRoot);
				try {
					stageClipboardNativePackages({
						destination: stagingRoot,
						version: wrapperMetadata.version,
						packageNames: missingLeaves.map(({ packageName }) => packageName),
					});
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					const platforms = missingLeaves.map(({ platform }) => platform).join(", ");
					throw new Error(`Clipboard musl staleness guard could not inspect ${platforms}: ${detail}`);
				}

				const stagedNodeModules = join(stagingRoot, "node_modules");
				for (const { platform, packageName } of missingLeaves) {
					const packageDirectory = clipboardPackageDirectory(stagedNodeModules, packageName);
					if (!existsSync(packageDirectory)) {
						throw new Error(
							`Clipboard musl staleness guard could not inspect ${platform}: staged package ${packageName} is missing`,
						);
					}
					packageDirectories.set(platform, packageDirectory);
				}
			}

			for (const platform of CLIPBOARD_PLATFORMS_WITHOUT_BINDING) {
				const packageDirectory = packageDirectories.get(platform);
				if (!packageDirectory) {
					throw new Error(
						`Clipboard musl staleness guard could not inspect ${platform}: package path is unavailable`,
					);
				}
				if (!existsSync(join(packageDirectory, "package.json"))) {
					throw new Error(
						`Clipboard musl staleness guard could not inspect ${platform}: package metadata is missing`,
					);
				}
				let nativeFiles: string[];
				try {
					nativeFiles = nativeBindingFiles(packageDirectory);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					throw new Error(`Clipboard musl staleness guard could not inspect ${platform}: ${detail}`);
				}
				if (nativeFiles.length > 0) {
					throw new Error(`${muslClipboardRemediation(platform)} Found: ${nativeFiles.join(", ")}`);
				}
			}
		},
		REAL_CLIPBOARD_STALENESS_GUARD_TIMEOUT_MS,
	);

	it("rejects a native package version that differs from the generic wrapper", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-version-"));
		tempDirs.push(root);
		const sourceNodeModules = join(root, "source");
		const destinationNodeModules = join(root, "destination");
		const [platform, target] = Object.entries(CLIPBOARD_NATIVE_TARGETS)[0]!;
		writePackage(sourceNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(destinationNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(sourceNodeModules, target.packageName, "0.3.2", target.bindingName);

		expect(() =>
			copyClipboardNativeBindings({ sourceNodeModules, destinationNodeModules, platforms: [platform] }),
		).toThrow(/version mismatch.*0\.3\.9.*0\.3\.2/i);
	});

	it("keeps release copies strict while skip mode copies available bindings and tolerates missing optional packages", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-skip-"));
		tempDirs.push(root);
		const sourceNodeModules = join(root, "source");
		const destinationNodeModules = join(root, "destination");
		const entries = Object.entries(CLIPBOARD_NATIVE_TARGETS);
		const [availablePlatform, availableTarget] = entries[0]!;
		const [missingPlatform] = entries[1]!;
		writePackage(sourceNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(destinationNodeModules, "@mariozechner/clipboard", "0.3.9");
		writePackage(sourceNodeModules, availableTarget.packageName, "0.3.9", availableTarget.bindingName);

		expect(() =>
			copyClipboardNativeBindings({
				sourceNodeModules,
				destinationNodeModules,
				platforms: [availablePlatform, missingPlatform],
			}),
		).toThrow(/metadata not found/i);

		copyClipboardNativeBindings({
			sourceNodeModules,
			destinationNodeModules,
			platforms: [availablePlatform, missingPlatform],
			allowMissing: true,
		});
		expect(
			readFileSync(join(destinationNodeModules, "@mariozechner", "clipboard", availableTarget.bindingName), "utf-8"),
		).toBe(`binding:${availableTarget.packageName}`);
	});

	it("allows an absent optional destination wrapper only in skip mode", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-wrapper-skip-"));
		tempDirs.push(root);
		const sourceNodeModules = join(root, "source");
		const destinationNodeModules = join(root, "destination");
		const [platform] = Object.keys(CLIPBOARD_NATIVE_TARGETS);

		expect(() =>
			copyClipboardNativeBindings({
				sourceNodeModules,
				destinationNodeModules,
				platforms: [platform!],
				allowMissing: true,
			}),
		).not.toThrow();
		expect(() =>
			copyClipboardNativeBindings({ sourceNodeModules, destinationNodeModules, platforms: [platform!] }),
		).toThrow(/metadata not found/i);
	});

	it("canonicalizes a relative clipboard staging path before changing directories", () => {
		const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
		const buildScript = readFileSync(join(repoRoot, "scripts", "build-binaries.sh"), "utf-8");
		const stageCreationIndex = buildScript.indexOf('CLIPBOARD_STAGE_DIR="$(mktemp -d');
		const canonicalizationIndex = buildScript.indexOf(
			'CLIPBOARD_STAGE_DIR="$(cd -- "$CLIPBOARD_STAGE_DIR" && pwd -P)"',
		);
		const codingAgentCdIndex = buildScript.indexOf("cd packages/coding-agent");

		expect(stageCreationIndex).toBeGreaterThan(-1);
		expect(canonicalizationIndex).toBeGreaterThan(stageCreationIndex);
		expect(canonicalizationIndex).toBeLessThan(codingAgentCdIndex);
	});

	it("resolves a caller-relative TMPDIR before entering the repository", () => {
		const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
		const buildScript = join(repoRoot, "scripts", "build-binaries.sh");
		const callerRoot = mkdtempSync(join(tmpdir(), "atomic-clipboard-external-cwd-"));
		tempDirs.push(callerRoot);
		mkdirSync(join(callerRoot, "relative-tmp"));

		const result = spawnSync("bash", [buildScript, "--platform", "not-a-platform"], {
			cwd: callerRoot,
			env: { ...process.env, TMPDIR: "relative-tmp" },
			encoding: "utf-8",
		});
		const output = `${result.stdout}${result.stderr}`;

		expect(result.status).toBe(1);
		expect(output).toContain("Invalid platform: not-a-platform");
		expect(output).not.toMatch(/No such file or directory/i);
	});

	it("fails loudly when a caller-relative TMPDIR does not exist", () => {
		const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
		const buildScript = join(repoRoot, "scripts", "build-binaries.sh");
		const callerRoot = mkdtempSync(join(tmpdir(), "atomic-clipboard-missing-tmpdir-"));
		tempDirs.push(callerRoot);
		const bashEnv = join(callerRoot, "bash-env.sh");
		writeFileSync(bashEnv, "TMPDIR='missing-relative-tmp'\nexport TMPDIR\n");

		const result = spawnSync("bash", [buildScript, "--platform", "not-a-platform"], {
			cwd: callerRoot,
			env: { ...process.env, BASH_ENV: bashEnv },
			encoding: "utf-8",
		});
		const output = `${result.stdout}${result.stderr}`;

		expect(result.status).toBe(1);
		expect(output).toMatch(/No such file or directory/i);
		expect(output).toContain("missing-relative-tmp");
		expect(output).not.toContain("Invalid platform: not-a-platform");
	});

	it("normalizes TMPDIR before the robust repository-root directory change", () => {
		const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
		const buildScript = readFileSync(join(repoRoot, "scripts", "build-binaries.sh"), "utf-8");
		const tmpdirNormalizationIndex = buildScript.indexOf('TMPDIR="$(cd -- "$TMPDIR" && pwd -P)"');
		const repoCdIndex = buildScript.indexOf('cd -- "$(dirname -- "$0")/.."');

		expect(tmpdirNormalizationIndex).toBeGreaterThan(-1);
		expect(repoCdIndex).toBeGreaterThan(tmpdirNormalizationIndex);
	});

	it("stages and copies every release target through Bun's real cross-platform install path", () => {
		const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
		// bun.lock was deleted when install moved to `npm ci`; package-lock.json
		// is now the single lockfile this staging must leave untouched.
		const protectedFiles = [
			"package.json",
			"package-lock.json",
			"packages/coding-agent/npm-shrinkwrap.json",
		] as const;
		const before = new Map(protectedFiles.map((path) => [path, readFileSync(join(repoRoot, path), "utf-8")]));
		const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-real-stage-"));
		try {
			const stageRoot = join(root, "stage");
			const destinationNodeModules = join(root, "destination", "node_modules");
			const wrapperMetadata = JSON.parse(
				readFileSync(join(repoRoot, "node_modules", "@mariozechner", "clipboard", "package.json"), "utf-8"),
			) as { version: string };
			writePackage(destinationNodeModules, "@mariozechner/clipboard", wrapperMetadata.version);

			stageClipboardNativePackages({
				destination: stageRoot,
				version: wrapperMetadata.version,
			});
			const sourceNodeModules = join(stageRoot, "node_modules");
			for (const target of Object.values(CLIPBOARD_NATIVE_TARGETS)) {
				const packageDir = join(sourceNodeModules, ...target.packageName.split("/"));
				const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as {
					version: string;
				};
				expect(metadata.version).toBe(wrapperMetadata.version);
				expect(existsSync(join(packageDir, target.bindingName))).toBe(true);
			}

			copyClipboardNativeBindings({
				sourceNodeModules,
				destinationNodeModules,
				platforms: Object.keys(CLIPBOARD_NATIVE_TARGETS),
			});
			for (const target of Object.values(CLIPBOARD_NATIVE_TARGETS)) {
				expect(existsSync(join(destinationNodeModules, "@mariozechner", "clipboard", target.bindingName))).toBe(
					true,
				);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		for (const [path, contents] of before) {
			expect(readFileSync(join(repoRoot, path), "utf-8")).toBe(contents);
		}
	}, 180_000);
});
