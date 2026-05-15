import { describe, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import atomicPackageJson from "../../packages/coding-agent/package.json" with { type: "json" };
import workflowsPackageJson from "../../packages/workflows/package.json" with { type: "json" };

const STRICT_RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/;

interface WorkspacePackageJson {
  name: string;
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
          const manifestPath = join("packages", entry.name, "package.json");
          if (!existsSync(manifestPath)) return undefined;
          const packageJson = (await Bun.file(manifestPath).json()) as WorkspacePackageJson;
          return { manifestPath, packageJson };
        }),
    )
  )
    .filter((workspacePackage): workspacePackage is WorkspacePackage => workspacePackage !== undefined)
    .sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

describe("package metadata", () => {
  test("all workspace packages share the same strict release version", async () => {
    const packages = await workspacePackages();
    assert.ok(packages.length >= 6, "expected all first-party workspace packages");
    assert.match(atomicPackageJson.version, STRICT_RELEASE_VERSION_RE);

    for (const { manifestPath, packageJson } of packages) {
      assert.match(packageJson.version, STRICT_RELEASE_VERSION_RE, `${manifestPath} has an invalid release version`);
      assert.equal(packageJson.version, atomicPackageJson.version, `${manifestPath} must match @bastani/atomic`);
    }
  });

  test("only @bastani/atomic is publishable", async () => {
    const packages = await workspacePackages();
    assert.equal(atomicPackageJson.name, "@bastani/atomic");
    assert.equal(Object.prototype.hasOwnProperty.call(atomicPackageJson, "private"), false);

    for (const { manifestPath, packageJson } of packages) {
      if (packageJson.name === "@bastani/atomic") continue;
      assert.equal(packageJson.private, true, `${manifestPath} must remain private because it is bundled into @bastani/atomic`);
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
    assert.ok(bundledAgents.length > 0, "expected at least one bundled agent markdown file");
  });
});
