import { describe } from "bun:test";
import {
    assert, createStore, workflow, run, test, Type, type StageSnapshot,
} from "./executor-shared.js";

describe("executor.run", () => {
    test("continuation replays structured task JSON as text before executing only the failed child boundary", async () => {
        const store = createStore();
        const sourceRunId = "structured-task-source";
        const clarificationStageId = "source-clarification-turn-1";
        const artifactReviewStageId = "source-artifact-review-1";
        const preIdeationBoundaryId = "source-pre-ideation-boundary";
        const clarificationJson = JSON.stringify({ decision: "ready" });
        const livePromptCalls: string[] = [];
        const uiCalls: string[] = [];
        let observedClarificationText: string | undefined;
        let observedClarificationStructured: unknown = "not observed";
        let observedClarificationHasStructured = true;
        let observedClarificationSessionFile: string | undefined;

        const preIdeation = workflow({
            name: "pre-ideation",
            description: "",
            inputs: {},
            outputs: { setup: Type.String() },
            run: async (ctx) => {
                const setup = await ctx.task("setup", { prompt: "run nested setup" });
                return { setup: setup.text };
            },
        });
        const parent = workflow({
            name: "structured-task-continuation-parent",
            description: "",
            inputs: {},
            outputs: {
                clarificationText: Type.String(),
                setup: Type.String(),
            },
            run: async (ctx) => {
                const clarification = await ctx.task("clarification-turn-1", {
                    prompt: "collect clarification",
                    schema: Type.Object({ decision: Type.String() }),
                });
                observedClarificationText = clarification.text;
                observedClarificationStructured = clarification.structured;
                observedClarificationHasStructured = Object.hasOwn(clarification, "structured");
                observedClarificationSessionFile = clarification.sessionFile;
                await ctx.stage("artifact review 1").prompt(`review:${clarification.text}`);
                const child = await ctx.workflow(preIdeation);
                const setup = child.outputs.setup;
                if (setup === undefined) throw new Error("pre-ideation setup output missing");
                return {
                    clarificationText: clarification.text,
                    setup,
                };
            },
        });

        store.recordRunStart({
            id: sourceRunId,
            name: parent.name,
            inputs: {},
            status: "running",
            stages: [],
            startedAt: 1,
        });
        const recordSourceStage = (stage: StageSnapshot): void => {
            store.recordStageStart(sourceRunId, {
                id: stage.id,
                name: stage.name,
                status: "running",
                parentIds: stage.parentIds,
                toolEvents: [],
                ...(stage.replayKey !== undefined ? { replayKey: stage.replayKey } : {}),
                ...(stage.startedAt !== undefined ? { startedAt: stage.startedAt } : {}),
                ...(stage.sessionFile !== undefined ? { sessionFile: stage.sessionFile } : {}),
            });
            store.recordStageEnd(sourceRunId, stage);
        };
        recordSourceStage({
            id: clarificationStageId,
            name: "clarification-turn-1",
            replayKey: "stage:task:clarification-turn-1:1",
            status: "completed",
            parentIds: [],
            result: clarificationJson,
            sessionFile: "source-clarification.jsonl",
            toolEvents: [],
            startedAt: 2,
            endedAt: 3,
            durationMs: 1,
        });
        recordSourceStage({
            id: artifactReviewStageId,
            name: "artifact review 1",
            replayKey: "stage:artifact review 1:1",
            status: "completed",
            parentIds: [clarificationStageId],
            result: "artifact review complete",
            toolEvents: [],
            startedAt: 4,
            endedAt: 5,
            durationMs: 1,
        });
        recordSourceStage({
            id: preIdeationBoundaryId,
            name: "workflow:pre-ideation",
            replayKey: "workflow:workflow:pre-ideation:1",
            status: "failed",
            parentIds: [artifactReviewStageId],
            error: "failed before child launch",
            toolEvents: [],
            startedAt: 6,
            endedAt: 7,
            durationMs: 1,
        });
        store.recordRunEnd(
            sourceRunId,
            "failed",
            undefined,
            "failed before child launch",
            { resumable: true, failedStageId: preIdeationBoundaryId },
        );
        const source = store.runs().find((candidate) => candidate.id === sourceRunId)!;

        const continued = await run(parent, {}, {
            runId: "structured-task-continuation",
            store,
            continuation: { source, resumeFromStageId: preIdeationBoundaryId },
            adapters: {
                prompt: {
                    prompt: async (text) => {
                        livePromptCalls.push(text);
                        return "setup-live";
                    },
                },
            },
            ui: {
                input: async () => {
                    uiCalls.push("input");
                    return "";
                },
                confirm: async () => {
                    uiCalls.push("confirm");
                    return false;
                },
                select: async <T extends string>(_message: string, options: readonly T[]) => {
                    uiCalls.push("select");
                    return options[0]!;
                },
                editor: async () => {
                    uiCalls.push("editor");
                    return "";
                },
            },
        });

        assert.equal(continued.status, "completed");
        assert.equal(source.status, "failed", "source failed run remains terminal");
        assert.equal(observedClarificationText, clarificationJson);
        assert.equal(observedClarificationStructured, undefined);
        assert.equal(observedClarificationHasStructured, false);
        assert.equal(observedClarificationSessionFile, "source-clarification.jsonl");
        assert.equal(continued.result?.["clarificationText"], clarificationJson);
        assert.equal(continued.result?.["setup"], "setup-live");
        assert.deepEqual(livePromptCalls, ["run nested setup"]);
        assert.deepEqual(uiCalls, []);

        const replayedClarification = continued.stages.find((stage) => stage.name === "clarification-turn-1")!;
        const replayedArtifactReview = continued.stages.find((stage) => stage.name === "artifact review 1")!;
        const liveBoundary = continued.stages.find((stage) => stage.name === "workflow:pre-ideation")!;
        assert.equal(replayedClarification.replayed, true);
        assert.equal(replayedClarification.replayedFromStageId, clarificationStageId);
        assert.equal(replayedClarification.result, clarificationJson);
        assert.equal(replayedArtifactReview.replayed, true);
        assert.equal(replayedArtifactReview.replayedFromStageId, artifactReviewStageId);
        assert.deepEqual(replayedArtifactReview.parentIds, [replayedClarification.id]);
        assert.notEqual(liveBoundary.replayed, true);
        assert.equal(liveBoundary.replayedFromStageId, preIdeationBoundaryId);
        assert.deepEqual(liveBoundary.parentIds, [replayedArtifactReview.id]);

        const continuationSnapshot = store.runs().find((candidate) => candidate.id === continued.runId)!;
        assert.equal(continuationSnapshot.resumedFromRunId, sourceRunId);
        assert.equal(continuationSnapshot.resumeFromStageId, preIdeationBoundaryId);
        const childRuns = store.runs().filter((candidate) => candidate.parentRunId === continued.runId);
        assert.equal(childRuns.length, 1);
        assert.equal(childRuns[0]!.name, preIdeation.name);
        assert.deepEqual(childRuns[0]!.stages.map((stage) => stage.name), ["setup"]);
        assert.notEqual(childRuns[0]!.stages[0]!.replayed, true);
    });
});
