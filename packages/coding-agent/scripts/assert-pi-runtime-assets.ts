import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const expectedPiAiPackage = "@bastani/atomic-ai";
const requiredPiAiFiles = [
	"package.json",
	"dist/models.generated.js",
	"dist/models.js",
	"dist/providers/data/.manifest.json",
	"dist/providers/data/amazon-bedrock.json",
	"dist/providers/data/anthropic.json",
	"dist/providers/data/kimi-coding.json",
	"dist/providers/data/openrouter.json",
	"dist/auth/oauth/kimi-coding.js",
	"dist/auth/oauth/openrouter.js",
	"dist/auth/oauth/openai-chatgpt.js",
	"dist/auth/oauth/callback-server.js",
	"dist/utils/oauth-page.js",
	"dist/bun-oauth.js",
] as const;
const requiredPiTuiFiles = [
	"package.json",
	"dist/index.js",
	"dist/native-modifiers.js",
	"dist/native-module-path.js",
	"dist/native-platform.js",
	"native/win32/prebuilds/win32-x64/win32-platform.node",
	"native/win32/prebuilds/win32-arm64/win32-platform.node",
] as const;
const frozenNativeModifiersMarker = "@bastani/atomic-tui/dist/native-modifiers.js";
const barePiTuiRequirePattern = /require\((["'])@bastani\/atomic-tui\1\)/u;
const externalNativeModifiersPattern = /require\((["'])\.\/native-modifiers\.js\1\)/u;
const unstampedPrewarmMarker = "__ATOMIC_PREWARM_BUILD_STAMP__";
const stampedPrewarmPattern = /\bPREWARM_BUILD_STAMP\s*=\s*"[0-9a-f]{30}"/u;
const requiredAppMarkers = [
	"global.anthropic.claude-opus-5",
	"https://openrouter.ai/auth",
	"https://auth.kimi.com",
	"chatgpt.tokens.use.direct",
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
	requireFile(join(packagePath(nodeModulesRoot, "@bastani/atomic-codemode"), "dist/runtime/worker.js"));
	for (const name of ["@bastani/atomic-agent-core", "@bastani/atomic-schema", "@bastani/atomic-telemetry"]) {
		requireFile(join(packagePath(nodeModulesRoot, name), "dist/index.js"));
	}
	requireFile(join(packagePath(nodeModulesRoot, "quickjs-wasi"), "quickjs.wasm"));
	const piAiRoot = packagePath(nodeModulesRoot, "@bastani/atomic-ai");
	for (const relativePath of requiredPiAiFiles) requireFile(join(piAiRoot, relativePath));
	const piTuiRoot = packagePath(nodeModulesRoot, "@bastani/atomic-tui");
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
		requireFile(join(dirname(appBundlePath), "codemode-worker.js"));
		requireFile(join(dirname(appBundlePath), "quickjs.wasm"));
		requireFile(appBundlePath);
		requireFile(join(dirname(appBundlePath), "native-modifiers.js"));
		requireFile(join(dirname(appBundlePath), "native-module-path.js"));
		requireFile(join(dirname(appBundlePath), "native-platform.js"));
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
		if (appBundle.includes(unstampedPrewarmMarker) || !stampedPrewarmPattern.test(appBundle)) {
			throw new Error(
				`PREWARM_BUILD_STAMP must be stamped with a 30-hex digest in ${appBundlePath} before bundling`,
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
	console.log("Model-data, OAuth, and external TUI runtime assets verified.");
}
