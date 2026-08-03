import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const expectedPiVersion = "0.83.0";
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
	const piAiRoot = packagePath(resolve(options.nodeModulesRoot), "@earendil-works/pi-ai");
	for (const relativePath of requiredPiAiFiles) requireFile(join(piAiRoot, relativePath));

	const packageJson = JSON.parse(readFileSync(join(piAiRoot, "package.json"), "utf-8")) as { version?: string };
	if (packageJson.version !== expectedPiVersion) {
		throw new Error(`Expected @earendil-works/pi-ai ${expectedPiVersion}, found ${packageJson.version ?? "unknown"}`);
	}

	if (options.appBundlePath) {
		const appBundlePath = resolve(options.appBundlePath);
		requireFile(appBundlePath);
		const appBundle = readFileSync(appBundlePath, "utf-8");
		for (const marker of requiredAppMarkers) {
			if (!appBundle.includes(marker)) throw new Error(`Pi runtime marker is absent from ${appBundlePath}: ${marker}`);
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
	console.log(`Pi ${expectedPiVersion} model-data and OAuth runtime assets verified.`);
}
