import { test, expect } from "bun:test";
import type { CodeGraph, Edge, Node, Subgraph } from "@colbymchenry/codegraph";
import {
  extractSymbolIds,
  renderExplorerMarkdown,
  type ExplorerSections,
} from "./scratch.ts";

// ---------------------------------------------------------------------------
// extractSymbolIds
// ---------------------------------------------------------------------------

test("extractSymbolIds: returns empty array for text with no symbols", () => {
  expect(extractSymbolIds("no symbols here")).toEqual([]);
});

test("extractSymbolIds: extracts single symbol id", () => {
  expect(extractSymbolIds("see [symbol:abc123]")).toEqual(["abc123"]);
});

test("extractSymbolIds: extracts multiple distinct symbol ids", () => {
  const ids = extractSymbolIds(
    "[symbol:aaa] and [symbol:bbb] and [symbol:aaa]",
  );
  expect(ids).toContain("aaa");
  expect(ids).toContain("bbb");
  expect(ids).toHaveLength(2);
});

test("extractSymbolIds: handles dashes and underscores in ids", () => {
  const ids = extractSymbolIds("[symbol:my-symbol_v2]");
  expect(ids).toEqual(["my-symbol_v2"]);
});

test("extractSymbolIds accepts qualified ids", () => {
  expect(extractSymbolIds("see [symbol:src/a.ts::handler]")).toEqual([
    "src/a.ts::handler",
  ]);
});

test("extractSymbolIds dedupes mixed plain + qualified", () => {
  const ids = extractSymbolIds("[symbol:foo] [symbol:src/x.ts::foo]");
  expect(ids).toEqual(["foo", "src/x.ts::foo"]);
});

// ---------------------------------------------------------------------------
// Mock graph helpers
// ---------------------------------------------------------------------------

const fakeNode = (id: string): Node =>
  ({
    id,
    kind: "function",
    name: id,
    qualifiedName: `src/a.ts::${id}`,
    filePath: "src/a.ts",
    language: "typescript",
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  }) as Node;

const fakeEdge = (source: string, target: string, line?: number): Edge =>
  ({
    source,
    target,
    kind: "calls",
    line,
  }) as Edge;

const fakeSubgraph = (nodeIds: string[]): Subgraph => {
  const nodes = new Map<string, Node>();
  for (const id of nodeIds) nodes.set(id, fakeNode(id));
  return { nodes, edges: [], roots: nodeIds };
};

type MockGraph = CodeGraph & { openCount: number; closeCount: number };

/**
 * Mock graph that records open/close call counts for invariant testing.
 * Implements the subset of CodeGraph used by buildDeterministicGraphSections.
 */
function makeMockGraph(opts?: {
  callers?: Array<{ node: Node; edge: Edge }>;
  impactNodeIds?: string[];
}): MockGraph {
  const callers = opts?.callers ?? [
    { node: fakeNode("callerFn"), edge: fakeEdge("callerFn", "sym1", 42) },
  ];
  const impactNodeIds = opts?.impactNodeIds ?? ["impactedFn"];

  let openCount = 0;
  let closeCount = 0;

  // open/close should never be called by buildDeterministicGraphSections.
  const graph = {
    getCallers: () => callers,
    getImpactRadius: () => fakeSubgraph(impactNodeIds),
    open: () => {
      openCount++;
      return Promise.resolve(graph as unknown as CodeGraph);
    },
    close: () => {
      closeCount++;
      return Promise.resolve();
    },
    get openCount() {
      return openCount;
    },
    get closeCount() {
      return closeCount;
    },
  } as unknown as MockGraph;

  return graph;
}

type TextOverrides = {
  analyzerOutput?: string;
  onlineOutput?: string;
  locatorOutput?: string;
  patternsOutput?: string;
};

type SectionOverrides = TextOverrides &
  (
    | { codegraphHealthy: true; graph: CodeGraph }
    | { codegraphHealthy?: false }
  );

