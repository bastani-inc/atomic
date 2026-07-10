import { describe, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { subset as semverSubset } from "semver";
import atomicPackageJson from "../../packages/coding-agent/package.json" with { type: "json" };
import cursorPackageJson from "../../packages/cursor/package.json" with { type: "json" };
import intercomPackageJson from "../../packages/intercom/package.json" with { type: "json" };
import mcpPackageJson from "../../packages/mcp/package.json" with { type: "json" };
import nativesPackageJson from "../../packages/natives/package.json" with { type: "json" };
import subagentsPackageJson from "../../packages/subagents/package.json" with { type: "json" };
import webAccessPackageJson from "../../packages/web-access/package.json" with { type: "json" };
import workflowsPackageJson from "../../packages/workflows/package.json" with { type: "json" };

const STRICT_RELEASE_VERSION_RE =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.([1-9]\d*))?$/;

type DependencySectionName =
    | "dependencies"
    | "optionalDependencies"
    | "peerDependencies"
    | "devDependencies";

type DependencyMap = Record<string, string>;

interface PackageDependencySections {
    name: string;
    dependencies?: DependencyMap;
    optionalDependencies?: DependencyMap;
    peerDependencies?: DependencyMap;
    devDependencies?: DependencyMap;
}

interface WorkspacePackageJson extends PackageDependencySections {
    version: string;
    private?: boolean;
}

interface WorkspacePackage {
    manifestPath: string;
    packageJson: WorkspacePackageJson;
}

interface RuntimeDependencyPackageJson {
    name: string;
    version: string;
    engines?: {
        node?: string;
    };
}

