/**
 * Replayed stages must keep the model identity that was persisted for them.
 *
 * `/workflow resume` rebuilds a completed stage's card from the replay source
 * snapshot rather than from a live session, so the graph node card renders
 * whatever `StageSnapshot.model` / `.thinkingLevel` / `.fastMode` the replay
 * initialization copies across. When those fields are dropped the card falls
 * back to "—" even though the durable checkpoint still holds the model.
 *
 * This is a distinct path from `recordCachedStageIntoStore` (checkpoint ->
 * store hydration, covered in durable-stage-frontier-fixes.test.ts): here the
 * source is an in-memory continuation snapshot.
 */
import { describe } from "vitest";
import {
    assert, createStore, workflow, run, test, Type,
} from "./executor-shared.js";

const MODEL = "anthropic/claude-opus-4.8";

/** Runs a two-stage workflow whose second stage fails, returning the resumable source run. */
async function failedSourceRun() {
    const store = createStore();
    const def = workflow({
        name: "replay-model-identity-wf",
        description: "",
        inputs: {},
        outputs: {
            first: Type.Optional(Type.Any()),
            second: Type.Optional(Type.Any()),
        },
        run: async (ctx) => {
            const first = await ctx.stage("first").prompt("first");
            const second = await ctx.stage("second").prompt(`second:${first}`);
            return { first, second };
        },
    });

    const firstRun = await run(def, {}, {
        store,
        adapters: {
            prompt: {
                prompt: async (text: string) => {
                    if (text.startsWith("second:")) throw new Error("resume-me");
                    return "first-result";
                },
            },
        },
    });

    assert.equal(firstRun.status, "failed");
    const source = store.runs().find((candidate) => candidate.id === firstRun.runId)!;
    return { def, store, source };
}

/** Resumes `source` and returns the replayed snapshot for the already-completed "first" stage. */
async function resumeAndGetReplayedStage(
    def: Awaited<ReturnType<typeof failedSourceRun>>["def"],
    store: Awaited<ReturnType<typeof failedSourceRun>>["store"],
    source: Awaited<ReturnType<typeof failedSourceRun>>["source"],
) {
    const continued = await run(def, {}, {
        store,
        continuation: { source, resumeFromStageId: source.failedStageId! },
        adapters: { prompt: { prompt: async () => "second-result" } },
    });

    assert.equal(continued.status, "completed", continued.error);
    const replayed = continued.stages.find((stage) => stage.name === "first")!;
    assert.equal(replayed.replayed, true, "the first stage must be replayed, not re-executed");
    return replayed;
}

describe("replayed stages retain model identity", () => {
    test("resume restores model, thinking level, and fast tier onto the replayed stage", async () => {
        const { def, store, source } = await failedSourceRun();

        // Simulate a source whose completed stage carries the persisted model identity.
        const withIdentity = {
            ...source,
            stages: source.stages.map((stage) => stage.name === "first"
                ? { ...stage, model: MODEL, thinkingLevel: "high", fastMode: true }
                : stage),
        };

        const replayed = await resumeAndGetReplayedStage(def, store, withIdentity);

        assert.equal(replayed.model, MODEL);
        assert.equal(replayed.thinkingLevel, "high");
        assert.equal(replayed.fastMode, true);
    });

    test("a source stage without model identity replays without inventing one", async () => {
        const { def, store, source } = await failedSourceRun();

        const replayed = await resumeAndGetReplayedStage(def, store, source);

        assert.equal(replayed.model, undefined);
        assert.equal(replayed.thinkingLevel, undefined);
        assert.equal(replayed.fastMode, undefined);
    });
});
