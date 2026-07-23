import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CLIPBOARD_NATIVE_TARGETS,
	copyClipboardNativeBindings,
} from "../scripts/copy-clipboard-native-bindings.ts";
import { stageClipboardNativePackages } from "../scripts/stage-clipboard-native-bindings.ts";

const tempDirs: string[] = [];

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
			const copied = join(
				destinationNodeModules,
				"@mariozechner",
				"clipboard",
				target.bindingName,
			);
			expect(readFileSync(copied, "utf-8")).toBe(`binding:${target.packageName}`);
		}
	});

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
			readFileSync(
				join(destinationNodeModules, "@mariozechner", "clipboard", availableTarget.bindingName),
				"utf-8",
			),
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
		const stageCreationIndex = buildScript.indexOf("CLIPBOARD_STAGE_DIR=\"$(mktemp -d");
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

	it(
		"stages and copies every release target through Bun's real cross-platform install path",
		() => {
			const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
			const protectedFiles = [
				"package.json",
				"bun.lock",
				"package-lock.json",
				"packages/coding-agent/npm-shrinkwrap.json",
			] as const;
			const before = new Map(
				protectedFiles.map((path) => [path, readFileSync(join(repoRoot, path), "utf-8")]),
			);
			const root = mkdtempSync(join(tmpdir(), "atomic-clipboard-real-stage-"));
			try {
				const stageRoot = join(root, "stage");
				const destinationNodeModules = join(root, "destination", "node_modules");
				const wrapperMetadata = JSON.parse(
					readFileSync(
						join(repoRoot, "node_modules", "@mariozechner", "clipboard", "package.json"),
						"utf-8",
					),
				) as { version: string };
				writePackage(
					destinationNodeModules,
					"@mariozechner/clipboard",
					wrapperMetadata.version,
				);

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
					expect(
						existsSync(
							join(destinationNodeModules, "@mariozechner", "clipboard", target.bindingName),
						),
					).toBe(true);
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}

			for (const [path, contents] of before) {
				expect(readFileSync(join(repoRoot, path), "utf-8")).toBe(contents);
			}
		},
		180_000,
	);
});
