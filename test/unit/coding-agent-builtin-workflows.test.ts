/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getBuiltinPackagePaths } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const expectedBuiltinPackages = [
  resolve("packages/workflows"),
  resolve("packages/subagents"),
  resolve("packages/mcp"),
  resolve("packages/web-access"),
  resolve("packages/intercom"),
  resolve("packages/cursor-provider"),
];

const builtinPackageFixtures = [
  { packageName: "@bastani/workflows", dirname: "workflows", requiredEntry: join("src", "extension", "index.ts") },
  { packageName: "@bastani/subagents", dirname: "subagents", requiredEntry: join("src", "extension", "index.ts") },
  { packageName: "@bastani/mcp", dirname: "mcp", requiredEntry: "index.ts" },
  { packageName: "@bastani/web-access", dirname: "web-access", requiredEntry: "index.ts" },
  { packageName: "@bastani/intercom", dirname: "intercom", requiredEntry: "index.ts" },
  { packageName: "@bastani/cursor-provider", dirname: "cursor-provider", requiredEntry: "index.ts" },
] as const;

const fullBuiltinPackageLoadTimeoutMs = 60_000;

describe("coding-agent builtin resources", () => {
  test("discovers bundled companion packages in development", () => {
    assert.deepEqual(getBuiltinPackagePaths(), expectedBuiltinPackages);
  });

  test("discovers shipped binary adjacent builtin packages", () => {
    const packageDir = tempDir("atomic-binary-package-dir-");
    const previousPackageDir = process.env.ATOMIC_PACKAGE_DIR;
    try {
      for (const fixture of builtinPackageFixtures) {
        const builtinDir = join(packageDir, "builtin", fixture.dirname);
        const entryPath = join(builtinDir, fixture.requiredEntry);
        mkdirSync(dirname(entryPath), { recursive: true });
        writeFileSync(join(builtinDir, "package.json"), JSON.stringify({ name: fixture.packageName }), "utf-8");
        writeFileSync(entryPath, "export default function register() {}\n", "utf-8");
      }
      process.env.ATOMIC_PACKAGE_DIR = packageDir;

      assert.deepEqual(
        getBuiltinPackagePaths(),
        builtinPackageFixtures.map((fixture) => join(packageDir, "builtin", fixture.dirname)),
      );
    } finally {
      if (previousPackageDir === undefined) delete process.env.ATOMIC_PACKAGE_DIR;
      else process.env.ATOMIC_PACKAGE_DIR = previousPackageDir;
    }
  });

  test("exposes package workflow resources to extensions", async () => {
    const cwd = tempDir("atomic-workflow-package-cwd-");
    const agentDir = tempDir("atomic-workflow-package-agent-");
    const packageDir = join(cwd, "workflow-package");
    const workflowsDir = join(packageDir, "workflow");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "workflow-package", atomic: { extensions: ["./index.ts"] } }),
      "utf-8",
    );
    writeFileSync(
      join(workflowsDir, "custom.ts"),
      "export default { __piWorkflow: true, name: 'Custom', normalizedName: 'custom', inputs: {}, run: async (ctx) => { await ctx.task('validation-smoke', { prompt: 'validation smoke' }); return {}; } };\n",
      "utf-8",
    );
    writeFileSync(
      join(packageDir, "index.ts"),
      [
        "export default function(pi) {",
        "  const resources = pi.getWorkflowResources?.() ?? [];",
        "  pi.registerCommand('workflow-resource-count', {",
        "    description: `workflow resources: ${resources.filter((r) => r.enabled).length}` ,",
        "    handler() {},",
        "  });",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const settingsManager = SettingsManager.inMemory();
    settingsManager.setPackages([packageDir]);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, builtinPackagePaths: [] });

    await loader.reload();

    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    const command = extensions.extensions[0]?.commands.get("workflow-resource-count");
    assert.equal(command?.description, "workflow resources: 1");
  }, 20_000);

  test("registers package workflow names in /workflow completions", async () => {
    const cwd = tempDir("atomic-workflow-command-cwd-");
    const agentDir = tempDir("atomic-workflow-command-agent-");
    const packageDir = join(cwd, "workflow-command-package");
    const workflowsDir = join(packageDir, "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "workflow-command-package", keywords: ["atomic-package"] }),
      "utf-8",
    );
    writeFileSync(
      join(workflowsDir, "package-command.ts"),
      [
        `import { defineWorkflow } from "@bastani/workflows";`,
        ``,
        `export default defineWorkflow("package-command")`,
        `  .description("Package command workflow")`,
        `  .run(async (ctx) => {`,
        `    await ctx.task("validation-smoke", { prompt: "validation smoke" });`,
        `    return {};`,
        `  })`,
        `  .compile();`,
      ].join("\n"),
      "utf-8",
    );

    const settingsManager = SettingsManager.inMemory();
    settingsManager.setPackages([packageDir]);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      builtinPackagePaths: [resolve("packages/workflows")],
    });

    await loader.reload();

    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    const workflowExtension = extensions.extensions.find((extension) =>
      extension.path.replace(/\\/g, "/").endsWith("packages/workflows/src/extension/index.ts"),
    );
    const workflowCommand = workflowExtension?.commands.get("workflow");
    assert.notEqual(workflowCommand, undefined);

    let labels: string[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const completions = (await workflowCommand!.getArgumentCompletions?.("")) ?? [];
      labels = completions.map((completion) => completion.label);
      if (labels.includes("package-command")) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }

    assert.ok(labels.includes("package-command"), `expected package workflow completion in ${labels.join(", ")}`);
  }, 20_000);

  test("loads builtin pi package resources", async () => {
    const cwd = tempDir("atomic-builtin-packages-cwd-");
    const agentDir = tempDir("atomic-builtin-packages-agent-");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      builtinPackagePaths: expectedBuiltinPackages,
    });

    await loader.reload();

    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);

    const extensionPaths = extensions.extensions.map((extension) => extension.path.replace(/\\/g, "/"));
    for (const suffix of [
      "packages/workflows/src/extension/index.ts",
      "packages/subagents/src/extension/index.ts",
      "packages/mcp/index.ts",
      "packages/web-access/index.ts",
      "packages/intercom/index.ts",
      "packages/cursor-provider/index.ts",
    ]) {
      assert.ok(
        extensionPaths.some((extensionPath) => extensionPath.endsWith(suffix)),
        `expected builtin extension path ending in ${suffix}`,
      );
    }

    const skillNames = new Set(loader.getSkills().skills.map((skill) => skill.name));
    for (const skillName of ["subagent", "intercom"]) {
      assert.ok(skillNames.has(skillName), `expected builtin skill ${skillName}`);
    }

    const atomicPrompt = loader.getPrompts().prompts.find((prompt) => prompt.name === "atomic");
    assert.equal(atomicPrompt, undefined, "expected /atomic to be a builtin command, not an LLM prompt template");

    const subagentExtension = extensions.extensions.find((extension) =>
      extension.path.replace(/\\/g, "/").endsWith("packages/subagents/src/extension/index.ts"),
    );
    assert.equal(subagentExtension?.commands.get("atomic"), undefined, "expected subagents not to register /atomic");

    const atomicCommand = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "atomic");
    assert.ok(atomicCommand, "expected builtin /atomic command");
    assert.equal(atomicCommand.description, "Atomic onboarding and help guide");
    assert.equal(typeof atomicCommand.getArgumentCompletions, "function");
  }, fullBuiltinPackageLoadTimeoutMs);
});
