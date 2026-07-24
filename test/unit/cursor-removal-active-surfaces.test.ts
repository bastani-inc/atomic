import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe("removed provider active surfaces", () => {
  test("builtin workflow and subagent model policies contain no removed-provider candidates", () => {
    for (const path of [
      "packages/workflows/builtin/ralph-models.ts",
      "packages/workflows/builtin/goal-models.ts",
      "packages/workflows/builtin/deep-research-codebase-utils.ts",
      "packages/workflows/builtin/open-claude-design-runner.ts",
    ]) {
      assert.doesNotMatch(read(path), /cursor\//iu, path);
    }

    const agentsDir = join(root, "packages/subagents/agents");
    for (const name of readdirSync(agentsDir).filter((entry) => entry.endsWith(".md"))) {
      const frontmatter = readFileSync(join(agentsDir, name), "utf8").split("---", 2)[1] ?? "";
      assert.doesNotMatch(frontmatter, /cursor\//iu, name);
    }

    assert.match(
      read("packages/subagents/agents/codebase-pattern-finder.md"),
      /Cursor-based pagination example/u,
      "ordinary pagination terminology must remain intact",
    );
  });

  test("Impeccable ships no removed-editor compatibility adapter", () => {
    assert.equal(
      existsSync(join(root, "packages/workflows/skills/impeccable/scripts/hook-before-edit.mjs")),
      false,
    );
    for (const path of [
      "packages/workflows/skills/impeccable/scripts/hook-admin.mjs",
      "packages/workflows/skills/impeccable/scripts/hook-lib.mjs",
      "packages/workflows/skills/impeccable/scripts/hook.mjs",
      "packages/workflows/skills/impeccable/scripts/live-poll.mjs",
      "packages/workflows/skills/impeccable/scripts/pin.mjs",
      "packages/workflows/skills/impeccable/scripts/live-browser.js",
      "packages/workflows/skills/impeccable/reference/hooks.md",
      "packages/workflows/skills/impeccable/reference/live.md",
    ]) {
      const content = read(path);
      assert.doesNotMatch(content, /\bCursor\b|\.cursor(?:\/|\\)|CURSOR_PROJECT_DIR|\bcursor(?:Event|Denials)\b/u, path);
    }
    assert.match(
      read("packages/workflows/skills/impeccable/reference/delight.md"),
      /Cursor changes \(custom cursors for branded experiences\)/u,
      "ordinary pointer-cursor design guidance must remain intact",
    );
  });

  test("Impeccable admin and pin commands ignore removed-editor directories", () => {
    const cwd = mkdtempSync(join(tmpdir(), "atomic-impeccable-removal-"));
    const scripts = join(root, "packages/workflows/skills/impeccable/scripts");
    try {
      mkdirSync(join(cwd, ".agents", "skills", "impeccable"), { recursive: true });
      mkdirSync(join(cwd, ".cursor", "skills", "impeccable"), { recursive: true });

      const admin = Bun.spawnSync({ cmd: ["bun", join(scripts, "hook-admin.mjs"), "on"], cwd });
      assert.equal(admin.exitCode, 0, admin.stderr.toString());
      assert.equal(existsSync(join(cwd, ".codex", "hooks.json")), true);
      assert.equal(existsSync(join(cwd, ".cursor", "hooks.json")), false);

      const pin = Bun.spawnSync({ cmd: ["bun", join(scripts, "pin.mjs"), "pin", "audit"], cwd });
      assert.equal(pin.exitCode, 0, pin.stderr.toString());
      assert.equal(existsSync(join(cwd, ".agents", "skills", "audit", "SKILL.md")), true);
      assert.equal(existsSync(join(cwd, ".cursor", "skills", "audit")), false);
      assert.doesNotMatch(`${admin.stdout}${pin.stdout}`, /\bCursor\b|\.cursor/u);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  test("MCP discovery ignores the removed home-level import while keeping supported imports", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "atomic-mcp-import-removal-"));
    const home = join(tempRoot, "home");
    const cwd = join(tempRoot, "project");
    const removedKind = ["cur", "sor"].join("");
    const supportedPath = join(home, ".claude", "mcp.json");
    const removedPath = join(home, `.${removedKind}`, "mcp.json");
    try {
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, `.${removedKind}`), { recursive: true });
      writeFileSync(supportedPath, '{"mcpServers":{"supported":{}}}\n');
      writeFileSync(removedPath, '{"mcpServers":{"removed":{}}}\n');

      const configUrl = pathToFileURL(join(root, "packages/mcp/config.ts")).href;
      const child = Bun.spawnSync({
        cmd: [process.execPath, "-e", `const { findAvailableImportConfigs } = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify(findAvailableImportConfigs(${JSON.stringify(cwd)})));`],
        cwd,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      assert.equal(child.exitCode, 0, child.stderr.toString());
      const discovered = JSON.parse(child.stdout.toString()) as Array<{ kind: string; path: string }>;
      assert.ok(discovered.some((entry) => entry.kind === "claude-code" && entry.path === supportedPath));
      assert.equal(discovered.some((entry) => entry.path === removedPath), false);
      assert.equal(discovered.some((entry) => entry.kind === removedKind), false);
      assert.notEqual(cwd, home);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });


  test("published Atomic dependency metadata omits the removed provider's protobuf runtime", () => {
    const dependency = "@bufbuild/" + "protobuf";
    for (const path of [
      "packages/coding-agent/package.json",
      "bun.lock",
      "package-lock.json",
      "packages/coding-agent/npm-shrinkwrap.json",
    ]) {
      assert.equal(read(path).includes(dependency), false, path);
    }
  });
});
