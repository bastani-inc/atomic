/**
 * Lazy first-run sync of tooling deps, bundled agents, and global skills.
 *
 * Why this exists: bun's package manager does NOT execute the top-level
 * package's `postinstall` script on `bun add -g` / `bun update -g` — see
 * `src/install/PackageManager/install_with_manager.zig` (the
 * `!manager.options.global` guard around root lifecycle scripts). So
 * there's no install-time hook we can register from `package.json`.
 *
 * Instead, we detect a fresh install or upgrade lazily on CLI startup by
 * comparing the bundled `VERSION` constant against a marker file at
 * `~/.atomic/.synced-version`. On a mismatch we run the same setup the
 * production bootstrap installers (`install.sh` / `install.ps1`) provide,
 * silently in the background:
 *
 *     2. uv (provides uvx)       (curl https://astral.sh/uv/install.sh | sh)
 *     3. global agent configs    (file copies — no network)
 *     4. @playwright/cli         (bun install -g)
 *     5. @llamaindex/liteparse   (bun install -g)
 *     6. @ast-grep/cli           (bun install -g)
 *     7. global skills           (file copies from bundled .agents/skills)
 *
 * All steps run silently. The only user-facing loading bar lives in the
 * bootstrap installers (install.sh / install.ps1). Failures are swallowed;
 * the marker is only written when every step succeeds, so the next launch
 * retries (all steps are idempotent).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "../../version.ts";
import {
  hasUv,
  ensureUvInstalled,
  upgradeGlobalToolPackages,
} from "@bastani/atomic-sdk/lib/spawn";
import { isInstalledPackage } from "@bastani/atomic-sdk/lib/runtime-env";
import { installGlobalAgents } from "./agents.ts";
import { installGlobalSkills } from "./skills.ts";
import { seedGlobalAdditionalInstructions } from "@bastani/atomic-sdk/services/config/additional-instructions";
import { seedGlobalProviderEnvVars } from "../config/settings.ts";

/** Path to the version marker. Honors ATOMIC_SETTINGS_HOME for tests. */
function syncMarkerPath(): string {
  const home = process.env.ATOMIC_SETTINGS_HOME ?? homedir();
  return join(home, ".atomic", ".synced-version");
}

/**
 * Write the version marker. Best-effort: a failed write just means the
 * next launch will re-sync, which is wasteful but not broken.
 */
export async function markSynced(): Promise<void> {
  try {
    await Bun.write(syncMarkerPath(), VERSION);
  } catch {
    // Swallow — see docstring.
  }
}

/**
 * Run a step silently, returning whether it succeeded.
 */
async function silentStep(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync tooling deps, bundled agents, and global skills if the marker
 * doesn't match the bundled VERSION. No-op in dev checkouts and when the
 * marker already matches the current version and the platform-native
 * multiplexer is present.
 *
 * Runs entirely silently — no spinner, no progress bar, no banner. The
 * only loading UI lives in the bootstrap installers (install.sh / install.ps1).
 */
export async function autoSyncIfStale(): Promise<void> {
  // Seed the global additional-instructions AGENTS.md on every CLI start —
  // a single `existsSync` when already present, so cheap enough to run
  // outside the installed-package gate. This way dev checkouts also get
  // the file and the resolver in `additional-instructions.ts` always finds
  // a non-`undefined` path on machines that have ever run `atomic`.
  await silentStep(seedGlobalAdditionalInstructions);
  await silentStep(seedGlobalProviderEnvVars);

  if (!isInstalledPackage(import.meta.dir)) return;

  let stored = "";
  const marker = Bun.file(syncMarkerPath());
  if (await marker.exists()) {
    stored = (await marker.text()).trim();
  }

  if (stored === VERSION && hasUv()) return;

  const steps = stored === VERSION
    ? [
        silentStep(() => ensureUvInstalled({ quiet: true })),
      ]
    : [
        silentStep(() => ensureUvInstalled({ quiet: true })),
        silentStep(installGlobalAgents),
        silentStep(upgradeGlobalToolPackages),
        silentStep(installGlobalSkills),
      ];

  // All steps run in parallel and silently. Failures are swallowed so the
  // CLI can proceed. The marker is only written when every step succeeds;
  // on partial failure the next launch retries (all steps are idempotent).
  const results = await Promise.all(steps);

  const allOk = results.every(Boolean);

  if (allOk) {
    await markSynced();
  }
}
