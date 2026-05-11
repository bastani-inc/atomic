/**
 * Unit tests — integrations/mcp.ts
 */
import { test, expect, describe } from "bun:test";
import {
  setMcpScope,
  clearMcpScope,
  isMcpScopeSupported,
} from "../../src/integrations/mcp.js";

describe("setMcpScope", () => {
  test("emits mcp.scope.set with allow and deny", () => {
    const emitted: { event: string; payload: Record<string, unknown> }[] = [];
    const pi = {
      events: {
        emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); },
      },
    };
    setMcpScope(pi, { stageId: "s1", allow: ["github", "fetch"], deny: ["filesystem"] });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("mcp.scope.set");
    const p = emitted[0].payload as { stageId: string; allow: string[]; deny: string[] };
    expect(p.stageId).toBe("s1");
    expect(p.allow).toEqual(["github", "fetch"]);
    expect(p.deny).toEqual(["filesystem"]);
  });

  test("emits null allow/deny when not specified", () => {
    const emitted: { event: string; payload: Record<string, unknown> }[] = [];
    const pi = {
      events: {
        emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); },
      },
    };
    setMcpScope(pi, { stageId: "s2" });
    const p = emitted[0].payload as { allow: null; deny: null };
    expect(p.allow).toBeNull();
    expect(p.deny).toBeNull();
  });

  test("no-op when pi.events absent", () => {
    expect(() => setMcpScope({}, { stageId: "s1" })).not.toThrow();
  });
});

describe("clearMcpScope", () => {
  test("emits mcp.scope.set with null allow and deny", () => {
    const emitted: { event: string; payload: Record<string, unknown> }[] = [];
    const pi = {
      events: {
        emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); },
      },
    };
    clearMcpScope(pi, "stage-x");
    expect(emitted[0].event).toBe("mcp.scope.set");
    const p = emitted[0].payload as { stageId: string; allow: null; deny: null };
    expect(p.stageId).toBe("stage-x");
    expect(p.allow).toBeNull();
    expect(p.deny).toBeNull();
  });

  test("no-op when pi.events absent", () => {
    expect(() => clearMcpScope({}, "s1")).not.toThrow();
  });
});

describe("isMcpScopeSupported", () => {
  test("returns true when events present", () => {
    expect(isMcpScopeSupported({ events: { emit: () => {} } })).toBe(true);
  });

  test("returns false when events absent", () => {
    expect(isMcpScopeSupported({})).toBe(false);
  });
});
