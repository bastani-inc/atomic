import { describe, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import atomicPackageJson from "../../packages/coding-agent/package.json" with { type: "json" };
import intercomPackageJson from "../../packages/intercom/package.json" with { type: "json" };
import mcpPackageJson from "../../packages/mcp/package.json" with { type: "json" };
import subagentsPackageJson from "../../packages/subagents/package.json" with { type: "json" };
import webAccessPackageJson from "../../packages/web-access/package.json" with { type: "json" };
import workflowsPackageJson from "../../packages/workflows/package.json" with { type: "json" };

const STRICT_RELEASE_VERSION_RE =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/;

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
];

const ATOMIC_RUNTIME_DEPENDENCIES: DependencyMap = {
    ...atomicPackageJson.dependencies,
    ...atomicPackageJson.optionalDependencies,
};

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

    test("only @bastani/atomic is publishable", async () => {
        const packages = await workspacePackages();
        assert.equal(atomicPackageJson.name, "@bastani/atomic");
        assert.equal(
            Object.prototype.hasOwnProperty.call(atomicPackageJson, "private"),
            false,
        );

        for (const { manifestPath, packageJson } of packages) {
            if (packageJson.name === "@bastani/atomic") continue;
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
                !dependencyName.startsWith("@bastani/"),
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
                assert.equal(
                    atomicRuntimeDependencyRange(dependencyName),
                    dependencyRange,
                    `@bastani/atomic must directly depend on ${dependencyName} for bundled ${bundledPackageJson.name}`,
                );
            }
        }
    });

    test("ships workflow, skill, and bundled agent assets through package metadata", () => {
        assert.ok(workflowsPackageJson.files.includes("builtin/**/*.ts"));
        assert.ok(workflowsPackageJson.files.includes("skills/**/*"));
        assert.deepEqual(workflowsPackageJson.pi.skills, ["./skills"]);
        assert.deepEqual(workflowsPackageJson.pi.builtin, ["./builtin"]);
    });

    test("subagents package ships bundled agent markdown files", () => {
        const bundledAgents = markdownFiles("packages/subagents/agents");
        assert.ok(
            bundledAgents.length > 0,
            "expected at least one bundled agent markdown file",
        );
    });
});
