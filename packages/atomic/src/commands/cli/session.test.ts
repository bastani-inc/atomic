import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import {
  renderSessionList,
  filterByAgent,
  filterByScope,
  sessionListCommand,
  sessionConnectCommand,
  sessionPickerCommand,
  sessionKillCommand,
} from "./session.ts";
import type { SessionDeps } from "./session.ts";
import type { TmuxSession } from "./session.ts";

// Force plain-text output so assertions match readable substrings.
let originalNoColor: string | undefined;
beforeAll(() => {
  originalNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
});
afterAll(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

// ─── renderSessionList ─────────────────────────────────────────────────────

describe("renderSessionList", () => {
  test("empty state teaches user how to start a session", () => {
    const output = renderSessionList([]);
    expect(output).toContain("no sessions running");
    expect(output).toContain("atomic chat -a <agent>");
    expect(output).toContain("atomic workflow -n <name> -a <agent>");
  });

  test("renders a single session with name and status", () => {
    const sessions: TmuxSession[] = [
      {
        name: "atomic-chat-claude-abc12345",
        windows: 1,
        created: new Date().toISOString(),
        attached: false,
        type: "chat",
        agent: "claude",
      },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("1 session");
    expect(output).toContain("atomic-chat-claude-abc12345");
    expect(output).toContain("○"); // unattached indicator
  });

  test("renders agent badge when agent field is present", () => {
    const sessions: TmuxSession[] = [
      {
        name: "atomic-chat-claude-abc12345",
        windows: 1,
        created: new Date().toISOString(),
        attached: false,
        type: "chat",
        agent: "claude",
      },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("[claude]");
  });

  test("omits agent badge when agent field is undefined", () => {
    const sessions: TmuxSession[] = [
      {
        name: "atomic-chat-abc12345",
        windows: 1,
        created: new Date().toISOString(),
        attached: false,
      },
    ];
    const output = renderSessionList(sessions);
    expect(output).not.toMatch(/\[.*\]/);
  });

  test("renders attached sessions with the filled indicator", () => {
    const sessions: TmuxSession[] = [
      {
        name: "my-session",
        windows: 2,
        created: new Date().toISOString(),
        attached: true,
      },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("●"); // attached indicator
    expect(output).toContain("attached");
  });

  test("pluralises 'sessions' for multiple entries", () => {
    const sessions: TmuxSession[] = [
      { name: "a", windows: 1, created: new Date().toISOString(), attached: false },
      { name: "b", windows: 1, created: new Date().toISOString(), attached: false },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("2 sessions");
  });

  test("shows relative age for recent sessions", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const sessions: TmuxSession[] = [
      { name: "recent", windows: 1, created: fiveMinAgo, attached: false },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("5m ago");
  });

  test("shows connect hint in footer", () => {
    const sessions: TmuxSession[] = [
      { name: "s", windows: 1, created: new Date().toISOString(), attached: false },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("atomic session connect");
  });
});

// ─── filterByScope ────────────────────────────────────────────────────────

describe("filterByScope", () => {
  const now = new Date().toISOString();
  const sessions: TmuxSession[] = [
    { name: "atomic-chat-claude-aaa11111", windows: 1, created: now, attached: false, type: "chat", agent: "claude" },
    { name: "atomic-chat-copilot-bbb22222", windows: 1, created: now, attached: false, type: "chat", agent: "copilot" },
    { name: "atomic-wf-claude-ralph-ccc33333", windows: 3, created: now, attached: false, type: "workflow", agent: "claude" },
    { name: "atomic-wf-opencode-gen-spec-ddd44444", windows: 2, created: now, attached: false, type: "workflow", agent: "opencode" },
    { name: "unrelated-session", windows: 1, created: now, attached: false }, // no type
  ];

  test("returns all sessions when scope is 'all'", () => {
    expect(filterByScope(sessions, "all")).toEqual(sessions);
  });

  test("filters to chat sessions only", () => {
    const result = filterByScope(sessions, "chat");
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.type === "chat")).toBe(true);
  });

  test("filters to workflow sessions only", () => {
    const result = filterByScope(sessions, "workflow");
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.type === "workflow")).toBe(true);
  });

  test("excludes sessions with no type when scope is chat", () => {
    const result = filterByScope(sessions, "chat");
    expect(result.find((s) => s.name === "unrelated-session")).toBeUndefined();
  });

  test("excludes sessions with no type when scope is workflow", () => {
    const result = filterByScope(sessions, "workflow");
    expect(result.find((s) => s.name === "unrelated-session")).toBeUndefined();
  });
});

// ─── filterByAgent ────────────────────────────────────────────────────────

describe("filterByAgent", () => {
  const now = new Date().toISOString();
  const sessions: TmuxSession[] = [
    { name: "atomic-chat-claude-aaa11111", windows: 1, created: now, attached: false, type: "chat", agent: "claude" },
    { name: "atomic-chat-copilot-bbb22222", windows: 1, created: now, attached: false, type: "chat", agent: "copilot" },
    { name: "atomic-wf-opencode-ralph-ccc33333", windows: 1, created: now, attached: false, type: "workflow", agent: "opencode" },
    { name: "unrelated-session", windows: 1, created: now, attached: false }, // no agent
  ];

  test("returns all sessions when agents array is empty", () => {
    expect(filterByAgent(sessions, [])).toEqual(sessions);
  });

  test("filters to a single agent", () => {
    const result = filterByAgent(sessions, ["claude"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent).toBe("claude");
  });

  test("filters to multiple agents", () => {
    const result = filterByAgent(sessions, ["copilot", "opencode"]);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.agent)).toEqual(["copilot", "opencode"]);
  });

  test("matching is case-insensitive", () => {
    const result = filterByAgent(sessions, ["CLAUDE"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent).toBe("claude");
  });

  test("excludes sessions with no agent field", () => {
    const result = filterByAgent(sessions, ["claude", "copilot", "opencode"]);
    expect(result).toHaveLength(3);
    expect(result.every((s) => s.agent !== undefined)).toBe(true);
  });

  test("returns empty array when no agents match", () => {
    expect(filterByAgent(sessions, ["nonexistent"])).toEqual([]);
  });
});

// ─── renderSessionList — formatAge branches ─────────────────────────────

describe("renderSessionList — formatAge edge cases", () => {
  test("shows hours-ago for sessions older than 60 minutes", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const sessions: TmuxSession[] = [
      { name: "old-session", windows: 1, created: threeHoursAgo, attached: false },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("3h ago");
  });

  test("shows days-ago for sessions older than 24 hours", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const sessions: TmuxSession[] = [
      { name: "ancient-session", windows: 1, created: twoDaysAgo, attached: false },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("2d ago");
  });

  test("shows raw string for unparseable dates", () => {
    const sessions: TmuxSession[] = [
      { name: "bad-date", windows: 1, created: "not-a-date", attached: false },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("not-a-date");
  });

  test("shows 'just now' for future timestamps", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const sessions: TmuxSession[] = [
      { name: "future-session", windows: 1, created: future, attached: false },
    ];
    const output = renderSessionList(sessions);
    expect(output).toContain("just now");
  });
});

// ─── filterByScope + filterByAgent combined ───────────────────────────────

describe("filterByScope + filterByAgent combined", () => {
  const now = new Date().toISOString();
  const sessions: TmuxSession[] = [
    { name: "atomic-chat-claude-aaa11111", windows: 1, created: now, attached: false, type: "chat", agent: "claude" },
    { name: "atomic-chat-copilot-bbb22222", windows: 1, created: now, attached: false, type: "chat", agent: "copilot" },
    { name: "atomic-wf-claude-ralph-ccc33333", windows: 3, created: now, attached: false, type: "workflow", agent: "claude" },
    { name: "atomic-wf-opencode-gen-spec-ddd44444", windows: 2, created: now, attached: false, type: "workflow", agent: "opencode" },
  ];

  test("scope=chat + agent=claude returns only claude chat sessions", () => {
    const result = filterByAgent(filterByScope(sessions, "chat"), ["claude"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("atomic-chat-claude-aaa11111");
  });

  test("scope=workflow + agent=claude returns only claude workflow sessions", () => {
    const result = filterByAgent(filterByScope(sessions, "workflow"), ["claude"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("atomic-wf-claude-ralph-ccc33333");
  });

  test("scope=all + agent=claude returns both chat and workflow claude sessions", () => {
    const result = filterByAgent(filterByScope(sessions, "all"), ["claude"]);
    expect(result).toHaveLength(2);
  });
});

// ─── Command functions (dependency-injected mocks) ──────────────────────────
//
// Instead of mock.module (which leaks across test files in Bun — see
// https://github.com/oven-sh/bun/issues/12823), each command function
// receives its tmux/prompt dependencies via a `SessionDeps` parameter.
// This keeps the mocks scoped to these tests without polluting the
// module registry for other test files that import from tmux.ts.

const tmuxMocks = {
  isTmuxInstalled: mock<() => boolean>(() => true),
  sessionExists: mock<(name: string) => boolean>(() => true),
  listSessions: mock<() => TmuxSession[]>(() => []),
  isInsideAtomicSocket: mock<() => boolean>(() => false),
  isInsideTmux: mock<() => boolean>(() => false),
  switchClient: mock<(name: string) => void>(() => {}),
  detachAndAttachAtomic: mock<(name: string) => void>(() => {}),
  spawnMuxAttach: mock(() => ({ exited: Promise.resolve(0) }) as never),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select: mock<(...args: any[]) => Promise<string | symbol>>(() => Promise.resolve("my-session")),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  multiselect: mock<(...args: any[]) => Promise<string[] | symbol>>(() => Promise.resolve([])),
  killSession: mock<(name: string) => void>(() => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  confirm: mock<(...args: any[]) => Promise<boolean | symbol>>(() => Promise.resolve(true)),
  isCancel: ((v: unknown) => typeof v === "symbol") as SessionDeps["isCancel"],
};

/** Build a deps object from the current mock state. */
function makeDeps(): SessionDeps {
  return tmuxMocks as unknown as SessionDeps;
}

function resetTmuxMocks(): void {
  tmuxMocks.isTmuxInstalled.mockReset().mockReturnValue(true);
  tmuxMocks.sessionExists.mockReset().mockReturnValue(true);
  tmuxMocks.listSessions.mockReset().mockReturnValue([]);
  tmuxMocks.isInsideAtomicSocket.mockReset().mockReturnValue(false);
  tmuxMocks.isInsideTmux.mockReset().mockReturnValue(false);
  tmuxMocks.switchClient.mockReset();
  tmuxMocks.detachAndAttachAtomic.mockReset();
  tmuxMocks.spawnMuxAttach.mockReset().mockReturnValue({ exited: Promise.resolve(0) } as never);
  tmuxMocks.select.mockReset().mockResolvedValue("my-session");
  tmuxMocks.multiselect.mockReset().mockResolvedValue([]);
  tmuxMocks.killSession.mockReset();
  tmuxMocks.confirm.mockReset().mockResolvedValue(true);
}

// ─── sessionListCommand ─────────────────────────────────────────────────

describe("sessionListCommand", () => {
  beforeEach(resetTmuxMocks);

  test("returns 0 and prints 'no sessions' when tmux is not installed", async () => {
    tmuxMocks.isTmuxInstalled.mockReturnValue(false);
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stdout.write;
    try {
      const code = await sessionListCommand([], "all", makeDeps());
      expect(code).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("no sessions running");
      expect(output).toContain("tmux is not installed");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("returns 0 and prints session list when tmux is installed", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "atomic-chat-claude-aaa11111", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
    ]);
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stdout.write;
    try {
      const code = await sessionListCommand([], "all", makeDeps());
      expect(code).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("1 session");
      expect(output).toContain("atomic-chat-claude-aaa11111");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("filters by scope and agent", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "chat-1", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
      { name: "wf-1", windows: 1, created: now, attached: false, type: "workflow" as const, agent: "opencode" },
    ]);
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stdout.write;
    try {
      const code = await sessionListCommand(["claude"], "chat", makeDeps());
      expect(code).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("chat-1");
      expect(output).not.toContain("wf-1");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

// ─── sessionConnectCommand ──────────────────────────────────────────────

describe("sessionConnectCommand", () => {
  beforeEach(resetTmuxMocks);

  test("returns 1 when tmux is not installed", async () => {
    tmuxMocks.isTmuxInstalled.mockReturnValue(false);
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await sessionConnectCommand("my-session", makeDeps());
      expect(code).toBe(1);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("returns 1 when session does not exist", async () => {
    tmuxMocks.sessionExists.mockReturnValue(false);
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await sessionConnectCommand("missing", makeDeps());
      expect(code).toBe(1);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("lists available sessions when target not found", async () => {
    tmuxMocks.sessionExists.mockReturnValue(false);
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "existing", windows: 1, created: now, attached: false },
    ]);
    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stderr.write;
    try {
      await sessionConnectCommand("missing", makeDeps());
      const output = chunks.join("");
      expect(output).toContain("existing");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("uses switch-client when inside atomic socket", async () => {
    tmuxMocks.isInsideAtomicSocket.mockReturnValue(true);
    const code = await sessionConnectCommand("my-session", makeDeps());
    expect(code).toBe(0);
    expect(tmuxMocks.switchClient).toHaveBeenCalledWith("my-session");
  });

  test("uses detach-and-attach when inside non-atomic tmux", async () => {
    tmuxMocks.isInsideTmux.mockReturnValue(true);
    const code = await sessionConnectCommand("my-session", makeDeps());
    expect(code).toBe(0);
    expect(tmuxMocks.detachAndAttachAtomic).toHaveBeenCalledWith("my-session");
  });

  test("spawns attach when outside tmux", async () => {
    const code = await sessionConnectCommand("my-session", makeDeps());
    expect(code).toBe(0);
    expect(tmuxMocks.spawnMuxAttach).toHaveBeenCalledWith("my-session");
  });
});

// ─── sessionPickerCommand ──────────────────────────────────────────────

describe("sessionPickerCommand", () => {
  beforeEach(resetTmuxMocks);

  test("returns 1 when tmux is not installed", async () => {
    tmuxMocks.isTmuxInstalled.mockReturnValue(false);
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await sessionPickerCommand([], "all", makeDeps());
      expect(code).toBe(1);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("prints empty state and returns 0 when no sessions exist", async () => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stdout.write;
    try {
      const code = await sessionPickerCommand([], "all", makeDeps());
      expect(code).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("no sessions running");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("shows picker and connects to selected session", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "my-session", windows: 1, created: now, attached: false },
    ]);
    tmuxMocks.select.mockResolvedValue("my-session");
    const code = await sessionPickerCommand([], "all", makeDeps());
    expect(code).toBe(0);
    expect(tmuxMocks.spawnMuxAttach).toHaveBeenCalledWith("my-session");
  });

  test("returns 0 when user cancels picker", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "a-session", windows: 1, created: now, attached: false },
    ]);
    tmuxMocks.select.mockResolvedValue(Symbol("cancel"));
    const code = await sessionPickerCommand([], "all", makeDeps());
    expect(code).toBe(0);
    expect(tmuxMocks.spawnMuxAttach).not.toHaveBeenCalled();
  });
});

// ─── sessionKillCommand ──────────────────────────────────────────────────

describe("sessionKillCommand", () => {
  beforeEach(resetTmuxMocks);

  // (a) tmux not installed → stdout "no sessions running" + "tmux is not installed", return 0
  test("returns 0 with 'no sessions' when tmux is not installed", async () => {
    tmuxMocks.isTmuxInstalled.mockReturnValue(false);
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps());
      expect(code).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("no sessions running");
      expect(output).toContain("tmux is not installed");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (b) named id, session not in scope → stderr error, return 1
  test("returns 1 with error when named session does not exist", async () => {
    // listSessions returns empty, so the target won't be found
    tmuxMocks.listSessions.mockReturnValue([]);
    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stderr.write;
    try {
      const code = await sessionKillCommand("ghost-session", [], "all", makeDeps());
      expect(code).toBe(1);
      const output = chunks.join("");
      expect(output).toContain("ghost-session");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  // (c) named id, session exists but is out of scope → return 1
  test("returns 1 when named session exists but is out of scope", async () => {
    const now = new Date().toISOString();
    // listSessions has a chat session, but we request scope=workflow
    tmuxMocks.listSessions.mockReturnValue([
      { name: "atomic-chat-claude-aaa11111", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
    ]);
    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stderr.write;
    try {
      const code = await sessionKillCommand("atomic-chat-claude-aaa11111", [], "workflow", makeDeps());
      expect(code).toBe(1);
      const output = chunks.join("");
      expect(output).toContain("atomic-chat-claude-aaa11111");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  // (d) named id found, user confirms → killSession called, return 0
  test("prompts and calls killSession on confirm for named session", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "target-session", windows: 1, created: now, attached: false, type: "chat" as const },
    ]);
    tmuxMocks.confirm.mockResolvedValue(true);
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand("target-session", [], "all", makeDeps());
      expect(code).toBe(0);
      expect(tmuxMocks.killSession).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.killSession).toHaveBeenCalledWith("target-session");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (e) named id found, user declines → killSession NOT called, return 0
  test("does NOT call killSession when user declines named kill", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "target-session", windows: 1, created: now, attached: false, type: "chat" as const },
    ]);
    tmuxMocks.confirm.mockResolvedValue(false);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand("target-session", [], "all", makeDeps());
      expect(code).toBe(0);
      expect(tmuxMocks.killSession).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (f) named id found, user cancels (symbol) → killSession NOT called, return 0
  test("does NOT call killSession when user cancels named kill", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "target-session", windows: 1, created: now, attached: false, type: "chat" as const },
    ]);
    tmuxMocks.confirm.mockResolvedValue(Symbol("cancel"));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand("target-session", [], "all", makeDeps());
      expect(code).toBe(0);
      expect(tmuxMocks.killSession).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (g) omitted id, no sessions → empty state on stdout, return 0, confirm NOT called
  test("omitted id with no sessions prints empty state and returns 0 without prompt", async () => {
    tmuxMocks.listSessions.mockReturnValue([]);
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps());
      expect(code).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("no sessions running");
      expect(tmuxMocks.confirm).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (h) omitted id, N sessions, user selects sessions and confirms → killSession called for selected, return 0
  test("omitted id prompts with multiselect and kills selected sessions on confirm", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-a", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
      { name: "session-b", windows: 1, created: now, attached: false, type: "workflow" as const, agent: "opencode" },
      { name: "session-c", windows: 1, created: now, attached: false, type: "chat" as const, agent: "copilot" },
    ]);
    tmuxMocks.multiselect.mockResolvedValue(["session-a", "session-c"]);
    tmuxMocks.confirm.mockResolvedValue(true);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps());
      expect(code).toBe(0);
      expect(tmuxMocks.multiselect).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.multiselect).toHaveBeenCalledWith(expect.objectContaining({
        message: "Select sessions to kill (Space toggles, Enter continues)",
      }));
      expect(tmuxMocks.killSession).toHaveBeenCalledTimes(2);
      expect(tmuxMocks.killSession).toHaveBeenCalledWith("session-a");
      expect(tmuxMocks.killSession).toHaveBeenCalledWith("session-c");
      expect(tmuxMocks.killSession).not.toHaveBeenCalledWith("session-b");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (i) scope=chat, only chat sessions killed when id omitted
  test("scope=chat only kills chat sessions when id omitted", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "chat-session", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
      { name: "wf-session", windows: 1, created: now, attached: false, type: "workflow" as const, agent: "opencode" },
    ]);
    tmuxMocks.multiselect.mockResolvedValue(["chat-session"]);
    tmuxMocks.confirm.mockResolvedValue(true);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "chat", makeDeps());
      expect(code).toBe(0);
      expect(tmuxMocks.killSession).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.killSession).toHaveBeenCalledWith("chat-session");
      expect(tmuxMocks.killSession).not.toHaveBeenCalledWith("wf-session");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (j) scope=workflow, only workflow sessions killed when id omitted
  test("scope=workflow only kills workflow sessions when id omitted", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "chat-session", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
      { name: "wf-session", windows: 1, created: now, attached: false, type: "workflow" as const, agent: "opencode" },
    ]);
    tmuxMocks.multiselect.mockResolvedValue(["wf-session"]);
    tmuxMocks.confirm.mockResolvedValue(true);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "workflow", makeDeps());
      expect(code).toBe(0);
      expect(tmuxMocks.killSession).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.killSession).toHaveBeenCalledWith("wf-session");
      expect(tmuxMocks.killSession).not.toHaveBeenCalledWith("chat-session");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (k) user declines kill-all → killSession NOT called
  test("does NOT kill any sessions when user declines kill-all", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-x", windows: 1, created: now, attached: false, type: "chat" as const },
      { name: "session-y", windows: 1, created: now, attached: false, type: "workflow" as const },
    ]);
    tmuxMocks.multiselect.mockResolvedValue(["session-x", "session-y"]);
    tmuxMocks.confirm.mockResolvedValue(false);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps());
      expect(code).toBe(0);
      expect(tmuxMocks.killSession).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (l) -y on named kill: skip prompt and kill immediately
  test("yes flag skips the prompt for a named kill and calls killSession", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "target-session", windows: 1, created: now, attached: false, type: "chat" as const },
    ]);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(
        "target-session",
        [],
        "all",
        makeDeps(),
        { yes: true },
      );
      expect(code).toBe(0);
      expect(tmuxMocks.confirm).not.toHaveBeenCalled();
      expect(tmuxMocks.killSession).toHaveBeenCalledWith("target-session");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // (m) -y on omitted id: skip confirm after selection and kill selected sessions
  test("yes flag skips the confirmation prompt after selecting sessions", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-a", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
      { name: "session-b", windows: 1, created: now, attached: false, type: "workflow" as const, agent: "opencode" },
    ]);
    tmuxMocks.multiselect.mockResolvedValue(["session-b"]);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps(), { yes: true });
      expect(code).toBe(0);
      expect(tmuxMocks.confirm).not.toHaveBeenCalled();
      expect(tmuxMocks.killSession).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.killSession).toHaveBeenCalledWith("session-b");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("selecting the all option kills every matching session after confirmation", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-a", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
      { name: "session-b", windows: 1, created: now, attached: false, type: "workflow" as const, agent: "opencode" },
    ]);
    tmuxMocks.multiselect.mockResolvedValue(["__atomic_select_all_sessions__"]);
    tmuxMocks.confirm.mockResolvedValue(true);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps());
      expect(code).toBe(0);
      expect(tmuxMocks.killSession).toHaveBeenCalledTimes(2);
      expect(tmuxMocks.killSession).toHaveBeenCalledWith("session-a");
      expect(tmuxMocks.killSession).toHaveBeenCalledWith("session-b");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("all flag skips multiselect and confirms every matching session", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-a", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
      { name: "session-b", windows: 1, created: now, attached: false, type: "workflow" as const, agent: "opencode" },
    ]);
    tmuxMocks.confirm.mockResolvedValue(true);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps(), { all: true });
      expect(code).toBe(0);
      expect(tmuxMocks.multiselect).not.toHaveBeenCalled();
      expect(tmuxMocks.confirm).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.killSession).toHaveBeenCalledTimes(2);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("all and yes flags kill every matching session without prompts", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-a", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
      { name: "session-b", windows: 1, created: now, attached: false, type: "workflow" as const, agent: "opencode" },
    ]);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps(), { all: true, yes: true });
      expect(code).toBe(0);
      expect(tmuxMocks.multiselect).not.toHaveBeenCalled();
      expect(tmuxMocks.confirm).not.toHaveBeenCalled();
      expect(tmuxMocks.killSession).toHaveBeenCalledTimes(2);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // ── Lines 312-320: named session not found but other sessions available ──────

  test("shows available sessions in scope when named session is not found", async () => {
    const now = new Date().toISOString();
    // inScope has sessions but the requested name isn't among them
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-alpha", windows: 1, created: now, attached: false, type: "chat" as const, agent: "claude" },
      { name: "session-beta", windows: 1, created: now, attached: false, type: "chat" as const, agent: "copilot" },
    ]);
    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stderr.write;
    try {
      const code = await sessionKillCommand("ghost-session", [], "all", makeDeps());
      expect(code).toBe(1);
      const output = chunks.join("");
      // Lines 312-320: available sessions list shown
      expect(output).toContain("Available sessions:");
      expect(output).toContain("session-alpha");
      expect(output).toContain("session-beta");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  // ── Lines 365-366: multiselect returns Symbol (cancel) ─────────────────────

  test("returns 0 when user cancels multiselect (Symbol returned)", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-x", windows: 1, created: now, attached: false, type: "chat" as const },
    ]);
    // Return a Symbol so isCancel() returns true
    tmuxMocks.multiselect.mockResolvedValue(Symbol("cancel") as unknown as string[]);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps());
      expect(code).toBe(0);
      expect(tmuxMocks.killSession).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // ── Lines 370-373: no sessions selected after multiselect ──────────────────

  test("returns 0 with 'No sessions selected' when multiselect returns empty array", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-x", windows: 1, created: now, attached: false, type: "chat" as const },
    ]);
    // Return empty array (no sessions selected)
    tmuxMocks.multiselect.mockResolvedValue([]);
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((c: string) => { chunks.push(c); return true; }) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps());
      expect(code).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("No sessions selected.");
      expect(tmuxMocks.killSession).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = origWrite;
    }
  });

  // ── Lines 387-388: isCancel(answer) after selection in multi-kill ──────────

  test("returns 0 when user cancels confirmation after selecting sessions (Symbol)", async () => {
    const now = new Date().toISOString();
    tmuxMocks.listSessions.mockReturnValue([
      { name: "session-x", windows: 1, created: now, attached: false, type: "chat" as const },
      { name: "session-y", windows: 1, created: now, attached: false, type: "workflow" as const },
    ]);
    // Multiselect returns names (not cancel)
    tmuxMocks.multiselect.mockResolvedValue(["session-x", "session-y"]);
    // Confirm returns Symbol (cancel)
    tmuxMocks.confirm.mockResolvedValue(Symbol("cancel") as unknown as boolean);
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await sessionKillCommand(undefined, [], "all", makeDeps());
      expect(code).toBe(0);
      // Lines 387-388: isCancel(answer) → cancel, killSession not called
      expect(tmuxMocks.killSession).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
