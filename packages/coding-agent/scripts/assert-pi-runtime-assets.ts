import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Remaining registry Pi packages (`pi-agent-core`, `pi-tui`, …) stay on this version. */
export const expectedPiVersion = "0.85.1";
export const expectedPiAiPackage = "@bastani/pi-ai";
const requiredPiAiFiles = [
	"package.json",
	"dist/models.generated.js",
	"dist/image-models.generated.js",
	"dist/providers/data/.manifest.json",
	"dist/providers/data/amazon-bedrock.json",
	"dist/providers/data/anthropic.json",
	"dist/providers/data/kimi-coding.json",
	"dist/providers/data/openrouter.json",
	"dist/auth/oauth/kimi-coding.js",
	"dist/auth/oauth/openrouter.js",
	"dist/bun-oauth.js",
] as const;
const requiredPiTuiFiles = [
	"package.json",
	"dist/index.js",
	"dist/native-modifiers.js",
	"dist/native-module-path.js",
	"native/win32/prebuilds/win32-x64/win32-console-mode.node",
	"native/win32/prebuilds/win32-arm64/win32-console-mode.node",
] as const;
const frozenNativeModifiersMarker = "@earendil-works/pi-tui/dist/native-modifiers.js";
const barePiTuiRequirePattern = /require\((["'])@earendil-works\/pi-tui\1\)/u;
const externalNativeModifiersPattern = /require\((["'])\.\/native-modifiers\.js\1\)/u;
const requiredAppMarkers = [
	"global.anthropic.claude-opus-5",
	"https://openrouter.ai/auth",
	"https://auth.kimi.com",
] as const;

export interface PiRuntimeAssetOptions {
	readonly nodeModulesRoot: string;
	readonly appBundlePath?: string;
}

function packagePath(nodeModulesRoot: string, packageName: string): string {
	return join(nodeModulesRoot, ...packageName.split("/"));
}

function requireFile(path: string): void {
	if (!existsSync(path)) throw new Error(`Missing Pi runtime asset: ${path}`);
}

export function assertPiRuntimeAssets(options: PiRuntimeAssetOptions): void {
	const nodeModulesRoot = resolve(options.nodeModulesRoot);
	const piAiRoot = packagePath(nodeModulesRoot, "@bastani/pi-ai");
	for (const relativePath of requiredPiAiFiles) requireFile(join(piAiRoot, relativePath));
	const piTuiRoot = packagePath(nodeModulesRoot, "@earendil-works/pi-tui");
	for (const relativePath of requiredPiTuiFiles) requireFile(join(piTuiRoot, relativePath));

	const packageJson = JSON.parse(readFileSync(join(piAiRoot, "package.json"), "utf-8")) as {
		name?: string;
		version?: string;
	};
	if (packageJson.name !== expectedPiAiPackage) {
		throw new Error(`Expected package ${expectedPiAiPackage}, found ${packageJson.name ?? "unknown"}`);
	}

	if (options.appBundlePath) {
		const appBundlePath = resolve(options.appBundlePath);
		requireFile(appBundlePath);
		requireFile(join(dirname(appBundlePath), "native-modifiers.js"));
		requireFile(join(dirname(appBundlePath), "native-module-path.js"));
		const appBundle = readFileSync(appBundlePath, "utf-8");
		for (const marker of requiredAppMarkers) {
			if (!appBundle.includes(marker)) throw new Error(`Pi runtime marker is absent from ${appBundlePath}: ${marker}`);
		}
		if (!externalNativeModifiersPattern.test(appBundle)) {
			throw new Error(`pi-tui's runtime native modifier loader is absent from ${appBundlePath}`);
		}
		if (barePiTuiRequirePattern.test(appBundle)) {
			throw new Error(`pi-tui must be bundled into ${appBundlePath}; compiled split launchers cannot resolve it`);
		}
		if (appBundle.includes(frozenNativeModifiersMarker)) {
			throw new Error(
				`pi-tui native modifiers must stay external to ${appBundlePath}; bundling freezes the build host's import.meta.url`,
			);
		}
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let nodeModulesRoot = resolve(import.meta.dir, "../../..", "node_modules");
	let appBundlePath: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--node-modules") {
			const value = args[index + 1];
			if (!value) throw new Error("--node-modules requires a path");
			nodeModulesRoot = resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--app") {
			const value = args[index + 1];
			if (!value) throw new Error("--app requires a path");
			appBundlePath = resolve(value);
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	assertPiRuntimeAssets({ nodeModulesRoot, appBundlePath });
	console.log(`Pi ${expectedPiVersion} model-data, OAuth, and external TUI runtime assets verified.`);
}
