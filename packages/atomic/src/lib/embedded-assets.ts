import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version.ts";   // inlined by `bun build --compile`
import type { EmbeddedAssetKind } from "@bastani/atomic-sdk/services/config/definitions";
import { isCompiledBinaryRuntime } from "@bastani/atomic-sdk/lib/runtime-env";

import claudeAssetsBundle   from "../../../../.claude.tar"          with { type: "file" };
import opencodeAssetsBundle from "../../../../.opencode.tar"        with { type: "file" };
import githubAssetsBundle   from "../../../../.github.tar"          with { type: "file" };
import skillsBundle         from "../../../../.agents/skills.tar"   with { type: "file" };

export const BUNDLES: Record<EmbeddedAssetKind, string> = {
  claude:   claudeAssetsBundle,
  opencode: opencodeAssetsBundle,
  github:   githubAssetsBundle,
  skills:   skillsBundle,
};

function cacheRoot(): string {
  switch (platform()) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "atomic", "Cache");
    case "darwin":
      return join(homedir(), "Library", "Caches", "atomic");
    default:
      return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "atomic");
  }
}

function fingerprintAsset(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extractionMarker(fingerprint: string): string {
  return `${VERSION}\n${fingerprint}\n`;
}

export async function getEmbeddedAsset(kind: EmbeddedAssetKind): Promise<string> {
  const tarPath = BUNDLES[kind];
  if (!tarPath) {
    throw new Error(
      `embedded-assets: bundle '${kind}' missing. Run 'bun packages/atomic/script/build-assets.ts' or rely on the test preload hook.`,
    );
  }

  const tarBytes = await Bun.file(tarPath).bytes();
  const expectedMarker = extractionMarker(fingerprintAsset(tarBytes));
  const finalDir = join(cacheRoot(), VERSION, kind);
  const markerPath = join(finalDir, ".extracted");
  if (existsSync(markerPath)) {
    const marker = await Bun.file(markerPath).text();
    if (marker === expectedMarker) return finalDir;
  }

  const stagingDir = join(cacheRoot(), VERSION, `.${kind}.staging.${process.pid}.${Date.now()}`);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  // In a compiled binary the asset paths live under Bun's virtual FS
  // (/$bunfs/...) which is accessible to Bun APIs but NOT to OS subprocesses
  // like `tar`. Materialise the tar to a real temp file first so the OS can
  // read it; clean up afterwards.
  const inBunfs = isCompiledBinaryRuntime(tarPath);
  const tarPathForOs = inBunfs
    ? join(tmpdir(), `.atomic-${kind}-${process.pid}-${Date.now()}.tar`)
    : tarPath;
  if (inBunfs) {
    await Bun.write(tarPathForOs, tarBytes);
  }

  // On Windows, prefer the bsdtar shipped in System32 over whatever `tar`
  // resolves to on PATH. Git Bash provides a Cygwin-flavored GNU tar that
  // mangles native Windows paths in two ways: the `-f` arg with a drive
  // letter is read as SCP-style `host:path` (`Cannot connect to C:`), and
  // the `-C` arg is silently truncated to its first path component. bsdtar
  // (`%SystemRoot%\System32\tar.exe`, present on every supported Windows)
  // handles native paths correctly and has shipped with Windows 10+ since
  // 1803. Fall back to PATH lookup if it's somehow absent.
  let tarBin = "tar";
  if (process.platform === "win32") {
    const sysTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (existsSync(sysTar)) tarBin = sysTar;
  }
  const proc = Bun.spawn([tarBin, "-xf", tarPathForOs, "-C", stagingDir], { stderr: "pipe" });
  const exitCode = await proc.exited;
  if (inBunfs) await rm(tarPathForOs, { force: true });
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    await rm(stagingDir, { recursive: true, force: true });
    throw new Error(`getEmbeddedAsset: tar failed for ${kind} (exit ${exitCode}): ${stderr}`);
  }
  await writeFile(join(stagingDir, ".extracted"), expectedMarker);

  await rm(finalDir, { recursive: true, force: true });
  await rename(stagingDir, finalDir);
  return finalDir;
}
