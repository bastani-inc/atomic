import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version.ts";
import { getEmbeddedAsset, BUNDLES } from "./embedded-assets.ts";

let cacheDir: string;
let originalXdg: string | undefined;
let originalLocalAppData: string | undefined;
// `cacheRoot()` in `embedded-assets.ts` reads LOCALAPPDATA on Windows and
// XDG_CACHE_HOME on Linux/macOS — set both so the test's tmp dir is picked
// up regardless of host OS, and the cache subdir is `cacheDir/atomic[/Cache]/...`.
const CACHE_PREFIX_SEGMENTS = process.platform === "win32"
  ? ["atomic", "Cache"]
  : ["atomic"];

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "atomic-embedded-"));
  originalXdg = process.env.XDG_CACHE_HOME;
  originalLocalAppData = process.env.LOCALAPPDATA;
  process.env.XDG_CACHE_HOME = cacheDir;
  process.env.LOCALAPPDATA = cacheDir;
});

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdg;
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  await rm(cacheDir, { recursive: true, force: true });
});

test("getEmbeddedAsset throws actionable error when bundle path is empty", async () => {
  const original = BUNDLES["claude"] as string;
  BUNDLES["claude"] = "";
  try {
    await expect(getEmbeddedAsset("claude")).rejects.toThrow(
      /embedded-assets: bundle 'claude' missing\. Run 'bun packages\/atomic\/script\/build-assets\.ts'/,
    );
  } finally {
    BUNDLES["claude"] = original;
  }
});

test("tar failure does not write marker", async () => {
  const spy = spyOn(Bun, "spawn");
  spy.mockImplementation((() => {
    const stderr = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("fake tar error"));
        controller.close();
      },
    });
    return { exited: Promise.resolve(2), stderr } as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn);

  await expect(getEmbeddedAsset("claude")).rejects.toThrow(/tar failed for claude/);

  const marker = join(cacheDir, ...CACHE_PREFIX_SEGMENTS, VERSION, "claude", ".extracted");
  expect(existsSync(marker)).toBe(false);

  spy.mockRestore();
});

test("VERSION drives cache subdir, not 'dev'", async () => {
  const spy = spyOn(Bun, "spawn");
  spy.mockImplementation((() => ({
    exited: Promise.resolve(0),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
  })) as unknown as typeof Bun.spawn);

  const result = await getEmbeddedAsset("claude");

  expect(result).toBe(join(cacheDir, ...CACHE_PREFIX_SEGMENTS, VERSION, "claude"));
  expect(result).not.toMatch(/[\\/]dev[\\/]/);

  spy.mockRestore();
});

test("getEmbeddedAsset refreshes cache when the bundle fingerprint changes", async () => {
  const finalDir = join(cacheDir, ...CACHE_PREFIX_SEGMENTS, VERSION, "claude");
  const marker = join(finalDir, ".extracted");
  await mkdir(finalDir, { recursive: true });
  await writeFile(marker, VERSION);

  let tarCalls = 0;
  const spy = spyOn(Bun, "spawn");
  spy.mockImplementation((() => {
    tarCalls += 1;
    return {
      exited: Promise.resolve(0),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
    };
  }) as unknown as typeof Bun.spawn);

  const first = await getEmbeddedAsset("claude");
  expect(first).toBe(finalDir);
  expect(tarCalls).toBe(1);

  const updatedMarker = await readFile(marker, "utf8");
  expect(updatedMarker.startsWith(`${VERSION}\n`)).toBe(true);
  expect(updatedMarker).not.toBe(VERSION);

  const second = await getEmbeddedAsset("claude");
  expect(second).toBe(finalDir);
  expect(tarCalls).toBe(1);

  spy.mockRestore();
});
