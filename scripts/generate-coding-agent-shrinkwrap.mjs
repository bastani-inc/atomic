#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const shrinkwrapPath = join(codingAgentDir, "npm-shrinkwrap.json");
const internalPackageNames = new Set(["@bastani/atomic-natives"]);
const placeholderVersion = "0.0.0";
const defaultNpmRegistry = "https://registry.npmjs.org";
const npmRegistry = (process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || defaultNpmRegistry).replace(/\/$/, "");
const allowedInstallScriptPackages = new Map([
	["@google/genai@1.52.0", "preinstall is a no-op in the published package"],
	["protobufjs@7.6.4", "postinstall only warns about protobufjs version scheme mismatches"],
]);

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

for (const arg of args) {
	if (arg !== "--check") {
		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageDependencies(entry) {
	return {
		...(entry.dependencies ?? {}),
		...(entry.optionalDependencies ?? {}),
	};
}

function sortedObject(object) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedPackageEntry(entry) {
	const fieldOrder = [
		"name",
		"version",
		"resolved",
		"integrity",
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
		"optional",
		"hasInstallScript",
		"deprecated",
		"funding",
	];
	const sorted = {};

	for (const field of fieldOrder) {
		if (entry[field] !== undefined) {
			sorted[field] = entry[field];
		}
	}
	for (const [field, value] of Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) {
		if (sorted[field] === undefined) {
			sorted[field] = value;
		}
	}
	return sorted;
}

function copyLockEntry(entry) {
	const copied = { ...entry };
	delete copied.dev;
	delete copied.devOptional;
	delete copied.extraneous;
	delete copied.link;
	return sortedPackageEntry(copied);
}

function copyPackageJsonEntry(packageJson, options) {
	const entry = options.includeName
		? { name: packageJson.name, version: packageJson.version }
		: { version: packageJson.version };

	for (const field of [
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
	]) {
		if (packageJson[field] !== undefined) {
			entry[field] = packageJson[field];
		}
	}

	return sortedPackageEntry(entry);
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) {
		return undefined;
	}

	const parts = lockPath.slice(index + marker.length).split("/");
	if (parts[0]?.startsWith("@")) {
		return `${parts[0]}/${parts[1]}`;
	}
	return parts[0];
}

function registryTarballUrl(packageName, version, registry = defaultNpmRegistry) {
	const tarballName = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
	return `${registry}/${packageName}/-/${tarballName}-${version}.tgz`;
}

function registryMetadataUrl(packageName) {
	return `${npmRegistry}/${encodeURIComponent(packageName)}`;
}

function assertRegistryMetadata(packageName, version, metadata) {
	if (!metadata || metadata.name !== packageName || metadata.version !== version) {
		throw new Error(`Registry metadata for ${packageName}@${version} is malformed.`);
	}
	if (!metadata.dist?.tarball || !metadata.dist?.integrity) {
		throw new Error(`Registry metadata for ${packageName}@${version} is missing dist.tarball or dist.integrity.`);
	}
}

async function fetchRegistryPackageVersion(packageName, version) {
	if (version === placeholderVersion) {
		return undefined;
	}

	const response = await fetch(registryMetadataUrl(packageName), {
		headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
	});
	if (!response.ok) {
		throw new Error(`Unable to read npm metadata for ${packageName}@${version}: HTTP ${response.status}`);
	}
	const packument = await response.json();
	const metadata = packument?.versions?.[version];
	if (!metadata) {
		throw new Error(
			`npm metadata for ${packageName}@${version} is not available. Publish @bastani/atomic-natives and its optional platform packages before generating the @bastani/atomic shrinkwrap.`,
		);
	}
	assertRegistryMetadata(packageName, version, metadata);
	return metadata;
}

function copyRegistryPackageEntry(metadata) {
	const entry = copyPackageJsonEntry(metadata, { includeName: false });
	entry.resolved = metadata.dist.tarball;
	entry.integrity = metadata.dist.integrity;
	return sortedPackageEntry(entry);
}

function platformDescriptorFromNapiTarget(packageJson, target) {
	const mappings = {
		"x86_64-pc-windows-msvc": { suffix: "win32-x64-msvc", os: ["win32"], cpu: ["x64"] },
		"aarch64-pc-windows-msvc": { suffix: "win32-arm64-msvc", os: ["win32"], cpu: ["arm64"] },
		"x86_64-apple-darwin": { suffix: "darwin-x64", os: ["darwin"], cpu: ["x64"] },
		"aarch64-apple-darwin": { suffix: "darwin-arm64", os: ["darwin"], cpu: ["arm64"] },
		"x86_64-unknown-linux-gnu": { suffix: "linux-x64-gnu", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
		"aarch64-unknown-linux-gnu": { suffix: "linux-arm64-gnu", os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
	};
	const mapping = mappings[target];
	if (!mapping) {
		throw new Error(`Unsupported @bastani/atomic-natives napi target in shrinkwrap generator: ${target}`);
	}
	return {
		name: `${packageJson.name}-${mapping.suffix}`,
		version: packageJson.version,
		entry: sortedPackageEntry({
			version: packageJson.version,
			resolved: registryTarballUrl(`${packageJson.name}-${mapping.suffix}`, packageJson.version),
			license: packageJson.license,
			os: mapping.os,
			cpu: mapping.cpu,
			...(mapping.libc ? { libc: mapping.libc } : {}),
			optional: true,
		}),
	};
}

function generatedAtomicNativesOptionalPackages(packageJson) {
	return new Map(
		(packageJson.napi?.targets ?? []).map((target) => {
			const descriptor = platformDescriptorFromNapiTarget(packageJson, target);
			return [descriptor.name, descriptor];
		}),
	);
}

async function buildInternalPackageEntries(workspaces) {
	const entries = new Map();
	for (const [name, workspace] of workspaces) {
		const packageJson = workspace.packageJson;
		if (name !== "@bastani/atomic-natives") {
			continue;
		}

		const metadata = await fetchRegistryPackageVersion(name, packageJson.version);
		const optionalPackages = generatedAtomicNativesOptionalPackages(packageJson);
		const mainEntry = metadata ? copyRegistryPackageEntry(metadata) : copyPackageJsonEntry(packageJson, { includeName: false });
		mainEntry.resolved = metadata?.dist?.tarball ?? registryTarballUrl(name, packageJson.version);
		if (metadata?.dist?.integrity) {
			mainEntry.integrity = metadata.dist.integrity;
		}
		mainEntry.optionalDependencies = sortedObject(
			metadata?.optionalDependencies ??
				Object.fromEntries([...optionalPackages].map(([packageName, descriptor]) => [packageName, descriptor.version])),
		);
		entries.set(name, sortedPackageEntry(mainEntry));

		for (const [packageName, descriptor] of optionalPackages) {
			const optionalVersion = mainEntry.optionalDependencies[packageName];
			const optionalMetadata = await fetchRegistryPackageVersion(packageName, optionalVersion);
			const optionalEntry = optionalMetadata ? copyRegistryPackageEntry(optionalMetadata) : { ...descriptor.entry };
			optionalEntry.os = descriptor.entry.os;
			optionalEntry.cpu = descriptor.entry.cpu;
			if (descriptor.entry.libc) {
				optionalEntry.libc = descriptor.entry.libc;
			}
			optionalEntry.optional = true;
			entries.set(packageName, sortedPackageEntry(optionalEntry));
		}
	}
	return entries;
}

function getInternalWorkspaces(lockPackages) {
	const workspaces = new Map();

	for (const [lockPath, entry] of Object.entries(lockPackages)) {
		if (!lockPath.startsWith("packages/") || lockPath.includes("/node_modules/") || !entry.name || !entry.version) {
			continue;
		}
		if (!internalPackageNames.has(entry.name)) {
			continue;
		}

		workspaces.set(entry.name, {
			lockPath,
			packageJson: readJson(join(repoRoot, lockPath, "package.json")),
		});
	}

	return workspaces;
}

function resolveExternalDependency(lockPackages, packageName, fromLockPath) {
	const candidateDirs = [];
	let current = fromLockPath;

	while (current) {
		candidateDirs.push(current);
		const parent = posix.dirname(current);
		if (parent === "." || parent === current) {
			break;
		}
		current = parent;
	}
	candidateDirs.push("");

	const tried = new Set();
	for (const directory of candidateDirs) {
		const candidate = directory ? `${directory}/node_modules/${packageName}` : `node_modules/${packageName}`;
		if (tried.has(candidate)) {
			continue;
		}
		tried.add(candidate);

		const entry = lockPackages[candidate];
		if (entry && !entry.link) {
			return candidate;
		}
	}

	const suffix = `node_modules/${packageName}`;
	const matches = Object.entries(lockPackages)
		.filter(([lockPath, entry]) => !entry.link && (lockPath === suffix || lockPath.endsWith(`/${suffix}`)))
		.map(([lockPath]) => lockPath);

	if (matches.length === 1) {
		return matches[0];
	}

	throw new Error(
		`Cannot resolve ${packageName} from ${fromLockPath || "root"}. ` +
			(matches.length > 1 ? `Matches: ${matches.join(", ")}` : "No matching lockfile entry found."),
	);
}

function addGeneratedInternalPackage(shrinkwrapPackages, addedPaths, queue, name, entry) {
	const outputPath = `node_modules/${name}`;
	shrinkwrapPackages[outputPath] = sortedPackageEntry(entry);
	addedPaths.add(outputPath);

	for (const dependencyName of Object.keys(packageDependencies(entry))) {
		queue.push({ name: dependencyName, from: outputPath });
	}
}

function addExternalPackage(lockPackages, shrinkwrapPackages, addedPaths, queue, name, from) {
	const lockPath = resolveExternalDependency(lockPackages, name, from);
	if (addedPaths.has(lockPath)) {
		return;
	}

	const entry = lockPackages[lockPath];
	shrinkwrapPackages[lockPath] = copyLockEntry(entry);
	addedPaths.add(lockPath);

	for (const dependencyName of Object.keys(packageDependencies(entry))) {
		queue.push({ name: dependencyName, from: lockPath });
	}
}

function validateShrinkwrap(shrinkwrap, internalNames) {
	const errors = [];
	const includedPaths = new Set(Object.keys(shrinkwrap.packages));
	const includedPackageNames = new Set();
	const seenAllowedInstallScriptPackages = new Set();

	for (const [lockPath, entry] of Object.entries(shrinkwrap.packages)) {
		const packageName = packageNameFromLockPath(lockPath);
		if (packageName) {
			includedPackageNames.add(packageName);
		}
		if (entry.link) {
			errors.push(`${lockPath} is a link entry`);
		}
		if (typeof entry.resolved === "string" && /^(file:|link:|workspace:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
		if (entry.hasInstallScript) {
			if (!packageName || !entry.version) {
				errors.push(`${lockPath || "root"} has install scripts but no package name/version`);
			} else {
				const packageId = `${packageName}@${entry.version}`;
				if (allowedInstallScriptPackages.has(packageId)) {
					seenAllowedInstallScriptPackages.add(packageId);
				} else {
					errors.push(
						`${lockPath} has install scripts (${packageId}). Review it and add it to allowedInstallScriptPackages if intentional.`,
					);
				}
			}
		}
	}

	for (const packageId of allowedInstallScriptPackages.keys()) {
		if (!seenAllowedInstallScriptPackages.has(packageId)) {
			errors.push(`allowed install-script package ${packageId} is no longer present; remove it from the allowlist`);
		}
	}

	for (const name of internalNames) {
		if (!includedPackageNames.has(name)) {
			errors.push(`internal dependency ${name} is missing`);
		}
	}

	for (const [lockPath, entry] of Object.entries(shrinkwrap.packages)) {
		for (const dependencyName of Object.keys(packageDependencies(entry))) {
			const dependencyIncluded = [...includedPaths].some(
				(candidate) => candidate === `node_modules/${dependencyName}` || candidate.endsWith(`/node_modules/${dependencyName}`),
			);
			if (!dependencyIncluded) {
				errors.push(`${lockPath || "root"} dependency ${dependencyName} is missing`);
			}
		}
	}

	const platformPackageCount = Object.values(shrinkwrap.packages).filter((entry) => entry.os || entry.cpu || entry.libc).length;
	if (platformPackageCount === 0) {
		errors.push("no platform-specific optional dependency entries found");
	}

	if (errors.length > 0) {
		throw new Error(`Generated shrinkwrap failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

async function generateShrinkwrap() {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const internalWorkspaces = getInternalWorkspaces(lockPackages);
	const generatedInternalPackages = await buildInternalPackageEntries(internalWorkspaces);
	const shrinkwrapPackages = {
		"": copyPackageJsonEntry(codingAgentPackage, { includeName: true }),
	};
	const addedPaths = new Set([""]);
	const internalNames = new Set();
	const queue = Object.keys(packageDependencies(codingAgentPackage)).map((name) => ({ name, from: "" }));

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) {
			break;
		}

		const generatedInternalPackage = generatedInternalPackages.get(item.name);
		if (generatedInternalPackage) {
			internalNames.add(item.name);
			const outputPath = `node_modules/${item.name}`;
			if (!addedPaths.has(outputPath)) {
				addGeneratedInternalPackage(shrinkwrapPackages, addedPaths, queue, item.name, generatedInternalPackage);
			}
			continue;
		}

		addExternalPackage(lockPackages, shrinkwrapPackages, addedPaths, queue, item.name, item.from);
	}

	const shrinkwrap = {
		name: codingAgentPackage.name,
		version: codingAgentPackage.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(shrinkwrapPackages),
	};

	validateShrinkwrap(shrinkwrap, internalNames);
	return shrinkwrap;
}

async function main() {
	const shrinkwrap = await generateShrinkwrap();
	const content = `${JSON.stringify(shrinkwrap, null, "\t")}\n`;

	if (checkOnly) {
		if (!existsSync(shrinkwrapPath)) {
			console.error("packages/coding-agent/npm-shrinkwrap.json is missing.");
			console.error("Run: bun run shrinkwrap:coding-agent");
			process.exit(1);
		}
		const current = readFileSync(shrinkwrapPath, "utf8");
		if (current !== content) {
			console.error("packages/coding-agent/npm-shrinkwrap.json is out of date.");
			console.error("Run: bun run shrinkwrap:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/npm-shrinkwrap.json is up to date.");
	} else {
		writeFileSync(shrinkwrapPath, content);
		const packageCount = Object.keys(shrinkwrap.packages).length - 1;
		const platformPackageCount = Object.values(shrinkwrap.packages).filter((entry) => entry.os || entry.cpu || entry.libc).length;
		console.log(
			`Wrote packages/coding-agent/npm-shrinkwrap.json (${packageCount} packages, ${platformPackageCount} platform-specific).`,
		);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}

export { generateShrinkwrap };
