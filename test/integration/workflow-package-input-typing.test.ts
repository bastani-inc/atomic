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
    defaulted: Type.String({ default: "filled" }),
  },
  outputs: {},
  run: (ctx) => {
    const message: string = ctx.inputs.message;
    const nickname: string | undefined = ctx.inputs.nickname;
    const defaulted: string = ctx.inputs.defaulted;
    // @ts-expect-error ctx.inputs is closed over declared keys.
    ctx.inputs.extra;
    void message;
    void nickname;
    void defaulted;
    return {};
  },
});

const defaultOnlyWorkflow = workflow({
  name: "Default Only Fixture",
  description: "",
  inputs: {
    defaulted: Type.String({ default: "filled" }),
  },
  outputs: {},
  run: (ctx) => {
    const defaulted: string = ctx.inputs.defaulted;
    void defaulted;
    return {};
  },
});

const enumDefaultWorkflow = workflow({
  name: "Enum Default Fixture",
  description: "",
  inputs: {
    mode: Type.Enum({ Fast: "fast", Slow: "slow" } as const, { default: "fast" }),
  },
  outputs: {},
  run: (ctx) => {
    const mode: "fast" | "slow" = ctx.inputs.mode;
    void mode;
    return {};
  },
});

const enumRequiredWorkflow = workflow({
  name: "Enum Required Fixture",
  description: "",
  inputs: {
    mode: Type.Enum({ Fast: "fast", Slow: "slow" } as const),
  },
  outputs: {},
  run: (ctx) => {
    const mode: "fast" | "slow" = ctx.inputs.mode;
    void mode;
    return {};
  },
});

const parentWorkflow = workflow({
  name: "Parent Input Fixture",
  description: "",
  outputs: {},
  run: async (ctx) => {
    await ctx.workflow(defaultOnlyWorkflow, { inputs: {} });
    await ctx.workflow(enumDefaultWorkflow, { inputs: {} });
    await ctx.workflow(closedInputWorkflow, { inputs: { message: "ok" } });
    // @ts-expect-error required child input remains required.
    await ctx.workflow(closedInputWorkflow, { inputs: {} });
    // @ts-expect-error required enum child input remains required.
    await ctx.workflow(enumRequiredWorkflow, { inputs: {} });
    return {};
  },
});

const noInputWorkflow = workflow({
  name: "No Input Fixture",
  description: "",
  outputs: {},
  run: (ctx) => {
    // @ts-expect-error ctx.inputs is closed when inputs is omitted.
    ctx.inputs.extra;
    return {};
  },
});

run(closedInputWorkflow, { message: "ok" });
run(closedInputWorkflow, { message: "ok", nickname: "nick" });
run(closedInputWorkflow, { message: "ok", defaulted: "custom" });
run(defaultOnlyWorkflow, {});
run(enumDefaultWorkflow, {});
run(enumDefaultWorkflow, { mode: "slow" });
run(enumRequiredWorkflow, { mode: "fast" });
run(parentWorkflow, {});
// @ts-expect-error defaulted input still rejects the wrong provided value type.
run(defaultOnlyWorkflow, { defaulted: 1 });
// @ts-expect-error enum default input still rejects the wrong provided value.
run(enumDefaultWorkflow, { mode: "medium" });
// @ts-expect-error enum input without default remains required.
run(enumRequiredWorkflow, {});
// @ts-expect-error run inputs reject undeclared object-literal keys.
run(closedInputWorkflow, { message: "ok", extra: "nope" });
// @ts-expect-error required input remains required.
run(closedInputWorkflow, {});
run(noInputWorkflow, {});
// @ts-expect-error omitted inputs reject arbitrary object-literal keys.
run(noInputWorkflow, { extra: "nope" });
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
