import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface PackageJson {
	readonly dependencies?: Record<string, string>;
	readonly optionalDependencies?: Record<string, string>;
}

interface DependencyRequest {
	readonly packageName: string;
	readonly optional: boolean;
}

interface CopyRuntimeDependenciesOptions {
	readonly packageJsonPath?: string;
	readonly nodeModulesRoot?: string;
	readonly destinationNodeModules?: string;
}

const defaultPackageRoot = resolve(import.meta.dir, "..");

function readPackageJson(packageJsonPath: string): PackageJson {
	return JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJson;
}

function packagePath(nodeModulesRoot: string, packageName: string): string {
	return join(nodeModulesRoot, ...packageName.split("/"));
}

function dependencyRequests(packageJson: PackageJson, optional: boolean): DependencyRequest[] {
	const dependencies = Object.keys(packageJson.dependencies ?? {}).map((packageName) => ({ packageName, optional }));
	const optionalDependencies = Object.keys(packageJson.optionalDependencies ?? {}).map((packageName) => ({
		packageName,
		optional: true,
	}));
	return [...dependencies, ...optionalDependencies];
}

function shouldSkipPackageEntry(name: string): boolean {
	return (
		name === "node_modules" ||
		name === ".git" ||
		name === ".github" ||
		name === "coverage" ||
		name === ".nyc_output" ||
		name === ".DS_Store" ||
		name === ".turbo" ||
		name === ".vite" ||
		name === ".vitest" ||
		name === "test" ||
		name === "tests" ||
		name.endsWith(".test.ts") ||
		name.endsWith(".test.mjs") ||
		name.endsWith(".test.js") ||
		name.endsWith(".spec.ts") ||
		name.endsWith(".spec.js") ||
		name.endsWith(".map")
	);
}

function copyPackageDirectory(sourceDir: string, destinationDir: string): void {
	mkdirSync(destinationDir, { recursive: true });
	for (const entry of readdirSync(sourceDir)) {
		if (shouldSkipPackageEntry(entry)) {
			continue;
		}

		const sourcePath = join(sourceDir, entry);
		const destinationPath = join(destinationDir, entry);
		const stats = statSync(sourcePath);
		if (stats.isDirectory()) {
			copyPackageDirectory(sourcePath, destinationPath);
			continue;
		}
		if (stats.isFile()) {
			cpSync(sourcePath, destinationPath, { force: true, preserveTimestamps: true });
		}
	}
}

export function copyRuntimeDependencies(options: CopyRuntimeDependenciesOptions = {}): void {
	const packageJsonPath = options.packageJsonPath ?? join(defaultPackageRoot, "package.json");
	const nodeModulesRoot = options.nodeModulesRoot ?? resolve(defaultPackageRoot, "..", "..", "node_modules");
	const destinationNodeModules = options.destinationNodeModules;
	if (!destinationNodeModules) {
		throw new Error("destinationNodeModules is required");
	}

	rmSync(destinationNodeModules, { recursive: true, force: true });
	mkdirSync(destinationNodeModules, { recursive: true });

	const copied = new Set<string>();
	const queue = dependencyRequests(readPackageJson(packageJsonPath), false);
	while (queue.length > 0) {
		const request = queue.shift();
		if (!request || copied.has(request.packageName)) {
			continue;
		}

		const sourceDir = packagePath(nodeModulesRoot, request.packageName);
		if (!existsSync(sourceDir)) {
			if (request.optional) {
				continue;
			}
			throw new Error(`Required runtime dependency not found: ${request.packageName} at ${sourceDir}`);
		}

		const sourcePackageJsonPath = join(sourceDir, "package.json");
		if (!existsSync(sourcePackageJsonPath)) {
			throw new Error(`Runtime dependency is missing package metadata: ${sourceDir}`);
		}

		const destinationDir = packagePath(destinationNodeModules, request.packageName);
		mkdirSync(dirname(destinationDir), { recursive: true });
		copyPackageDirectory(sourceDir, destinationDir);
		copied.add(request.packageName);
		queue.push(...dependencyRequests(readPackageJson(sourcePackageJsonPath), false));
	}
}

if (import.meta.main) {
	const destinationNodeModules = process.argv[2];
	copyRuntimeDependencies({ destinationNodeModules });
}
