import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const workflowsPackage = join(repoRoot, "packages", "workflows");
const typeboxPackage = join(repoRoot, "node_modules", "typebox");

const workflowOutputFixture = `import { run, workflow } from "@bastani/workflows";
import { Type } from "typebox";

const child = workflow({
  name: "Closed Output Child Fixture",
  description: "",
  outputs: {
    ok: Type.String(),
    maybe: Type.Optional(Type.String()),
  },
  run: (ctx) => {
    ctx.exit({ outputs: { ok: "ok" } });
    ctx.exit({ outputs: { maybe: "ok" } });
    // @ts-expect-error ctx.exit outputs are closed over declared keys.
    ctx.exit({ outputs: { missing: "x" } });
    // @ts-expect-error schema-derived output values are preserved.
    ctx.exit({ outputs: { ok: 1 } });
    return { ok: "ok" };
  },
});

const parent = workflow({
  name: "Closed Output Parent Fixture",
  description: "",
  outputs: {},
  run: async (ctx) => {
    const childResult = await ctx.workflow(child);
    const ok: string | undefined = childResult.outputs.ok;
    const maybe: string | undefined = childResult.outputs.maybe;
    // @ts-expect-error child outputs are closed over declared keys.
    childResult.outputs.missing;
    // @ts-expect-error empty output contracts reject undeclared exit outputs.
    ctx.exit({ outputs: { missing: "x" } });
    void ok;
    void maybe;
    return {};
  },
});

const extraReturnWorkflow = workflow({
  name: "Extra Return Output Fixture",
  description: "",
  outputs: {},
  // @ts-expect-error run must not return keys when outputs is empty.
  run: () => ({ missing: "x" }),
});

run(child, {}).then((runResult) => {
  const ok: string | undefined = runResult.result?.ok;
  const maybe: string | undefined = runResult.result?.maybe;
  // @ts-expect-error run result outputs are closed over declared keys.
  runResult.result?.missing;
  void ok;
  void maybe;
});

run(parent, {});
void extraReturnWorkflow;
export default parent;
`;

function runTsc(fixtureRoot: string): void {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf8",
  };
  try {
    execFileSync("bun", [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", fixtureRoot], options);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    assert.fail([failure.message, failure.stdout, failure.stderr].filter(Boolean).join("\n"));
  }
}

function writePackageFixture(fixtureRoot: string): void {
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  mkdirSync(join(fixtureRoot, "node_modules", "@bastani"), { recursive: true });
  symlinkSync(workflowsPackage, join(fixtureRoot, "node_modules", "@bastani", "workflows"), "dir");
  symlinkSync(typeboxPackage, join(fixtureRoot, "node_modules", "typebox"), "dir");
  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ name: "workflow-output-package-types", private: true, type: "module" }, null, 2));
  writeFileSync(
    join(fixtureRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          allowArbitraryExtensions: true,
          ignoreDeprecations: "6.0",
          baseUrl: ".",
          paths: {
            "@bastani/atomic": [join(repoRoot, "packages", "coding-agent", "src", "index.ts")],
            "@earendil-works/pi-tui": [join(repoRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.d.ts")],
          },
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(fixtureRoot, "src", "workflow.ts"), workflowOutputFixture);
}

function writeSourceFixture(fixtureRoot: string): void {
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  mkdirSync(join(fixtureRoot, "node_modules"), { recursive: true });
  symlinkSync(typeboxPackage, join(fixtureRoot, "node_modules", "typebox"), "dir");
  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ name: "workflow-output-source-types", private: true, type: "module" }, null, 2));
  writeFileSync(
    join(fixtureRoot, "tsconfig.json"),
    JSON.stringify(
      {
        extends: join(repoRoot, "tsconfig.json"),
        compilerOptions: { noEmit: true },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(fixtureRoot, "src", "workflow.ts"), workflowOutputFixture);
}

describe("workflow output typing", () => {
  test("closes package-authored output maps", () => {
    const fixtureRoot = join(tmpdir(), `atomic-workflow-output-package-types-${randomUUID()}`);
    try {
      writePackageFixture(fixtureRoot);
      runTsc(fixtureRoot);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test("closes source-authored output maps", () => {
    const fixtureRoot = join(tmpdir(), `atomic-workflow-output-source-types-${randomUUID()}`);
    try {
      writeSourceFixture(fixtureRoot);
      runTsc(fixtureRoot);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
