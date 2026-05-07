/**
 * Per-platform binary targets shared by build.ts, publish.ts, and the
 * companion tests. Centralised so a target added in one place is picked up
 * everywhere without drift.
 */

export interface BuildTarget {
  /** Artifact / npm package suffix (`@bastani/atomic-<name>`). */
  readonly name: string;
  /** `bun build --compile --target` value. */
  readonly bunTarget: Bun.Build.CompileTarget;
  /** Value for npm's `os` field. */
  readonly os: "linux" | "darwin" | "win32";
  /** Value for npm's `cpu` field. */
  readonly cpu: "x64" | "arm64";
  /**
   * Value for npm's `libc` field (Linux only). Without it, npm cannot
   * distinguish glibc vs musl variants and may install the wrong binary on
   * Alpine — crashing at launch on `libc.so.6` lookup.
   */
  readonly libc?: "glibc" | "musl";
  /** Binary file extension (Windows only). */
  readonly ext?: ".exe";
}

export const TARGETS: readonly BuildTarget[] = [
  { name: "linux-x64",          bunTarget: "bun-linux-x64",            os: "linux",  cpu: "x64",   libc: "glibc" },
  { name: "linux-arm64",        bunTarget: "bun-linux-arm64",          os: "linux",  cpu: "arm64", libc: "glibc" },
  { name: "linux-x64-musl",     bunTarget: "bun-linux-x64-musl",       os: "linux",  cpu: "x64",   libc: "musl"  },
  { name: "linux-arm64-musl",   bunTarget: "bun-linux-arm64-musl",     os: "linux",  cpu: "arm64", libc: "musl"  },
  { name: "darwin-x64",         bunTarget: "bun-darwin-x64",           os: "darwin", cpu: "x64"   },
  { name: "darwin-arm64",       bunTarget: "bun-darwin-arm64",         os: "darwin", cpu: "arm64" },
  { name: "windows-x64",        bunTarget: "bun-windows-x64",          os: "win32",  cpu: "x64",   ext: ".exe" },
  { name: "windows-arm64",      bunTarget: "bun-windows-arm64",        os: "win32",  cpu: "arm64", ext: ".exe" },
] as const;

/** Host-platform target name (e.g. `linux-x64`). */
export function hostTarget(): string {
  const plat = process.platform === "win32" ? "windows" : process.platform;
  return `${plat}-${process.arch}`;
}
