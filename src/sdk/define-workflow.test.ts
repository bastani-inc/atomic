import { test, expect, describe } from "bun:test";
import { defineWorkflow, WorkflowBuilder, RESERVED_INPUT_NAMES } from "./define-workflow.ts";
import type { WorkflowInput } from "./types.ts";

describe("defineWorkflow", () => {
  test("returns a WorkflowBuilder", () => {
    const builder = defineWorkflow({ name: "test", source: import.meta.path });
    expect(builder).toBeInstanceOf(WorkflowBuilder);
    expect(builder.__brand).toBe("WorkflowBuilder");
  });

  test("throws on empty name", () => {
    expect(() => defineWorkflow({ name: "", source: import.meta.path })).toThrow("Workflow name is required");
  });

  test("throws on whitespace-only name", () => {
    expect(() => defineWorkflow({ name: "   ", source: import.meta.path })).toThrow("Workflow name is required");
  });

  test("throws on missing source at compile()", () => {
    expect(() =>
      // Cast required because the type requires `source`; this exercises the
      // runtime guard for users who silence the type error.
      defineWorkflow({ name: "no-source" } as unknown as { name: string; source: string })
        .for("copilot")
        .run(async () => {})
        .compile(),
    ).toThrow(/missing the `source` option/);
  });

  test("propagates source onto the compiled definition", () => {
    const def = defineWorkflow({ name: "with-src", source: import.meta.path })
      .for("copilot")
      .run(async () => {})
      .compile();
    expect(def.source).toBe(import.meta.path);
  });
});

describe("WorkflowBuilder.run()", () => {
  test("accepts a function and returns this for chaining", () => {
    const builder = defineWorkflow({ name: "test", source: import.meta.path });
    const result = builder.run(async () => {});
    expect(result).toBe(builder);
  });

  test("throws if called twice", () => {
    const builder = defineWorkflow({ name: "test", source: import.meta.path }).run(async () => {});
    expect(() => builder.run(async () => {})).toThrow("run() can only be called once");
  });

  test("throws if argument is not a function", () => {
    const builder = defineWorkflow({ name: "test", source: import.meta.path });
    expect(() => builder.run("not a function" as never)).toThrow("run() requires a function");
  });
});

describe("WorkflowBuilder.compile()", () => {
  test("produces a WorkflowDefinition with correct brand", () => {
    const def = defineWorkflow({ name: "test", source: import.meta.path })
      .for("copilot")
      .run(async () => {})
      .compile();
    expect(def.__brand).toBe("WorkflowDefinition");
  });

  test("defaults inputs to an empty array when none are declared", () => {
    const def = defineWorkflow({ name: "test", source: import.meta.path })
      .for("copilot")
      .run(async () => {})
      .compile();
    expect(def.inputs).toEqual([]);
  });

  test("preserves declared inputs in order", () => {
    const def = defineWorkflow({
      name: "gen-spec",
      source: import.meta.path,
      inputs: [
        {
          name: "research_doc",
          type: "string",
          required: true,
          description: "path",
        },
        {
          name: "focus",
          type: "enum",
          required: true,
          values: ["minimal", "standard", "exhaustive"],
          default: "standard",
        },
      ],
    })
      .for("opencode")
      .run(async () => {})
      .compile();
    expect(def.inputs).toHaveLength(2);
    expect(def.inputs[0]?.name).toBe("research_doc");
    expect(def.inputs[1]?.name).toBe("focus");
    expect(def.inputs[1]?.type).toBe("enum");
  });

  test("freezes declared inputs to prevent downstream mutation", () => {
    const def = defineWorkflow({
      name: "test",
      source: import.meta.path,
      inputs: [{ name: "foo", type: "string" }],
    })
      .for("claude")
      .run(async () => {})
      .compile();
    expect(() => {
      (def.inputs as unknown as WorkflowInput[])[0]!.name = "bar";
    }).toThrow();
  });

  test("rejects enum inputs with no values", () => {
    expect(() =>
      defineWorkflow({
        name: "bad",
        source: import.meta.path,
        inputs: [{ name: "mode", type: "enum" }],
      })
        .for("copilot")
        .run(async () => {})
        .compile(),
    ).toThrow("declares no `values`");
  });

  test("rejects enum defaults outside the allowed values", () => {
    expect(() =>
      defineWorkflow({
        name: "bad",
        source: import.meta.path,
        inputs: [
          {
            name: "mode",
            type: "enum",
            values: ["a", "b"],
            default: "c",
          },
        ],
      })
        .for("copilot")
        .run(async () => {})
        .compile(),
    ).toThrow(/not one of its declared values/);
  });

  test("rejects input names that are not valid CLI flag tails", () => {
    expect(() =>
      defineWorkflow({
        name: "bad",
        source: import.meta.path,
        inputs: [{ name: "1bad", type: "string" }],
      })
        .for("copilot")
        .run(async () => {})
        .compile(),
    ).toThrow(/invalid/);
  });

  test("rejects duplicate input names", () => {
    expect(() =>
      defineWorkflow({
        name: "bad",
        source: import.meta.path,
        inputs: [
          { name: "foo", type: "string" },
          { name: "foo", type: "string" },
        ],
      })
        .for("copilot")
        .run(async () => {})
        .compile(),
    ).toThrow(/duplicate input name/);
  });

  test("preserves name, description, and agent", () => {
    const def = defineWorkflow({ name: "my-wf", description: "A description", source: import.meta.path })
      .for("claude")
      .run(async () => {})
      .compile();
    expect(def.name).toBe("my-wf");
    expect(def.description).toBe("A description");
    expect(def.agent).toBe("claude");
  });

  test("defaults description to empty string", () => {
    const def = defineWorkflow({ name: "test", source: import.meta.path })
      .for("opencode")
      .run(async () => {})
      .compile();
    expect(def.description).toBe("");
  });

  test("stores the run function", () => {
    const fn = async () => {};
    const def = defineWorkflow({ name: "test", source: import.meta.path }).for("copilot").run(fn).compile();
    expect(def.run).toBe(fn);
  });

  test("throws if no run callback was provided", () => {
    const builder = defineWorkflow({ name: "test", source: import.meta.path }).for("copilot");
    expect(() => builder.compile()).toThrow("has no run callback");
  });

  test("throws if .for() was not called before compile()", () => {
    const builder = defineWorkflow({ name: "test", source: import.meta.path }).run(async () => {});
    expect(() => builder.compile()).toThrow("has no agent");
  });
});

