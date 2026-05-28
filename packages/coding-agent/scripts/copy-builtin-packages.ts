import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface BuiltinCopy {
	label: string;
	destinationName: string;
	sourceDir: string;
}

const here = typeof import.meta.dir === "string" ? import.meta.dir : dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const distBuiltinDir = join(packageRoot, "dist", "builtin");
const packagesRoot = resolve(packageRoot, "..");

const WORKSPACE_BUILTINS = [
	{ packageName: "@bastani/workflows", workspaceDirName: "workflows" },
	{ packageName: "@bastani/subagents", workspaceDirName: "subagents" },
	{ packageName: "@bastani/mcp", workspaceDirName: "mcp" },
	{ packageName: "@bastani/web-access", workspaceDirName: "web-access" },
	{ packageName: "@bastani/intercom", workspaceDirName: "intercom" },
	{ packageName: "@bastani/cursor-provider", workspaceDirName: "cursor-provider" },
] as const;

function readPackageName(packageDir: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as { name?: string };
		return pkg.name;
	} catch {
		return undefined;
	}
}

function assertPackageDir(packageDir: string, expectedName: string): void {
	const actualName = readPackageName(packageDir);
	if (actualName !== expectedName) {
		throw new Error(`Expected ${packageDir} to contain package ${expectedName}, found ${actualName ?? "none"}`);
	}
}

const SKIPPED_ENTRY_NAMES = new Set([
	"node_modules",
	".git",
	".github",
	"coverage",
	".nyc_output",
	".DS_Store",
	".turbo",
	".vite",
	".vitest",
	"test",
	"tests",
]);

export function shouldSkipEntry(name: string): boolean {
	return (
		SKIPPED_ENTRY_NAMES.has(name) ||
		name.endsWith(".test.ts") ||
		name.endsWith(".test.mjs") ||
		name.endsWith(".spec.ts") ||
		name.endsWith(".map")
	);
}

export function copyFilteredDirectory(sourceDir: string, destinationDir: string): void {
	mkdirSync(destinationDir, { recursive: true });
	for (const entry of readdirSync(sourceDir)) {
		if (shouldSkipEntry(entry)) {
			continue;
		}

		const sourcePath = join(sourceDir, entry);
		const destinationPath = join(destinationDir, entry);
		const stats = statSync(sourcePath);
		if (stats.isDirectory()) {
			copyFilteredDirectory(sourcePath, destinationPath);
			continue;
		}
		if (stats.isFile()) {
			cpSync(sourcePath, destinationPath, { force: true, preserveTimestamps: true });
		}
	}
}

function getCopyPlan(): BuiltinCopy[] {
	return WORKSPACE_BUILTINS.map(({ packageName, workspaceDirName }) => {
		const sourceDir = resolve(packagesRoot, workspaceDirName);
		if (!existsSync(sourceDir)) {
			throw new Error(`Workspace package directory not found: ${sourceDir}`);
		}
		assertPackageDir(sourceDir, packageName);
		return {
			label: packageName,
			destinationName: workspaceDirName,
			sourceDir,
		};
	});
}

if (import.meta.main) {
	rmSync(distBuiltinDir, { recursive: true, force: true });
	mkdirSync(distBuiltinDir, { recursive: true });

	for (const copy of getCopyPlan()) {
		const destinationDir = join(distBuiltinDir, copy.destinationName);
		copyFilteredDirectory(copy.sourceDir, destinationDir);
		console.log(`Copied builtin ${copy.label} -> ${join("dist", "builtin", basename(destinationDir))}`);
	}
}
