import { describe } from "bun:test";
import {
    assert, resolveInputs, test, Type,
} from "./executor-shared.js";

describe("resolveInputs", () => {
    test("applies defaults for missing optional inputs", () => {
        const result = resolveInputs(
            {
                foo: Type.String({ default: "bar" }),
                count: Type.Number({ default: 42 }),
            },
            {},
        );
        assert.equal(result["foo"], "bar");
        assert.equal(result["count"], 42);
    });

    test("passes through provided values", () => {
        const result = resolveInputs(
            { foo: Type.String({ default: "bar" }) },
            { foo: "override" },
        );
        assert.equal(result["foo"], "override");
    });

    test("does not override provided value with default", () => {
        const result = resolveInputs(
            { flag: Type.Boolean({ default: false }) },
            { flag: true },
        );
        assert.equal(result["flag"], true);
    });

    test("throws for missing required input", () => {
        assert.throws(
            () =>
                resolveInputs({ prompt: Type.String() }, {}),
            { message: 'atomic-workflows: required input "prompt" not provided' },
        );
    });

    test("does not throw when required input is provided", () => {
        const result = resolveInputs(
            { prompt: Type.String() },
            { prompt: "hello" },
        );
        assert.equal(result["prompt"], "hello");
    });
});

// ---------------------------------------------------------------------------
// executor.run
// ---------------------------------------------------------------------------

