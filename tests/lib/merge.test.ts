import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeJsonFile, syncJsonFile } from "../../packages/atomic/src/lib/merge.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "atomic-merge-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeJson(path: string, data: unknown): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T;
}

describe("mergeJsonFile excludeKeys", () => {
  test("strips excluded keys from source before merging", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "dest.json");
    await writeJson(src, {
      env: { A: "1" },
      disabledMcpjsonServers: ["azure-devops"],
    });
    await writeJson(dest, { existing: true });

    await mergeJsonFile(src, dest, ["disabledMcpjsonServers"]);

    const result = await readJson<Record<string, unknown>>(dest);
    expect(result.existing).toBe(true);
    expect(result.env).toEqual({ A: "1" });
    expect("disabledMcpjsonServers" in result).toBe(false);
  });

  test("preserves destination's value for excluded keys", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "dest.json");
    await writeJson(src, { disabledMcpjsonServers: ["azure-devops"] });
    await writeJson(dest, { disabledMcpjsonServers: ["user-choice"] });

    await mergeJsonFile(src, dest, ["disabledMcpjsonServers"]);

    const result = await readJson<Record<string, unknown>>(dest);
    expect(result.disabledMcpjsonServers).toEqual(["user-choice"]);
  });
});

describe("syncJsonFile excludeKeys", () => {
  test("strips excluded keys when destination does not exist", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "nested", "dest.json");
    await writeJson(src, {
      env: { A: "1" },
      disabledMcpjsonServers: ["azure-devops"],
    });

    await syncJsonFile(src, dest, true, ["disabledMcpjsonServers"]);

    const result = await readJson<Record<string, unknown>>(dest);
    expect(result.env).toEqual({ A: "1" });
    expect("disabledMcpjsonServers" in result).toBe(false);
  });

  test("copies source as-is when excludeKeys is empty", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "dest.json");
    await writeJson(src, { disabledMcpjsonServers: ["azure-devops"] });

    await syncJsonFile(src, dest, true, []);

    const result = await readJson<Record<string, unknown>>(dest);
    expect(result.disabledMcpjsonServers).toEqual(["azure-devops"]);
  });
});

describe("mergeJsonFile user precedence", () => {
  test("destination value wins on conflicting top-level scalar", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "dest.json");
    await writeJson(src, { permission: "deny" });
    await writeJson(dest, { permission: "allow" });

    await mergeJsonFile(src, dest);

    const result = await readJson<Record<string, unknown>>(dest);
    expect(result.permission).toBe("allow");
  });

  test("adds missing top-level keys from source", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "dest.json");
    await writeJson(src, { addedKey: 1, sharedKey: "src" });
    await writeJson(dest, { sharedKey: "dst", existing: true });

    await mergeJsonFile(src, dest);

    const result = await readJson<Record<string, unknown>>(dest);
    expect(result.addedKey).toBe(1);
    expect(result.sharedKey).toBe("dst");
    expect(result.existing).toBe(true);
  });

  test("deep-merges nested objects with destination winning on conflict", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "dest.json");
    await writeJson(src, {
      mcpServers: {
        "github-mcp-server": {
          type: "http",
          url: "https://api.githubcopilot.com/mcp",
          headers: { Authorization: "Bearer ${GH_TOKEN}" },
        },
      },
    });
    await writeJson(dest, {
      mcpServers: {
        "github-mcp-server": {
          headers: { Authorization: "Bearer user-token" },
        },
        "user-server": { command: "x" },
      },
    });

    await mergeJsonFile(src, dest);

    const result = await readJson<{
      mcpServers: Record<string, Record<string, unknown>>;
    }>(dest);
    const gh = result.mcpServers["github-mcp-server"];
    expect(gh?.type).toBe("http");
    expect(gh?.url).toBe("https://api.githubcopilot.com/mcp");
    expect(gh?.headers).toEqual({ Authorization: "Bearer user-token" });
    expect(result.mcpServers["user-server"]).toEqual({ command: "x" });
  });

  test("treats arrays as atomic — destination array wins outright", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "dest.json");
    await writeJson(src, { servers: ["a", "b"] });
    await writeJson(dest, { servers: ["user-only"] });

    await mergeJsonFile(src, dest);

    const result = await readJson<Record<string, unknown>>(dest);
    expect(result.servers).toEqual(["user-only"]);
  });
});

describe("mergeJsonFile overwriteKeys", () => {
  test("source replaces destination for keys flagged as overwrite", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "dest.json");
    await writeJson(src, {
      atomicOwned: { canonical: true },
      userOwned: { keep: "user" },
    });
    await writeJson(dest, {
      atomicOwned: { canonical: false, leftover: 1 },
      userOwned: { keep: "user-edit" },
    });

    await mergeJsonFile(src, dest, [], ["atomicOwned"]);

    const result = await readJson<Record<string, Record<string, unknown>>>(
      dest,
    );
    expect(result.atomicOwned).toEqual({ canonical: true });
    expect(result.userOwned?.keep).toBe("user-edit");
  });
});

describe("syncJsonFile overwriteKeys", () => {
  test("forwards overwriteKeys to merge when destination exists", async () => {
    const src = join(tmp, "src.json");
    const dest = join(tmp, "dest.json");
    await writeJson(src, { atomicOwned: ["a"], userOwned: ["src"] });
    await writeJson(dest, { atomicOwned: ["dst"], userOwned: ["dst"] });

    await syncJsonFile(src, dest, true, [], ["atomicOwned"]);

    const result = await readJson<Record<string, unknown>>(dest);
    expect(result.atomicOwned).toEqual(["a"]);
    expect(result.userOwned).toEqual(["dst"]);
  });
});
