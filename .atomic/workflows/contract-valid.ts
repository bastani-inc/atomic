import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("contract-valid")
  .description("Manual validation workflow: returns declared JSON-serializable outputs for input/output contract testing.")
  .input("message", Type.String({ description: "Message to echo into serializable outputs." }))
  .input("count", Type.Number({ default: 2, description: "Number of serializable checklist items to generate." }))
  .input("enabled", Type.Boolean({ default: true, description: "Boolean value echoed into output metadata." }))
  .input(
    "flavor",
    Type.Union([Type.Literal("vanilla"), Type.Literal("chocolate"), Type.Literal("strawberry")], {
      default: "vanilla",
      description: "Select input used to verify select typing and validation.",
    }),
  )
  .output("result", Type.String({ description: "Human-readable summary." }))
  .output(
    "echo",
    Type.Object(
      {
        message: Type.String(),
        count: Type.Number(),
        enabled: Type.Boolean(),
        flavor: Type.String(),
        nested: Type.Object({ ok: Type.Boolean(), tags: Type.Array(Type.String()) }),
      },
      { description: "Serializable object echoing typed inputs." },
    ),
  )
  .output(
    "items",
    Type.Array(
      Type.Object({
        index: Type.Number(),
        label: Type.String(),
        message: Type.String(),
        enabled: Type.Boolean(),
      }),
      { description: "Serializable array generated from the count input." },
    ),
  )
  .output("count", Type.Number({ description: "Finite numeric output." }))
  .output("enabled", Type.Boolean({ description: "Boolean output." }))
  .output("flavor", Type.String({ description: "Selected flavor output." }))
  .run(async (ctx) => {
    const message = ctx.inputs.message;
    const count = Math.max(0, Math.min(10, Math.floor(ctx.inputs.count)));
    const enabled = ctx.inputs.enabled;
    const flavor = ctx.inputs.flavor;

    const items = Array.from({ length: count }, (_, index) => ({
      index: index + 1,
      label: `${flavor}-${index + 1}`,
      message,
      enabled,
    }));

    await ctx.stage("contract-marker", { noTools: "all" }).prompt(
      [
        "This is a manual workflow contract smoke test.",
        "Reply exactly: CONTRACT_VALID_STAGE_OK",
        "Do not ask questions. Do not call tools.",
      ].join("\n"),
    );

    return {
      result: `contract-valid echoed ${count} item${count === 1 ? "" : "s"} for ${flavor}`,
      echo: {
        message,
        count,
        enabled,
        flavor,
        nested: {
          ok: true,
          tags: ["json", "serializable", "declared-outputs"],
        },
      },
      items,
      count,
      enabled,
      flavor,
    };
  })
  .compile();
