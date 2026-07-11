import { describe, it, expect } from "bun:test";
import { ServerEntry } from "./types.ts";

describe("ServerEntry timeoutMs", () => {
  it("should accept timeoutMs as an optional number", () => {
    const entry: ServerEntry = {
      url: "https://example.com/mcp",
      timeoutMs: 60000,
    };
    expect(entry.timeoutMs).toBe(60000);
  });

  it("should allow entries without timeoutMs", () => {
    const entry: ServerEntry = {
      command: "npx",
      args: ["-y", "@some/mcp-server"],
    };
    expect(entry.timeoutMs).toBeUndefined();
  });

  it("should support the config shape from the issue", () => {
    const config = {
      mcpServers: {
        github: {
          type: "http" as const,
          url: "https://api.githubcopilot.com/mcp",
          timeoutMs: 60000,
        },
      },
    };
    const entry = config.mcpServers.github as ServerEntry;
    expect(entry.timeoutMs).toBe(60000);
    expect(entry.url).toBe("https://api.githubcopilot.com/mcp");
  });
});
