import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bundledPatchedPiRoots, type BundledPatchedPiRoot } from "./bundled-patched-pi-config.js";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const rootNodeModulesDir = resolve(repositoryRoot, "node_modules");
const packageNodeModulesDir = resolve(packageRoot, "node_modules");
const materializationManifestPath = join(packageNodeModulesDir, ".atomic-bundled-patched-pi-manifest.json");
const legacyPiTuiManifestPath = join(packageNodeModulesDir, ".atomic-bundled-pi-tui-manifest.json");
const legacyPiTuiMarkerPath = join(packageNodeModulesDir, "@earendil-works", ".atomic-bundled-pi-tui");

interface PackageJson {
	readonly name?: string;
	readonly version?: string;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly bundleDependencies?: readonly string[];
	readonly bundledDependencies?: readonly string[];
}

interface InstalledPackageJson extends PackageJson {
	readonly name: string;
	readonly version: string;
}

interface ClosurePackage {
	readonly name: string;
	readonly version: string;
	readonly sourceDir: string;
	readonly destinationDir: string;
	readonly relativeDestination: string;
}

interface DependencyRequirement {
	readonly dependentName: string;
	readonly dependencyName: string;
	readonly specifier: string;
}

interface MaterializedPackageEntry {
	readonly name: string;
	readonly path: string;
}

interface MaterializationManifest {
	readonly version: 1;
	readonly kind: "bundled-patched-pi";
	readonly issues: readonly string[];
	readonly rootPackages: readonly string[];
	readonly packages: readonly MaterializedPackageEntry[];
}

function packageSegments(packageName: string): string[] {
	const segments = packageName.split("/");
	if (packageName.startsWith("@")) {
		if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) {
			throw new Error(`Invalid scoped package name in bundled patched Pi set: ${packageName}`);
		}
		return segments;
	}
	if (segments.length !== 1 || segments[0].length === 0) {
		throw new Error(`Invalid package name in bundled patched Pi set: ${packageName}`);
	}
	return segments;
}

function packageRelativeDestination(packageName: string): string {
	return ["node_modules", ...packageSegments(packageName)].join("/");
}

function packageSourceDir(packageName: string): string {
	return resolve(rootNodeModulesDir, ...packageSegments(packageName));
}

function packageDestinationDir(packageName: string): string {
	return resolve(packageNodeModulesDir, ...packageSegments(packageName));
}

function readPackageJson(packageDir: string, expectedName: string): InstalledPackageJson {
	const packageJsonPath = join(packageDir, "package.json");
	if (!existsSync(packageDir)) {
		throw new Error(`${expectedName} source directory is missing at ${packageDir}`);
	}
	if (!existsSync(packageJsonPath)) {
		throw new Error(`${expectedName} is missing package.json at ${packageJsonPath}`);
	}

	const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
	if (manifest.name !== expectedName) {
		throw new Error(
			`Expected package.json at ${packageJsonPath} to declare name ${expectedName}, found ${manifest.name ?? "<missing>"}`,
		);
	}
	if (!manifest.version) {
		throw new Error(`${expectedName} is missing a version in ${packageJsonPath}`);
	}
	return manifest as InstalledPackageJson;
}

function isExactSemverLiteral(specifier: string): boolean {
	return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(specifier);
}

function verifyDependencyRequirements(closure: readonly ClosurePackage[], requirements: readonly DependencyRequirement[]): void {
	const closureVersions = new Map(closure.map((entry) => [entry.name, entry.version] as const));
	for (const requirement of requirements) {
		const installedVersion = closureVersions.get(requirement.dependencyName);
		if (!installedVersion) {
			throw new Error(
				`${requirement.dependentName} depends on ${requirement.dependencyName}@${requirement.specifier}, but that package was not included in the materialized runtime closure`,
			);
		}
		if (isExactSemverLiteral(requirement.specifier) && installedVersion !== requirement.specifier) {
			throw new Error(
				`${requirement.dependentName} depends on ${requirement.dependencyName}@${requirement.specifier}, but root node_modules has ${requirement.dependencyName}@${installedVersion}`,
			);
		}
	}
}

