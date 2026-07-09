import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    DefaultResourceLoader,
    type DefaultResourceLoaderInheritanceSnapshot,
} from "../../packages/coding-agent/src/core/resource-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

describe("DefaultResourceLoader inheritance snapshots", () => {
    test("ExtensionAPI exposes inherited resource options and child loaders consume them without sharing the parent loader", async () => {
        const cwd = tempDir("atomic-resource-inheritance-parent-");
        const childCwd = tempDir("atomic-resource-inheritance-child-");
        const agentDir = join(cwd, "agent");
        const externalPackage = tempDir("atomic-resource-inheritance-external-");
        const skillDir = join(externalPackage, "inherited-skill");
        const skillFile = join(skillDir, "SKILL.md");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
            skillFile,
            [
                "---",
                "name: inherited-skill",
                "description: Skill inherited by workflow stage resource loaders.",
                "---",
                "Use inherited instructions.",
            ].join("\n"),
        );

        const observedSnapshots: DefaultResourceLoaderInheritanceSnapshot[] = [];
        const parentLoader = new DefaultResourceLoader({
            cwd,
            agentDir,
            additionalExtensionPaths: [externalPackage],
            additionalSkillPaths: [skillFile],
            builtinPackagePaths: ["/repo/packages/workflows"],
            appendSystemPrompt: ["Parent append prompt"],
            extensionFactories: [
                (pi) => {
                    observedSnapshots.push(
                        pi.getResourceLoaderInheritanceSnapshot?.() ?? {},
                    );
                },
            ],
        });

        await parentLoader.reload();

        assert.equal(observedSnapshots.length, 1);
        assert.deepEqual(observedSnapshots[0]?.additionalExtensionPaths, [
            externalPackage,
        ]);
        assert.deepEqual(observedSnapshots[0]?.additionalSkillPaths, [skillFile]);
        assert.deepEqual(observedSnapshots[0]?.builtinPackagePaths, [
            "/repo/packages/workflows",
        ]);
        assert.deepEqual(observedSnapshots[0]?.appendSystemPrompt, [
            "Parent append prompt",
        ]);

        const childLoader = new DefaultResourceLoader({
            cwd: childCwd,
            agentDir,
            resourceLoaderInheritanceSnapshot: {
                ...observedSnapshots[0],
                trustedBorrowedProjectLocalSources: [externalPackage],
            },
            builtinPackagePaths: [],
        });
        await childLoader.reload();

        const childSkills = childLoader.getSkills().skills.map((skill) => skill.name);
        assert.ok(
            childSkills.includes("inherited-skill"),
            "expected child resource loader to load the inherited skill path",
        );
        const childSnapshot = childLoader.getInheritanceSnapshot();
        assert.deepEqual(childSnapshot.additionalExtensionPaths, [externalPackage]);
        assert.deepEqual(childSnapshot.additionalSkillPaths, [skillFile]);
        assert.deepEqual(childSnapshot.builtinPackagePaths, []);
        assert.deepEqual(childSnapshot.trustedBorrowedProjectLocalSources, [
            externalPackage,
        ]);
        assert.notEqual(childLoader, parentLoader);
    }, 10_000);
});