describe("RESERVED_INPUT_NAMES — reserved name validation", () => {
  test("RESERVED_INPUT_NAMES is exported and contains expected names", () => {
    expect(RESERVED_INPUT_NAMES).toContain("name");
    expect(RESERVED_INPUT_NAMES).toContain("agent");
    expect(RESERVED_INPUT_NAMES).toContain("detach");
    expect(RESERVED_INPUT_NAMES).toContain("list");
    expect(RESERVED_INPUT_NAMES).toContain("help");
    expect(RESERVED_INPUT_NAMES).toContain("version");
  });

  // Each reserved name must be rejected individually.
  for (const reserved of RESERVED_INPUT_NAMES) {
    test(`rejects reserved input name "${reserved}"`, () => {
      expect(() =>
        defineWorkflow({
          name: "bad",
          source: import.meta.path,
          inputs: [{ name: reserved, type: "string" }],
        })
          .for("copilot")
          .run(async () => {})
          .compile(),
      ).toThrow(reserved);
    });
  }

  test("error message lists all reserved names", () => {
    let message = "";
    try {
      defineWorkflow({
        name: "bad",
        source: import.meta.path,
        inputs: [{ name: "name", type: "string" }],
      })
        .for("copilot")
        .run(async () => {})
        .compile();
    } catch (e) {
      message = (e as Error).message;
    }
    for (const reserved of RESERVED_INPUT_NAMES) {
      expect(message).toContain(reserved);
    }
  });

  test("non-reserved input name passes validation", () => {
    expect(() =>
      defineWorkflow({
        name: "ok",
        source: import.meta.path,
        inputs: [{ name: "topic", type: "string" }],
      })
        .for("copilot")
        .run(async () => {})
        .compile(),
    ).not.toThrow();
  });

  test("non-reserved name that is a prefix of a reserved name passes", () => {
    expect(() =>
      defineWorkflow({
        name: "ok",
        source: import.meta.path,
        inputs: [{ name: "named", type: "string" }],
      })
        .for("copilot")
        .run(async () => {})
        .compile(),
    ).not.toThrow();
  });
});

describe("WorkflowBuilder.for()", () => {
  test("returns a new builder with agent set", () => {
    const builder = defineWorkflow({ name: "test", source: import.meta.path });
    const narrowed = builder.for("copilot");
    // .for() returns a new builder instance
    expect(narrowed).toBeInstanceOf(WorkflowBuilder);
    expect(narrowed).not.toBe(builder as unknown);
  });

  test("stores agent on the compiled definition", () => {
    const def = defineWorkflow({ name: "test", source: import.meta.path })
      .for("copilot")
      .run(async () => {})
      .compile();
    expect(def.agent).toBe("copilot");
  });

  test("chains with run and compile", () => {
    const def = defineWorkflow({
      name: "test",
      source: import.meta.path,
      inputs: [{ name: "greeting", type: "string" }],
    })
      .for("copilot")
      .run(async () => {})
      .compile();
    expect(def.__brand).toBe("WorkflowDefinition");
    expect(def.inputs[0]?.name).toBe("greeting");
  });
});

describe("typed inputs (compile-time)", () => {
  test("structured inputs restrict ctx.inputs keys", () => {
    // This test validates that the type system correctly narrows
    // ctx.inputs to only declared field names. The assertions below
    // are runtime no-ops — the real check is that tsc compiles this
    // file without errors (or produces errors only where expected).
    defineWorkflow({
      name: "typed-test",
      source: import.meta.path,
      inputs: [
        { name: "greeting", type: "string", required: true },
        { name: "style", type: "enum", values: ["formal", "casual"] },
      ],
    })
      .for("copilot")
      .run(async (ctx) => {
        // Declared keys are valid
        const _g: string | undefined = ctx.inputs.greeting;
        const _s: string | undefined = ctx.inputs.style;
        // Undeclared key — would be a compile error without @ts-expect-error
        // @ts-expect-error — "prompt" is not a declared input
        ctx.inputs.prompt;
        expect(true).toBe(true);
      })
      .compile();
  });

  test("free-form workflows allow any key", () => {
    defineWorkflow({ name: "freeform-test", source: import.meta.path })
      .for("copilot")
      .run(async (ctx) => {
        const _p: string | undefined = ctx.inputs.prompt;
        expect(true).toBe(true);
      })
      .compile();
  });
});
