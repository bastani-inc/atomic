import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLIPBOARD_NATIVE_TARGETS } from "./copy-clipboard-native-bindings.js";

interface StageClipboardNativePackagesOptions {
	readonly destination: string;
	readonly version: string;
	readonly bunExecutable?: string;
}

export function clipboardNativePackageSpecs(version: string): string[] {
	return Object.values(CLIPBOARD_NATIVE_TARGETS).map((target) => `${target.packageName}@${version}`);
}

export function stageClipboardNativePackages(options: StageClipboardNativePackagesOptions): void {
	const destination = resolve(options.destination);
	mkdirSync(destination, { recursive: true });
	if (readdirSync(destination).length > 0) {
		throw new Error(`Clipboard staging directory must be empty: ${destination}`);
	}
	if (!options.version.trim()) throw new Error("Clipboard wrapper version must not be empty");

	writeFileSync(
		join(destination, "package.json"),
		`${JSON.stringify({ name: "atomic-clipboard-native-stage", private: true }, null, 2)}\n`,
	);
	const result = spawnSync(
		options.bunExecutable ?? "bun",
		[
			"add",
			"--no-save",
			"--os",
			"*",
			"--cpu",
			"*",
			...clipboardNativePackageSpecs(options.version),
		],
		{
			cwd: destination,
			stdio: ["ignore", "inherit", "pipe"],
			encoding: "utf-8",
		},
	);
	if (result.error) {
		throw new Error(`Failed to launch Bun for clipboard native staging: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const detail = result.stderr.trim();
		throw new Error(
			`Failed to stage clipboard native packages with Bun (exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`,
		);
	}

	if (!existsSync(join(destination, "node_modules"))) {
		throw new Error(`Bun completed without creating clipboard staging node_modules: ${destination}`);
	}
}

if (import.meta.main) {
	const [destination, version] = process.argv.slice(2);
	if (!destination || !version) {
		throw new Error("Usage: stage-clipboard-native-bindings.ts <staging-directory> <wrapper-version>");
	}
	stageClipboardNativePackages({ destination, version });
}
