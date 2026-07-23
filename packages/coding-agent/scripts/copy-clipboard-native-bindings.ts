import { cpSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ClipboardNativeTarget {
	readonly packageName: string;
	readonly bindingName: string;
}

interface PackageMetadata {
	readonly version: string;
}

interface CopyClipboardNativeBindingsOptions {
	readonly sourceNodeModules: string;
	readonly destinationNodeModules: string;
	readonly platforms: readonly string[];
	readonly allowMissing?: boolean;
}

export const CLIPBOARD_NATIVE_TARGETS = {
	"darwin-arm64": {
		packageName: "@mariozechner/clipboard-darwin-arm64",
		bindingName: "clipboard.darwin-arm64.node",
	},
	"darwin-x64": {
		packageName: "@mariozechner/clipboard-darwin-x64",
		bindingName: "clipboard.darwin-x64.node",
	},
	"linux-x64": {
		packageName: "@mariozechner/clipboard-linux-x64-gnu",
		bindingName: "clipboard.linux-x64-gnu.node",
	},
	"linux-arm64": {
		packageName: "@mariozechner/clipboard-linux-arm64-gnu",
		bindingName: "clipboard.linux-arm64-gnu.node",
	},
	"windows-x64": {
		packageName: "@mariozechner/clipboard-win32-x64-msvc",
		bindingName: "clipboard.win32-x64-msvc.node",
	},
	"windows-arm64": {
		packageName: "@mariozechner/clipboard-win32-arm64-msvc",
		bindingName: "clipboard.win32-arm64-msvc.node",
	},
} satisfies Record<string, ClipboardNativeTarget>;

function packagePath(nodeModulesRoot: string, packageName: string): string {
	return join(nodeModulesRoot, ...packageName.split("/"));
}

function readVersion(packageDir: string): string {
	const packageJsonPath = join(packageDir, "package.json");
	if (!existsSync(packageJsonPath)) {
		throw new Error(`Clipboard package metadata not found: ${packageJsonPath}`);
	}
	return (JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageMetadata).version;
}

export function copyClipboardNativeBindings(options: CopyClipboardNativeBindingsOptions): void {
	const sourceWrapper = packagePath(options.sourceNodeModules, "@mariozechner/clipboard");
	const destinationWrapper = packagePath(options.destinationNodeModules, "@mariozechner/clipboard");
	const destinationWrapperPackageJson = join(destinationWrapper, "package.json");
	if (options.allowMissing && !existsSync(destinationWrapperPackageJson)) return;
	const wrapperVersion = readVersion(destinationWrapper);
	const sourceWrapperPackageJson = join(sourceWrapper, "package.json");
	if (existsSync(sourceWrapperPackageJson)) {
		const sourceVersion = readVersion(sourceWrapper);
		if (sourceVersion !== wrapperVersion) {
			throw new Error(
				`Clipboard wrapper version mismatch: source ${sourceVersion}, destination ${wrapperVersion}`,
			);
		}
	}

	for (const platform of options.platforms) {
		const target = CLIPBOARD_NATIVE_TARGETS[platform as keyof typeof CLIPBOARD_NATIVE_TARGETS];
		if (!target) throw new Error(`Unsupported clipboard target: ${platform}`);
		const sourcePackage = packagePath(options.sourceNodeModules, target.packageName);
		const sourcePackageJson = join(sourcePackage, "package.json");
		if (options.allowMissing && !existsSync(sourcePackageJson)) continue;
		const nativeVersion = readVersion(sourcePackage);
		if (nativeVersion !== wrapperVersion) {
			throw new Error(
				`Clipboard native version mismatch: wrapper ${wrapperVersion}, ${target.packageName} ${nativeVersion}`,
			);
		}
		const sourceBinding = join(sourcePackage, target.bindingName);
		if (!existsSync(sourceBinding)) {
			if (options.allowMissing) continue;
			throw new Error(`Clipboard native binding not found: ${sourceBinding}`);
		}
		cpSync(sourceBinding, join(destinationWrapper, target.bindingName), { force: true });
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let allowMissing = false;
	let sourceNodeModules = resolve(import.meta.dir, "..", "..", "..", "node_modules");
	const positional: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--allow-missing") {
			allowMissing = true;
			continue;
		}
		if (arg === "--source-node-modules") {
			const value = args[index + 1];
			if (!value) throw new Error("--source-node-modules requires a path");
			sourceNodeModules = resolve(value);
			index += 1;
			continue;
		}
		positional.push(arg);
	}
	const [destinationNodeModules, ...platforms] = positional;
	if (!destinationNodeModules || platforms.length === 0) {
		throw new Error(
			"Usage: copy-clipboard-native-bindings.ts <destination-node_modules> [--source-node-modules <path>] [--allow-missing] <platform...>",
		);
	}
	copyClipboardNativeBindings({
		sourceNodeModules,
		destinationNodeModules: resolve(destinationNodeModules),
		platforms,
		allowMissing,
	});
}
