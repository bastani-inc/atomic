/**
 * Unit tests — integrations/intercom/intercom-bridge.ts + result-intercom.ts
 */
import { test, expect, describe } from "bun:test";
import {
  deriveCwdHash,
  buildParentSessionName,
  isIntercomPresent,
  registerIntercomParentSession,
  type PiIntercomExtensionAPI,
} from "../../src/integrations/intercom/intercom-bridge.js";
import { subscribeIntercomControl } from "../../src/integrations/intercom/result-intercom.js";

// ---------------------------------------------------------------------------
// intercom-bridge
// ---------------------------------------------------------------------------

describe("deriveCwdHash", () => {
  test("returns 8-char hex string", () => {
    const h = deriveCwdHash("/home/user/project");
    expect(h).toHaveLength(8);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  test("stable: same input same hash", () => {
    expect(deriveCwdHash("/tmp/foo")).toBe(deriveCwdHash("/tmp/foo"));
  });

  test("different inputs produce different hashes (high probability)", () => {
    expect(deriveCwdHash("/a")).not.toBe(deriveCwdHash("/b"));
  });
});

describe("buildParentSessionName", () => {
  test("returns string starting with pi-workflows-parent-", () => {
    const name = buildParentSessionName("/some/dir");
    expect(name.startsWith("pi-workflows-parent-")).toBe(true);
  });

  test("hash portion is 8 chars", () => {
    const name = buildParentSessionName("/some/dir");
    const hash = name.replace("pi-workflows-parent-", "");
    expect(hash).toHaveLength(8);
  });
});

describe("isIntercomPresent", () => {
  test("returns false when setSessionName absent", () => {
    expect(isIntercomPresent({})).toBe(false);
  });

  test("returns true when setSessionName is a function", () => {
    expect(isIntercomPresent({ setSessionName: () => {} })).toBe(true);
  });

  test("returns false when setSessionName is not a function", () => {
    expect(isIntercomPresent({ setSessionName: "not-a-fn" } as unknown as PiIntercomExtensionAPI)).toBe(false);
  });
});

describe("registerIntercomParentSession", () => {
  test("returns null when intercom absent", () => {
    const result = registerIntercomParentSession({});
    expect(result).toBeNull();
  });

  test("calls setSessionName and returns name when intercom present", () => {
    const calls: string[] = [];
    const pi = { setSessionName: (name: string) => { calls.push(name); } };
    const result = registerIntercomParentSession(pi, "/workspace/myproject");
    expect(result).toMatch(/^pi-workflows-parent-[0-9a-f]{8}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(result!);
  });

  test("uses cwd derived hash (stable for same cwd)", () => {
    const calls: string[] = [];
    const pi = { setSessionName: (name: string) => { calls.push(name); } };
    registerIntercomParentSession(pi, "/fixed/cwd");
    registerIntercomParentSession(pi, "/fixed/cwd");
    expect(calls[0]).toBe(calls[1]);
  });
});

// ---------------------------------------------------------------------------
// result-intercom
// ---------------------------------------------------------------------------

describe("subscribeIntercomControl", () => {
  test("returns null when events.on absent", () => {
    const cleanup = subscribeIntercomControl({}, {});
    expect(cleanup).toBeNull();
  });

  test("returns null when events absent", () => {
    const cleanup = subscribeIntercomControl({ events: {} }, {});
    expect(cleanup).toBeNull();
  });

  test("registers handler on subagent:control-intercom", () => {
    const registrations: { event: string }[] = [];
    const pi = {
      events: {
        on: (event: string, _handler: (payload: unknown) => void) => {
          registrations.push({ event });
        },
      },
    };
    subscribeIntercomControl(pi, {});
    expect(registrations).toHaveLength(1);
    expect(registrations[0].event).toBe("subagent:control-intercom");
  });

  test("routes need_decision to onNeedDecision callback", async () => {
    const received: unknown[] = [];
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    subscribeIntercomControl(pi, {
      onNeedDecision: (p) => { received.push(p); },
    });
    capturedHandler!({ type: "need_decision", message: "approve?" });
    // allow async dispatch
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);
    expect((received[0] as { message: string }).message).toBe("approve?");
  });

  test("routes notify to onNotify callback", async () => {
    const received: unknown[] = [];
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    subscribeIntercomControl(pi, {
      onNotify: (p) => { received.push(p); },
    });
    capturedHandler!({ type: "notify", message: "stage complete" });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);
  });

  test("routes unknown type to onUnknown callback", async () => {
    const received: unknown[] = [];
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    subscribeIntercomControl(pi, {
      onUnknown: (p) => { received.push(p); },
    });
    capturedHandler!({ type: "future_type", message: "hi" });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);
  });

  test("cleanup stops routing", async () => {
    const received: unknown[] = [];
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    const cleanup = subscribeIntercomControl(pi, {
      onNotify: (p) => { received.push(p); },
    });
    cleanup!();
    capturedHandler!({ type: "notify", message: "after cleanup" });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(0);
  });

  test("ignores malformed payload (no crash)", async () => {
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    subscribeIntercomControl(pi, {});
    expect(() => capturedHandler!(null)).not.toThrow();
    expect(() => capturedHandler!("string")).not.toThrow();
    expect(() => capturedHandler!(42)).not.toThrow();
  });
});
