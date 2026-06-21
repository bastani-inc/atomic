import { describe, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const workflowsPackage = join(repoRoot, "packages", "workflows");

describe("standalone workflow package input typing", () => {
  test("closes inferred ctx.inputs and run inputs", () => {
    const fixtureRoot = join(tmpdir(), `atomic-workflow-input-types-${randomUUID()}`);
    try {
      mkdirSync(join(fixtureRoot, "src"), { recursive: true });
      mkdirSync(join(fixtureRoot, "node_modules", "@bastani"), { recursive: true });
      symlinkSync(workflowsPackage, join(fixtureRoot, "node_modules", "@bastani", "workflows"), "dir");
      symlinkSync(join(repoRoot, "node_modules", "typebox"), join(fixtureRoot, "node_modules", "typebox"), "dir");
      writeFileSync(
        join(fixtureRoot, "package.json"),
        JSON.stringify({ name: "workflow-input-typing-fixture", private: true, type: "module" }, null, 2),
      );
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
      writeFileSync(
        join(fixtureRoot, "src", "workflow.ts"),
        `import { run, workflow } from "@bastani/workflows";
import { Type } from "typebox";

const closedInputWorkflow = workflow({
  name: "Closed Input Fixture",
  description: "",
  inputs: {
    message: Type.String(),
    nickname: Type.Optional(Type.String()),
  },
  outputs: {},
  run: (ctx) => {
    const message: string = ctx.inputs.message;
    const nickname: string | undefined = ctx.inputs.nickname;
    // @ts-expect-error ctx.inputs is closed over declared keys.
    ctx.inputs.extra;
    void message;
    void nickname;
    return {};
  },
});

run(closedInputWorkflow, { message: "ok" });
run(closedInputWorkflow, { message: "ok", nickname: "nick" });
// @ts-expect-error run inputs reject undeclared object-literal keys.
run(closedInputWorkflow, { message: "ok", extra: "nope" });
// @ts-expect-error required input remains required.
run(closedInputWorkflow, {});
export default closedInputWorkflow;
`,
      );
      execFileSync("bun", [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", fixtureRoot], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
