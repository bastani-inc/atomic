import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
	INSTALLED_EXTENSION_ENTRIES,
	WORKFLOWS_SDK_BUNDLE_ENTRY,
	type BuiltinPackageDirName,
} from "../src/core/builtin-install-layout.ts";
import {
	deriveImportClosure,
	INSTALLED_IMPORT_CLOSURE_ROOTS,
	shouldSkipBuiltinCopyEntry,
} from "./derive-import-closure.js";

interface BuiltinCopy {
	label: string;
	destinationName: BuiltinPackageDirName;
	sourceDir: string;
}

interface ManifestExtensionBlock {
	extensions?: string[];
}

interface ManifestExportTarget {
	types?: string;
	import?: string;
	default?: string;
}

interface WorkflowsManifestExports {
	"."?: ManifestExportTarget;
	"./builtin"?: ManifestExportTarget;
	"./builtin/*"?: ManifestExportTarget;
}

const packageRoot = resolve(import.meta.dir, "..");
const distDir = join(packageRoot, "dist");
const distBuiltinDir = join(distDir, "builtin");
const packagesRoot = resolve(packageRoot, "..");

// Emit the @bastani/atomic/workflows declarations into the installed package.
// Raw source must not remain beside declarations because NodeNext prefers `.ts`
// over `.d.ts` when resolving the declarations' `.js` specifiers.
const workflowsDistDir = join(distBuiltinDir, "workflows");
const workflowsAuthoringTsconfig = join(packageRoot, "tsconfig.workflows-types.json");
const workflowsAuthoringDeclaration = "src/authoring.d.ts";
// Raw authoring-surface sources that are type-only at runtime (all importers use
// `import type`), so deleting their `.ts` copies is behaviorally inert; only the
// emitted `.d.ts` siblings remain for `tsc` resolution.
const rawAuthoringSourcesToPrune = [
	join(workflowsDistDir, "src", "authoring.ts"),
	join(workflowsDistDir, "src", "shared", "authoring-contract.ts"),
];

// Host-provided module specifiers that the extension loader resolves to live
// in-process instances (jiti alias / virtualModules); they must stay external
// so the bundled extension shares state with the host.
const HOST_PROVIDED_EXTERNALS = [
	"@bastani/atomic",
	"@bastani/atomic/*",
	"@earendil-works/*",
	"@mariozechner/*",
	"typebox",
	"typebox/*",
	"@sinclair/typebox",
	"@sinclair/typebox/*",
];

const WORKSPACE_BUILTINS = [
	{ packageName: "@bastani/workflows", workspaceDirName: "workflows" },
	{ packageName: "@bastani/subagents", workspaceDirName: "subagents" },
	{ packageName: "@bastani/mcp", workspaceDirName: "mcp" },
	{ packageName: "@bastani/web-access", workspaceDirName: "web-access" },
	{ packageName: "@bastani/intercom", workspaceDirName: "intercom" },
] as const;

const INSTALLED_KEEP_PREFIXES: Record<BuiltinPackageDirName, readonly string[]> = {
	workflows: [
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		INSTALLED_EXTENSION_ENTRIES.workflows,
		WORKFLOWS_SDK_BUNDLE_ENTRY,
		workflowsAuthoringDeclaration,
		"src/shared/authoring-contract.d.ts",
		"skills/",
	],
	subagents: [
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		INSTALLED_EXTENSION_ENTRIES.subagents,
		"agents/",
		"skills/",
	],
	mcp: [
		"package.json",
		"README.md",
		"OAUTH.md",
		"CHANGELOG.md",
		"LICENSE",
		INSTALLED_EXTENSION_ENTRIES.mcp,
		"app-bridge.bundle.js",
	],
	"web-access": [
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		INSTALLED_EXTENSION_ENTRIES["web-access"],
	],
	intercom: [
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		INSTALLED_EXTENSION_ENTRIES.intercom,
		"broker/",
		"skills/",
	],
};

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

function shouldSkipEntry(name: string): boolean {
	return shouldSkipBuiltinCopyEntry(name);
}

