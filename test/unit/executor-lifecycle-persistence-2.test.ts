import { describe } from "bun:test";
import {
    assert, createStore, workflow, run, test,
} from "./executor-shared.js";

describe("executor.run — lifecycle persistence", () => {
    function makePersistence() {
        const calls: Array<{ type: string; payload: Record<string, unknown> }> =
            [];
        const persistence = {
            appendEntry(
                type: string,
                payload: Record<string, unknown>,
            ): string {
                calls.push({ type, payload });
                return `entry-${calls.length}`;
            },
            setLabel(_entryId: string, _label: string): void {},
        };
        return { persistence, calls };
    }

    function lifecycleTypes(calls: Array<{ type: string }>): string[] {
        return calls.map((c) => c.type).filter((type) => type !== "workflow.durable.checkpoint");
    }

    test("run.end not appended when recordRunEnd returns false (terminal guard)", async () => {
        const { persistence, calls } = makePersistence();

        // Custom store that returns false for recordRunEnd
        const baseStore = createStore();
        const guardedStore = {
            ...baseStore,
            recordRunEnd(): boolean {
                // Simulate already-terminal: call real store but return false
                return false;
            },
        };

        const def = workflow({
          name: "guard-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.task("guard-smoke", { prompt: "go" });
                return {};
            },
        });

        await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: guardedStore as import("../../packages/workflows/src/shared/store.js").Store,
                persistence,
            },
        );

        const runEndCalls = calls.filter((c) => c.type === "workflow.run.end");
        assert.equal(runEndCalls.length, 0);
    });

    test("multi-stage: correct order run.start, stage.start×2, stage.end×2, run.end", async () => {
        const { persistence, calls } = makePersistence();

        const def = workflow({
          name: "multi-persist-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.stage("s1").prompt("a");
                await ctx.stage("s2").prompt("b");
                return {};
            },
        });

        await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async (t) => t } },
                store: createStore(),
                persistence,
            },
        );

        const types = lifecycleTypes(calls);
        assert.deepEqual(types, [
            "workflow.run.start",
            "workflow.stage.start",
            "workflow.stage.end",
            "workflow.stage.start",
            "workflow.stage.end",
            "workflow.run.end",
        ]);
    });
});