function closurePackage(packageName: string): ClosurePackage {
	const sourceDir = packageSourceDir(packageName);
	const manifest = readPackageJson(sourceDir, packageName);
	return {
		name: packageName,
		version: manifest.version,
		sourceDir,
		destinationDir: packageDestinationDir(packageName),
		relativeDestination: packageRelativeDestination(packageName),
	};
}

function buildTransitiveRuntimeClosure(root: BundledPatchedPiRoot): ClosurePackage[] {
	const visited = new Set<string>();
	const queue: string[] = [root.packageName];
	const closure: ClosurePackage[] = [];
	const requirements: DependencyRequirement[] = [];

	for (let index = 0; index < queue.length; index += 1) {
		const packageName = queue[index];
		if (packageName === undefined) {
			throw new Error(`Internal error while traversing ${root.packageName} runtime closure at index ${index}`);
		}
		if (visited.has(packageName)) continue;
		visited.add(packageName);

		const entry = closurePackage(packageName);
		const manifest = readPackageJson(entry.sourceDir, packageName);
		const dependencyEntries = Object.entries(manifest.dependencies ?? {}).sort(([leftName], [rightName]) =>
			leftName.localeCompare(rightName),
		);
		requirements.push(
			...dependencyEntries.map(([dependencyName, specifier]) => ({
				dependentName: packageName,
				dependencyName,
				specifier,
			})),
		);
		closure.push(entry);
		queue.push(...dependencyEntries.map(([dependencyName]) => dependencyName));
	}

	const closureNames = new Set(closure.map((entry) => entry.name));
	const missingExpectedPackages = root.expectedRuntimePackages.filter((packageName) => !closureNames.has(packageName));
	if (missingExpectedPackages.length > 0) {
		throw new Error(
			`${root.packageName} runtime dependency closure is missing expected #${root.issue} package(s): ${missingExpectedPackages.join(
				", ",
			)}`,
		);
	}
	verifyDependencyRequirements(closure, requirements);
	return closure;
}

function buildRootOnlyRuntimeClosure(root: BundledPatchedPiRoot): ClosurePackage[] {
	const closure = [closurePackage(root.packageName)];
	const closureNames = new Set(closure.map((entry) => entry.name));
	const missingExpectedPackages = root.expectedRuntimePackages.filter((packageName) => !closureNames.has(packageName));
	if (missingExpectedPackages.length > 0) {
		throw new Error(
			`${root.packageName} root-only materialization is missing expected #${root.issue} package(s): ${missingExpectedPackages.join(
				", ",
			)}`,
		);
	}
	return closure;
}