function makeMinimalSections(
  overrides: SectionOverrides = {},
): ExplorerSections {
  const base = {
    index: 1,
    total: 3,
    partition: [{ path: "src/foo", fileCount: 5, loc: 1000, files: [] }],
    locatorOutput: overrides.locatorOutput ?? "locator text",
    patternsOutput: overrides.patternsOutput ?? "patterns text",
    analyzerOutput: overrides.analyzerOutput ?? "analyzer text",
    onlineOutput: overrides.onlineOutput ?? "(no external research applicable)",
  };
  if (overrides.codegraphHealthy) {
    return { ...base, codegraphHealthy: true, graph: overrides.graph };
  }
  return { ...base, codegraphHealthy: false };
}

test("renderExplorerMarkdown: base sections present without codegraph", () => {
  const md = renderExplorerMarkdown(makeMinimalSections());
  expect(md).toContain("## Scope");
  expect(md).toContain("## Files in Scope");
  expect(md).toContain("## How It Works");
  expect(md).toContain("## Patterns");
  expect(md).toContain("## Out-of-Partition References");
  // No Callers/Impact when unhealthy
  expect(md).not.toContain("## Callers");
  expect(md).not.toContain("## Impact");
});

test("renderExplorerMarkdown: external references omitted on skip sentinel", () => {
  const md = renderExplorerMarkdown(makeMinimalSections());
  expect(md).not.toContain("## External References");
});

test("renderExplorerMarkdown: external references included when non-empty non-sentinel", () => {
  const md = renderExplorerMarkdown(
    makeMinimalSections({ onlineOutput: "https://example.com" }),
  );
  expect(md).toContain("## External References");
});

// ---------------------------------------------------------------------------
// renderExplorerMarkdown — §5.6 healthy branch
// ---------------------------------------------------------------------------

test("renderExplorerMarkdown: Callers and Impact sections present when healthy and symbols found", () => {
  const md = renderExplorerMarkdown(
    makeMinimalSections({
      codegraphHealthy: true,
      graph: makeMockGraph(),
      analyzerOutput: "See [symbol:sym1] for details",
    }),
  );

  expect(md).toContain("## Callers");
  expect(md).toContain("## Impact");
  // Deterministic content from fake graph
  expect(md).toContain("callerFn");
  expect(md).toContain("impactedFn");
});

test("renderExplorerMarkdown: Callers and Impact absent when healthy but no symbol refs", () => {
  const md = renderExplorerMarkdown(
    makeMinimalSections({
      codegraphHealthy: true,
      graph: makeMockGraph(),
      // no [symbol:...] tokens in any output
    }),
  );

  // No symbols → buildDeterministicGraphSections returns null → no sections
  expect(md).not.toContain("## Callers");
  expect(md).not.toContain("## Impact");
});

test("renderExplorerMarkdown: Callers and Impact absent when codegraphHealthy is false", () => {
  const md = renderExplorerMarkdown(
    makeMinimalSections({
      codegraphHealthy: false,
      analyzerOutput: "See [symbol:sym1] for details",
    }),
  );

  expect(md).not.toContain("## Callers");
  expect(md).not.toContain("## Impact");
});

// ---------------------------------------------------------------------------
// §8.3 open/close invariant — orchestrator owns the lifecycle
// ---------------------------------------------------------------------------

test("buildDeterministicGraphSections does not open or close the graph", () => {
  const mock = makeMockGraph();
  // Pass symbols via analyzerOutput so the graph query path is exercised.
  renderExplorerMarkdown(
    makeMinimalSections({
      codegraphHealthy: true,
      graph: mock,
      analyzerOutput: "See [symbol:sym1] and [symbol:sym2] for details",
    }),
  );
  expect(mock.openCount).toBe(0);
  expect(mock.closeCount).toBe(0);
});

// The discriminated union requires `graph` whenever `codegraphHealthy` is
// true, so the previous "healthy but no projectRoot" runtime case is now
// a compile-time error and needs no test.