function copyFilteredDirectory(sourceDir: string, destinationDir: string): void {
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

// Public workflow builtin subpaths are declared here rather than inferred from documentation prose. Packaging is the
// authority for this artifact boundary, and every declared entry is validated fail-closed below.
const PUBLISHED_WORKFLOW_BUILTIN_NAMES = [
	"adversarial-verification",
	"classify-and-act",
	"fan-out-and-synthesize",
	"generate-and-filter",
	"goal",
	"loop-until-done",
	"open-claude-design",
	"ralph",
	"steering-context",
	"tournament",
] as const;

function listWorkflowBuiltinNames(): string[] {
	const builtinDir = join(workflowsDistDir, "builtin");
	for (const name of PUBLISHED_WORKFLOW_BUILTIN_NAMES) {
		for (const extension of [".ts", ".d.ts"] as const) {
			const entry = join(builtinDir, `${name}${extension}`);
			if (!existsSync(entry)) {
				throw new Error(`Published workflow builtin ${name} is missing ${relative(workflowsDistDir, entry)}`);
			}
		}
	}
	return [...PUBLISHED_WORKFLOW_BUILTIN_NAMES];
}

// Emit the lean @bastani/workflows authoring surface (authoring.ts +
// shared/authoring-contract.ts) as declarations into the copied workflows tree so
// the @bastani/atomic/workflows exports `types` condition resolves to `.d.ts`.
function emitWorkflowAuthoringTypes(): void {
	const result = spawnSync("bunx", ["tsgo", "-p", workflowsAuthoringTsconfig], {
		cwd: packageRoot,
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`Failed to emit @bastani/workflows authoring declarations (tsgo exited ${result.status ?? "null"})`);
	}
	const emitted = join(workflowsDistDir, "src", "authoring.d.ts");
	if (!existsSync(emitted)) {
		throw new Error(`Expected emitted authoring declaration at ${emitted}`);
	}
	console.log(`Emitted @bastani/workflows authoring types -> ${join("dist", "builtin", "workflows", "src", "authoring.d.ts")}`);
}

// Remove the raw `.ts` copies of the emitted authoring surface so `tsc` cannot
// resolve a consumer's `.js` import to the leaky raw source instead of the `.d.ts`.
function pruneRawWorkflowAuthoringSources(): void {
	for (const file of rawAuthoringSourcesToPrune) {
		rmSync(file, { force: true });
	}
}

async function bundleEntrypoint(entry: string, outfile: string, label: string): Promise<void> {
	if (!existsSync(entry)) {
		throw new Error(`Missing ${label} bundle entry: ${entry}`);
	}
	const result = await Bun.build({
		entrypoints: [entry],
		target: "node",
		format: "esm",
		packages: "external",
		external: HOST_PROVIDED_EXTERNALS,
	});
	const output = result.outputs[0];
	if (!result.success || output === undefined) {
		throw new Error(`Failed to bundle ${label}: ${result.logs.map((log) => log.message).join("\n")}`);
	}
	mkdirSync(join(outfile, ".."), { recursive: true });
	writeFileSync(outfile, await output.text(), "utf-8");
	console.log(`Bundled ${label} -> ${relative(distDir, outfile)}`);
}

async function bundleWorkflowBuiltins(): Promise<void> {
	const builtinDir = join(workflowsDistDir, "builtin");
	const names = ["index", ...listWorkflowBuiltinNames()];
	const result = await Bun.build({
		entrypoints: names.map((name) => join(builtinDir, `${name}.ts`)),
		root: builtinDir,
		target: "node",
		format: "esm",
		packages: "external",
		external: HOST_PROVIDED_EXTERNALS,
		splitting: true,
	});
	if (!result.success) {
		throw new Error(`Failed to bundle @bastani/workflows builtins: ${result.logs.map((log) => log.message).join("\n")}`);
	}
	for (const output of result.outputs) {
		const outfile = join(builtinDir, basename(output.path));
		writeFileSync(outfile, await output.text(), "utf-8");
	}
	for (const name of names) {
		const output = join(builtinDir, `${name}.js`);
		if (!existsSync(output)) throw new Error(`Bundled workflow builtin ${name} did not emit ${relative(distDir, output)}`);
	}
	console.log(`Bundled ${names.length} @bastani/workflows builtin entries -> ${relative(distDir, builtinDir)}`);
}

function readManifest(packageJsonPath: string): Record<string, unknown> {
	return JSON.parse(readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
}

function writeManifest(packageJsonPath: string, pkg: Record<string, unknown>): void {
	writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

function setManifestExtensions(pkg: Record<string, unknown>, extensionPath: string): void {
	for (const key of ["pi", "atomic"] as const) {
		const block = pkg[key] as ManifestExtensionBlock | undefined;
		if (block?.extensions?.length) {
			block.extensions = [extensionPath];
		}
	}
}

function pointWorkflowsSdkAtBundle(pkg: Record<string, unknown>): void {
	pkg.main = `./${WORKFLOWS_SDK_BUNDLE_ENTRY}`;
	pkg.types = `./${workflowsAuthoringDeclaration}`;
	const exportsField = pkg.exports as WorkflowsManifestExports | undefined;
	const root = exportsField?.["."];
	if (root) {
		root.default = `./${WORKFLOWS_SDK_BUNDLE_ENTRY}`;
		root.import = `./${WORKFLOWS_SDK_BUNDLE_ENTRY}`;
		root.types = `./${workflowsAuthoringDeclaration}`;
	}
	const builtin = exportsField?.["./builtin"];
	if (builtin) {
		builtin.default = "./builtin/index.js";
		builtin.import = "./builtin/index.js";
	}
	const builtinWildcard = exportsField?.["./builtin/*"];
	if (builtinWildcard) {
		builtinWildcard.default = "./builtin/*.js";
		builtinWildcard.import = "./builtin/*.js";
	}
}

function shouldKeepInstalledPath(
	dirName: BuiltinPackageDirName,
	relativePath: string,
	importClosure: ReadonlySet<string>,
): boolean {
	const normalized = relativePath.split("\\").join("/");
	const isEmittedWorkflowDeclaration =
		dirName === "workflows" && normalized.startsWith("src/") && normalized.endsWith(".d.ts");
	const isCompiledWorkflowBuiltin =
		dirName === "workflows" &&
		normalized.startsWith("builtin/") &&
		(normalized.endsWith(".js") || normalized.endsWith(".d.ts"));
	return (
		isEmittedWorkflowDeclaration ||
		isCompiledWorkflowBuiltin ||
		importClosure.has(normalized) ||
		INSTALLED_KEEP_PREFIXES[dirName].some((keep) => {
			if (keep.endsWith("/")) {
				return normalized === keep.slice(0, -1) || normalized.startsWith(keep);
			}
			return normalized === keep;
		})
	);
}

function pruneInstalledPackage(
	packageDir: string,
	dirName: BuiltinPackageDirName,
	importClosure: ReadonlySet<string>,
): void {
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const fullPath = join(dir, entry);
			const relativePath = relative(packageDir, fullPath);
			const stats = statSync(fullPath);
			if (stats.isDirectory()) {
				visit(fullPath);
				if (readdirSync(fullPath).length === 0) {
					rmSync(fullPath, { recursive: true });
				}
				continue;
			}
			if (!shouldKeepInstalledPath(dirName, relativePath, importClosure)) {
				rmSync(fullPath);
			}
		}
	};
	visit(packageDir);
}

const installedImportClosures = new Map<BuiltinPackageDirName, ReadonlySet<string>>();

rmSync(distBuiltinDir, { recursive: true, force: true });
mkdirSync(distBuiltinDir, { recursive: true });

for (const copy of getCopyPlan()) {
	const destinationDir = join(distBuiltinDir, copy.destinationName);
	copyFilteredDirectory(copy.sourceDir, destinationDir);
	const closureRoots = INSTALLED_IMPORT_CLOSURE_ROOTS[copy.destinationName] ?? [];
	installedImportClosures.set(copy.destinationName, deriveImportClosure(copy.sourceDir, closureRoots));
	console.log(`Copied builtin ${copy.label} -> ${join("dist", "builtin", basename(destinationDir))}`);
}

// Issue #2716: derive the published @bastani/atomic/workflows types from source.
emitWorkflowAuthoringTypes();
pruneRawWorkflowAuthoringSources();

await bundleEntrypoint(
	join(workflowsDistDir, "src", "extension", "index.ts"),
	join(workflowsDistDir, INSTALLED_EXTENSION_ENTRIES.workflows),
	"@bastani/workflows extension",
);
await bundleEntrypoint(
	join(workflowsDistDir, "src", "index.ts"),
	join(workflowsDistDir, WORKFLOWS_SDK_BUNDLE_ENTRY),
	"@bastani/workflows SDK",
);

await bundleWorkflowBuiltins();
await bundleEntrypoint(
	join(distBuiltinDir, "subagents", "src", "extension", "index.ts"),
	join(distBuiltinDir, "subagents", INSTALLED_EXTENSION_ENTRIES.subagents),
	"@bastani/subagents extension",
);
await bundleEntrypoint(
	join(distBuiltinDir, "mcp", "index.ts"),
	join(distBuiltinDir, "mcp", INSTALLED_EXTENSION_ENTRIES.mcp),
	"@bastani/mcp extension",
);
await bundleEntrypoint(
	join(distBuiltinDir, "web-access", "index.ts"),
	join(distBuiltinDir, "web-access", INSTALLED_EXTENSION_ENTRIES["web-access"]),
	"@bastani/web-access extension",
);
await bundleEntrypoint(
	join(distBuiltinDir, "intercom", "index.ts"),
	join(distBuiltinDir, "intercom", INSTALLED_EXTENSION_ENTRIES.intercom),
	"@bastani/intercom extension",
);

const workflowsManifestPath = join(workflowsDistDir, "package.json");
const workflowsManifest = readManifest(workflowsManifestPath);
setManifestExtensions(workflowsManifest, `./${INSTALLED_EXTENSION_ENTRIES.workflows}`);
pointWorkflowsSdkAtBundle(workflowsManifest);
writeManifest(workflowsManifestPath, workflowsManifest);

for (const dirName of ["subagents", "mcp", "web-access", "intercom"] as const) {
	const manifestPath = join(distBuiltinDir, dirName, "package.json");
	const manifest = readManifest(manifestPath);
	setManifestExtensions(manifest, `./${INSTALLED_EXTENSION_ENTRIES[dirName]}`);
	writeManifest(manifestPath, manifest);
}

for (const dirName of WORKSPACE_BUILTINS.map((entry) => entry.workspaceDirName)) {
	pruneInstalledPackage(join(distBuiltinDir, dirName), dirName, installedImportClosures.get(dirName) ?? new Set());
	console.log(`Pruned installed sources for ${dirName}`);
}
