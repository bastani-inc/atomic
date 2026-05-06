import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";
import { findRepoRoot } from "../src/lib/workspace-paths.ts";

interface ArchiveSpec {
  outPath: string;
  leafDir: string;
  excludes?: readonly string[];
}

/**
 * Hard cap on per-entry path length inside the embedded tarballs.
 *
 * Windows MAX_PATH is 260 chars. The cache extraction prefix
 * (`%LOCALAPPDATA%\atomic\Cache\<version>\<leaf>\`) is ~85 chars on a
 * long-username install. 150 chars per entry leaves ~25 chars of
 * headroom against the Windows limit and ~60 chars of growth runway
 * over the current longest entry (~89 chars in `.opencode.tar` /
 * `skills.tar`). If a contributor vendors a deeper transitive or
 * adds a deeply-nested skill, the build fails loudly here instead
 * of shipping a binary that explodes at extraction time on Windows.
 */
export const MAX_TARRED_PATH_CHARS = 150;

/** Returns the longest entry that exceeds the limit, or null if none. */
export function findOverlongTarEntry(entries: readonly string[]): string | null {
  let worst = "";
  for (const e of entries) {
    if (e.length > worst.length) worst = e;
  }
  return worst.length > MAX_TARRED_PATH_CHARS ? worst : null;
}

export async function bundleEmbeddedAssets(rootDir: string): Promise<void> {
  // Ensure .agents/ dir exists at workspace root (for skills.tar)
  await mkdir(join(rootDir, ".agents"), { recursive: true });

  const archives: ArchiveSpec[] = [
    { outPath: join(rootDir, ".claude.tar"),           leafDir: join(rootDir, ".claude"),
      // `.claude/skills` is a symlink to `.agents/skills`. Skills ship in
      // their own bundle (`skills.tar`) and are copied into `~/.claude/skills`
      // at install time, so the symlink entry is redundant. Excluding it also
      // avoids extraction failures on Windows accounts without Developer Mode
      // or admin rights, where bsdtar can't recreate symlinks.
      excludes: ["skills"] },
    { outPath: join(rootDir, ".opencode.tar"),         leafDir: join(rootDir, ".opencode") },
    { outPath: join(rootDir, ".github.tar"),           leafDir: join(rootDir, ".github"),
      excludes: ["workflows", "dependabot.yml"] },
    { outPath: join(rootDir, ".agents", "skills.tar"), leafDir: join(rootDir, ".agents", "skills") },
  ];

  for (const { outPath, leafDir, excludes } of archives) {
    const excludeArgs = (excludes ?? []).map((ex) => `--exclude=${ex}`);
    const r = spawnSync(
      "tar",
      ["-cf", outPath, ...excludeArgs, "-C", leafDir, "."],
      { stdio: "inherit" },
    );
    if (r.status !== 0) {
      throw new Error(
        `bundleEmbeddedAssets: tar failed for ${outPath} (exit ${r.status})`,
      );
    }

    const list = spawnSync("tar", ["-tf", outPath], { encoding: "utf8" });
    if (list.status !== 0) {
      throw new Error(`bundleEmbeddedAssets: tar -tf failed for ${outPath} (exit ${list.status})`);
    }
    const entries = (list.stdout as string).split("\n").filter(Boolean);
    const overlong = findOverlongTarEntry(entries);
    if (overlong) {
      throw new Error(
        `bundleEmbeddedAssets: ${basename(outPath)} contains a ${overlong.length}-char path ` +
        `(limit ${MAX_TARRED_PATH_CHARS}): ${overlong}\n` +
        `Windows MAX_PATH is 260; the cache prefix on long-username installs is ~85 chars, ` +
        `so per-entry paths must stay under ${MAX_TARRED_PATH_CHARS} to leave safe headroom.`,
      );
    }

    console.log(`bundled: ${outPath}`);
  }
}

if (import.meta.main) {
  const rootDir = findRepoRoot(import.meta.dir);
  await bundleEmbeddedAssets(rootDir);
}
