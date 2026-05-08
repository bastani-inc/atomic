import { test, expect, spyOn } from "bun:test";
import type CodeGraph from "@colbymchenry/codegraph";
import { openGraphForRun, closeGraph } from "./orchestration.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeGraph(opts: { closeFails?: boolean } = {}): CodeGraph {
  return {
    close: opts.closeFails
      ? () => { throw new Error("close-error"); }
      : () => {},
  } as unknown as CodeGraph;
}

// ---------------------------------------------------------------------------
// openGraphForRun
// ---------------------------------------------------------------------------

test("openGraphForRun: returns null immediately when healthy=false", async () => {
  const result = await openGraphForRun("/any/root", false);
  expect(result).toBeNull();
});

test("openGraphForRun: returns graph instance when healthy=true and open succeeds", async () => {
  const fakeGraph = makeGraph();
  const CodeGraphModule = await import("@colbymchenry/codegraph");
  const openSpy = spyOn(CodeGraphModule.default, "open").mockResolvedValueOnce(fakeGraph as never);

  const result = await openGraphForRun("/repo", true);
  expect(result).toBe(fakeGraph);
  expect(openSpy).toHaveBeenCalledWith("/repo", { readOnly: true });

  openSpy.mockRestore();
});

test("openGraphForRun: returns null when healthy=true but open throws", async () => {
  const CodeGraphModule = await import("@colbymchenry/codegraph");
  const openSpy = spyOn(CodeGraphModule.default, "open").mockRejectedValueOnce(new Error("db locked") as never);

  const result = await openGraphForRun("/repo", true);
  expect(result).toBeNull();

  openSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// closeGraph
// ---------------------------------------------------------------------------

test("closeGraph: no-op when graph is null", () => {
  expect(() => closeGraph(null)).not.toThrow();
});

test("closeGraph: calls graph.close() when graph is not null", () => {
  const graph = makeGraph();
  const closeSpy = spyOn(graph, "close");
  closeGraph(graph);
  expect(closeSpy).toHaveBeenCalledTimes(1);
});

test("closeGraph: does not throw when graph.close() throws", () => {
  const graph = makeGraph({ closeFails: true });
  expect(() => closeGraph(graph)).not.toThrow();
});