async function workspacePackages(): Promise<WorkspacePackage[]> {
    return (
        await Promise.all(
            readdirSync("packages", { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map(async (entry) => {
                    const manifestPath = join(
                        "packages",
                        entry.name,
                        "package.json",
                    );
                    if (!existsSync(manifestPath)) return undefined;
                    const packageJson = (await Bun.file(
                        manifestPath,
                    ).json()) as WorkspacePackageJson;
                    return { manifestPath, packageJson };
                }),
        )
    )
        .filter(
            (workspacePackage): workspacePackage is WorkspacePackage =>
                workspacePackage !== undefined,
        )
        .sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
}

const PUBLISHED_DEPENDENCY_SECTIONS: readonly DependencySectionName[] = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
];

const BUNDLED_PACKAGE_MANIFESTS: readonly PackageDependencySections[] = [
    workflowsPackageJson,
    subagentsPackageJson,
    mcpPackageJson,
    webAccessPackageJson,
    intercomPackageJson,
    cursorPackageJson,
];

const ATOMIC_RUNTIME_DEPENDENCIES: DependencyMap = {
    ...atomicPackageJson.dependencies,
    ...atomicPackageJson.optionalDependencies,
};

const PUBLISHABLE_WORKSPACE_PACKAGES = new Set([
    "@bastani/atomic",
    "@bastani/atomic-natives",
]);

function markdownFiles(dir: string): string[] {
    return readdirSync(dir)
        .filter((name) => name.endsWith(".md"))
        .sort();
}

function dependencyEntries(
    packageJson: PackageDependencySections,
    sections: readonly DependencySectionName[] = PUBLISHED_DEPENDENCY_SECTIONS,
): [DependencySectionName, string, string][] {
    return sections.flatMap((sectionName) => {
        const dependencies = packageJson[sectionName];
        if (!dependencies) return [];
        return Object.entries(dependencies).map(
            ([name, range]): [DependencySectionName, string, string] => [
                sectionName,
                name,
                range,
            ],
        );
    });
}

function atomicRuntimeDependencyRange(name: string): string | undefined {
    return ATOMIC_RUNTIME_DEPENDENCIES[name];
}

async function runtimeDependencyPackageJson(
    dependencyName: string,
): Promise<RuntimeDependencyPackageJson> {
    const manifestPath = join("node_modules", dependencyName, "package.json");
    return (await Bun.file(manifestPath).json()) as RuntimeDependencyPackageJson;
}

describe("package metadata", () => {
    test("all workspace packages share the same strict release version", async () => {
        const packages = await workspacePackages();
        assert.ok(
            packages.length >= 6,
            "expected all first-party workspace packages",
        );
        assert.match(atomicPackageJson.version, STRICT_RELEASE_VERSION_RE);

        for (const { manifestPath, packageJson } of packages) {
            assert.match(
                packageJson.version,
                STRICT_RELEASE_VERSION_RE,
                `${manifestPath} has an invalid release version`,
            );
            assert.equal(
                packageJson.version,
                atomicPackageJson.version,
                `${manifestPath} must match @bastani/atomic`,
            );
        }
    });

    test("only intended workspace packages are publishable", async () => {
        const packages = await workspacePackages();
        assert.equal(atomicPackageJson.name, "@bastani/atomic");
        assert.equal(
            Object.prototype.hasOwnProperty.call(atomicPackageJson, "private"),
            false,
        );

        for (const { manifestPath, packageJson } of packages) {
            if (PUBLISHABLE_WORKSPACE_PACKAGES.has(packageJson.name)) continue;
            assert.equal(
                packageJson.private,
                true,
                `${manifestPath} must remain private because it is bundled into @bastani/atomic`,
            );
        }
    });

    test("@bastani/atomic package manifest exposes atomic app config and legacy pi shim", () => {
        assert.deepEqual(
            atomicPackageJson.atomicConfig,
            atomicPackageJson.piConfig,
        );
        assert.equal(atomicPackageJson.atomicConfig.name, "atomic");
        assert.equal(atomicPackageJson.atomicConfig.configDir, ".atomic");
    });

    test("@bastani/atomic package manifest is installable outside the workspace", () => {
        for (const [
            sectionName,
            dependencyName,
            dependencyRange,
        ] of dependencyEntries(atomicPackageJson)) {
            assert.ok(
                !dependencyRange.startsWith("workspace:"),
                `${sectionName}.${dependencyName} must not use the workspace protocol in the published manifest`,
            );
            assert.ok(
                !dependencyName.startsWith("@bastani/") || dependencyName === "@bastani/atomic-natives",
                `${sectionName}.${dependencyName} must not point at a private bundled workspace package`,
            );
        }
    });

    test("@bastani/atomic declares runtime dependencies required by bundled packages", () => {
        for (const bundledPackageJson of BUNDLED_PACKAGE_MANIFESTS) {
            for (const [, dependencyName, dependencyRange] of dependencyEntries(
                bundledPackageJson,
                ["dependencies"],
            )) {
                if (dependencyName.startsWith("@bastani/")) continue;
                const atomicDependencyRange =
                    atomicRuntimeDependencyRange(dependencyName);
                const foundRange = atomicDependencyRange ?? "missing";
                assert.ok(
                    atomicDependencyRange !== undefined &&
                        semverSubset(atomicDependencyRange, dependencyRange),
                    `@bastani/atomic must directly depend on ${dependencyName} for bundled ${bundledPackageJson.name} with a range equal to or narrower than ${dependencyRange} (found ${foundRange})`,
                );
            }
        }
    });

    test("@bastani/atomic Node.js engine range is no broader than direct runtime dependency engines", async () => {
        const atomicNodeEngine = atomicPackageJson.engines.node;
        assert.equal(typeof atomicNodeEngine, "string");

        for (const dependencyName of Object.keys(
            ATOMIC_RUNTIME_DEPENDENCIES,
        ).sort()) {
            const dependencyPackageJson =
                await runtimeDependencyPackageJson(dependencyName).catch(() => undefined);
            // Optional dependencies may be absent from node_modules (e.g. when
            // their install is skipped); skip the engine check for those rather
            // than fail, since they are not guaranteed runtime requirements.
            if (dependencyPackageJson === undefined) continue;
            const dependencyNodeEngine = dependencyPackageJson.engines?.node;
            if (!dependencyNodeEngine) continue;

            assert.ok(
                semverSubset(atomicNodeEngine, dependencyNodeEngine),
                `@bastani/atomic engines.node (${atomicNodeEngine}) must be equal to or narrower than ${dependencyName} engines.node (${dependencyNodeEngine})`,
            );
        }
    });

    test("ships workflow, skill, and bundled agent assets through package metadata", () => {
        assert.ok(workflowsPackageJson.files.includes("builtin/**/*.ts"));
        assert.ok(workflowsPackageJson.files.includes("skills/**/*"));
        assert.deepEqual(workflowsPackageJson.pi.skills, ["./skills"]);
        assert.deepEqual(workflowsPackageJson.pi.builtin, ["./builtin"]);
    });

    test("Intercom ships all top-level runtime TypeScript modules through a bounded pattern", () => {
        const topLevelPattern = "*.ts";
        assert.ok(intercomPackageJson.files.includes(topLevelPattern));
        const matchedTopLevelModules = new Set(
            new Bun.Glob(topLevelPattern).scanSync({
                cwd: "packages/intercom",
                onlyFiles: true,
            }),
        );
        for (const runtimeModule of [
            "index-heavy.ts",
            "result-renderers.ts",
            "lifecycle-lease.ts",
            "lazy-tool-execution.ts",
        ]) {
            assert.ok(
                matchedTopLevelModules.has(runtimeModule),
                `${runtimeModule} must be included by ${topLevelPattern}`,
            );
        }
        assert.ok(intercomPackageJson.files.includes("broker/**/*.ts"));
        assert.ok(intercomPackageJson.files.includes("ui/**/*.ts"));
        assert.ok(intercomPackageJson.files.includes("skills/**/*"));
        assert.ok(intercomPackageJson.files.includes("README.md"));
        assert.ok(intercomPackageJson.files.includes("CHANGELOG.md"));
    });

    test("natives package follows the generated NAPI-RS package layout", () => {
        assert.equal(nativesPackageJson.name, "@bastani/atomic-natives");
        assert.equal(nativesPackageJson.main, "./native/index.js");
        assert.equal(nativesPackageJson.types, "./native/index.d.ts");
        assert.equal(nativesPackageJson.napi.binaryName, "atomic_natives");
        assert.deepEqual(nativesPackageJson.napi.targets, [
            "x86_64-pc-windows-msvc",
            "x86_64-apple-darwin",
            "x86_64-unknown-linux-gnu",
            "aarch64-unknown-linux-gnu",
            "aarch64-apple-darwin",
            "aarch64-pc-windows-msvc",
        ]);
        assert.ok(nativesPackageJson.files.includes("native/index.js"));
        assert.ok(nativesPackageJson.files.includes("native/index.d.ts"));
    });

    test("Cursor native transport documentation does not mention removed Node bridge paths", () => {
        const checkedPaths = [
            "packages/coding-agent/docs/providers.md",
            "packages/cursor/README.md",
            "packages/cursor/src/proto/README.md",
        ];
        const forbiddenPatterns = [
            /ATOMIC_CURSOR_H2_BRIDGE_NODE/,
            /h2-bridge/,
            /Node bridge/i,
            /node subprocess/i,
            /subprocess bridge/i,
            /shell out to Node/i,
        ];

        for (const checkedPath of checkedPaths) {
            const content = readFileSync(checkedPath, "utf8");
            for (const pattern of forbiddenPatterns) {
                assert.doesNotMatch(content, pattern, `${checkedPath} must not mention ${pattern}`);
            }
        }
    });

    test("subagents package ships bundled agent markdown files", () => {
        const bundledAgents = markdownFiles("packages/subagents/agents");
        assert.ok(
            bundledAgents.length > 0,
            "expected at least one bundled agent markdown file",
        );
    });
});