function buildRuntimeClosure(): ClosurePackage[] {
	const byName = new Map<string, ClosurePackage>();
	for (const root of bundledPatchedPiRoots) {
		const rootClosure =
			root.materializeMode === "closure" ? buildTransitiveRuntimeClosure(root) : buildRootOnlyRuntimeClosure(root);
		for (const entry of rootClosure) {
			const existing = byName.get(entry.name);
			if (existing && existing.version !== entry.version) {
				throw new Error(
					`Bundled patched Pi package ${entry.name} was selected with conflicting versions: ${existing.version} and ${entry.version}`,
				);
			}
			byName.set(entry.name, entry);
		}
	}
	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function sorted(values: Iterable<string>): string[] {
	return [...values].sort((a, b) => a.localeCompare(b));
}

function assertSamePackageSet(actual: readonly string[], expected: readonly string[], label: string): void {
	const actualSorted = sorted(actual);
	const expectedSorted = sorted(expected);
	const actualSet = new Set(actualSorted);
	const expectedSet = new Set(expectedSorted);
	const missing = expectedSorted.filter((packageName) => !actualSet.has(packageName));
	const extra = actualSorted.filter((packageName) => !expectedSet.has(packageName));
	if (missing.length === 0 && extra.length === 0) return;

	throw new Error(
		`${label} must match the materialized bundled patched Pi package set. Missing: ${
			missing.length > 0 ? missing.join(", ") : "<none>"
		}; extra: ${extra.length > 0 ? extra.join(", ") : "<none>"}; expected exactly: ${expectedSorted.join(", ")}`,
	);
}

function verifyPackageBundleDependencies(closure: readonly ClosurePackage[]): void {
	const packageManifest = readPackageJson(packageRoot, "@bastani/atomic");
	const bundleDependencies = packageManifest.bundleDependencies ?? packageManifest.bundledDependencies;
	if (!bundleDependencies) {
		throw new Error("packages/coding-agent/package.json must declare bundleDependencies for bundled patched Pi packages");
	}
	assertSamePackageSet(bundleDependencies, closure.map((entry) => entry.name), "bundleDependencies");
}

function verifyMarker(root: BundledPatchedPiRoot, directory: string): void {
	for (const markerFile of root.markerFiles) {
		const markerPath = join(directory, ...markerFile.relativePath.split("/"));
		if (!existsSync(markerPath)) {
			throw new Error(`${root.packageName} is missing ${markerFile.relativePath} at ${markerPath}`);
		}

		const source = readFileSync(markerPath, "utf8");
		if (!source.includes(markerFile.marker)) {
			throw new Error(
				`${root.packageName} at ${directory} does not contain the ${markerFile.description}; run bun install so the root patchedDependencies entry materializes the patch before packing.`,
			);
		}
	}
}

function verifyPatchedRootMarkers(sourceResolver: (packageName: string) => string): void {
	for (const root of bundledPatchedPiRoots) {
		verifyMarker(root, sourceResolver(root.packageName));
	}
}

function manifestForClosure(closure: readonly ClosurePackage[]): MaterializationManifest {
	return {
		version: 1,
		kind: "bundled-patched-pi",
		issues: sorted(bundledPatchedPiRoots.map((root) => root.issue)),
		rootPackages: sorted(bundledPatchedPiRoots.map((root) => root.packageName)),
		packages: closure.map((entry) => ({ name: entry.name, path: entry.relativeDestination })),
	};
}

function writeMaterializationManifest(closure: readonly ClosurePackage[]): void {
	mkdirSync(packageNodeModulesDir, { recursive: true });
	const temporaryManifestPath = `${materializationManifestPath}.tmp`;
	writeFileSync(temporaryManifestPath, `${JSON.stringify(manifestForClosure(closure), null, 2)}\n`, "utf8");
	rmSync(materializationManifestPath, { force: true });
	renameSync(temporaryManifestPath, materializationManifestPath);
}

function readMaterializationManifest(path: string): MaterializationManifest {
	const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<MaterializationManifest> & {
		readonly issue?: string;
		readonly rootPackage?: string;
	};
	if (manifest.version !== 1 || !Array.isArray(manifest.packages)) {
		throw new Error(`Bundled patched Pi materialization manifest at ${path} is invalid`);
	}
	if (path === legacyPiTuiManifestPath) {
		if (manifest.issue !== "1222" || manifest.rootPackage !== "@earendil-works/pi-tui") {
			throw new Error(`Unrecognized bundled pi-tui materialization manifest at ${path}`);
		}
	} else if (manifest.kind !== "bundled-patched-pi") {
		throw new Error(`Unrecognized bundled patched Pi materialization manifest at ${path}`);
	}
	for (const entry of manifest.packages) {
		if (typeof entry.name !== "string" || typeof entry.path !== "string") {
			throw new Error(`Bundled patched Pi materialization manifest at ${path} has an invalid package entry`);
		}
	}
	return manifest as MaterializationManifest;
}

function resolveMaterializedPath(relativePath: string): string {
	const absolutePath = resolve(packageRoot, ...relativePath.split("/"));
	const relativeFromPackageRoot = relative(packageRoot, absolutePath);
	if (
		isAbsolute(relativeFromPackageRoot) ||
		relativeFromPackageRoot.startsWith("..") ||
		absolutePath === packageNodeModulesDir ||
		!absolutePath.startsWith(`${packageNodeModulesDir}${sep}`)
	) {
		throw new Error(`Refusing to clean path outside package-local node_modules from manifest: ${relativePath}`);
	}
	return absolutePath;
}

function removeEmptyScopeDirForPackage(packageName: string): void {
	if (!packageName.startsWith("@")) return;
	const [scope] = packageSegments(packageName);
	const scopeDir = join(packageNodeModulesDir, scope);
	if (existsSync(scopeDir) && readdirSync(scopeDir).length === 0) {
		rmdirSync(scopeDir);
	}
}

function cleanManifest(path: string): number {
	if (!existsSync(path)) return 0;
	const manifest = readMaterializationManifest(path);
	let removedPackageCount = 0;
	for (const entry of manifest.packages) {
		rmSync(resolveMaterializedPath(entry.path), { recursive: true, force: true });
		removedPackageCount += 1;
	}
	rmSync(path, { force: true });
	for (const entry of manifest.packages) {
		removeEmptyScopeDirForPackage(entry.name);
	}
	return removedPackageCount;
}

function cleanLegacyMarkerMaterialization(): boolean {
	if (!existsSync(legacyPiTuiMarkerPath)) return false;

	const legacyDestinationDir = packageDestinationDir("@earendil-works/pi-tui");
	rmSync(legacyDestinationDir, { recursive: true, force: true });
	rmSync(legacyPiTuiMarkerPath, { force: true });
	removeEmptyScopeDirForPackage("@earendil-works/pi-tui");
	return true;
}

function cleanBundledDependencies(): void {
	const removedPackageCount = cleanManifest(materializationManifestPath) + cleanManifest(legacyPiTuiManifestPath);
	const removedLegacyPackage = cleanLegacyMarkerMaterialization();
	if (removedPackageCount > 0 || removedLegacyPackage) {
		console.log(
			`Removed materialized bundled patched Pi packages (${removedPackageCount}${
				removedLegacyPackage ? " plus legacy marker" : ""
			} package path${removedPackageCount === 1 ? "" : "s"})`,
		);
	}
}

// Intentional sharp edge of this TEMPORARY bundling mechanism: we refuse to clobber any
// pre-existing package-local copy rather than guessing whether it is safe to overwrite. Remove this
// helper (and the rest of the bundling) once upstream Pi releases ship the required fixes.
function assertNoDestinationConflicts(closure: readonly ClosurePackage[]): void {
	for (const entry of closure) {
		if (!existsSync(entry.destinationDir)) continue;
		throw new Error(
			`Refusing to overwrite existing package-local ${entry.name} at ${entry.destinationDir}; run the postpack cleanup or remove the unrelated package-local copy before packing.`,
		);
	}
}

function verifyCopiedClosure(closure: readonly ClosurePackage[]): void {
	for (const entry of closure) {
		readPackageJson(entry.destinationDir, entry.name);
	}
	verifyPatchedRootMarkers((packageName) => packageDestinationDir(packageName));
}

function cleanAfterMaterializeFailure(): void {
	try {
		cleanBundledDependencies();
	} catch (cleanupError) {
		console.error(`Bundled patched Pi cleanup also failed: ${String(cleanupError)}`);
	}
}

function materializeBundledDependencies(): void {
	try {
		const closure = buildRuntimeClosure();
		verifyPackageBundleDependencies(closure);
		verifyPatchedRootMarkers((packageName) => packageSourceDir(packageName));

		cleanBundledDependencies();
		assertNoDestinationConflicts(closure);
		writeMaterializationManifest(closure);

		for (const entry of closure) {
			mkdirSync(dirname(entry.destinationDir), { recursive: true });
			cpSync(entry.sourceDir, entry.destinationDir, {
				recursive: true,
				dereference: true,
				preserveTimestamps: true,
			});
		}

		verifyCopiedClosure(closure);
		console.log(
			`Materialized bundled patched Pi packages: ${closure
				.map((entry) => `${entry.name}@${entry.version}`)
				.join(", ")}`,
		);
	} catch (error) {
		cleanAfterMaterializeFailure();
		throw error;
	}
}

if (process.argv.includes("--clean")) {
	cleanBundledDependencies();
} else {
	materializeBundledDependencies();
}
