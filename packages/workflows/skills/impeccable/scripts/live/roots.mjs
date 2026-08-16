/**
 * Live root resolution: the single place that decides which directories a live
 * session operates on. Every live entry script resolves this once at startup
 * (see enterLiveRoot) instead of trusting its ambient cwd, which is how a
 * `cd` used to silently fork the whole system into a second, empty project.
 *
 * Four distinct roots travel together as one manifest:
 *
 *   appRoot     what the dev server serves; where live session state,
 *               injected adapters, and preview modules live.
 *   repoRoot    the git boundary (falls back to appRoot outside git).
 *   contextRoot the nearest directory from appRoot up to repoRoot carrying
 *               PRODUCT.md / DESIGN.md (canonical spot or a fallback dir).
 *   sessionRoot <appRoot>/.impeccable/live — durable live state.
 *
 * appRoot detection keys on dev-server config presence (vite/svelte/next/
 * astro/nuxt/... config files), not on monorepo brand markers. A nested
 * website/ with vite.config.js wins over a repo root that merely has a
 * package.json. Workspace declarations are one input, not the gatekeeper.
 *
 * The resolved manifest is persisted at <appRoot>/.impeccable/live/roots.json
 * plus a pointer at <repoRoot>/.impeccable/live/app-root.json when the two
 * differ, so a helper invoked from anywhere inside the repo finds the same
 * roots the boot decided on. When several apps in one repo run live, the
 * pointer follows the most recent boot; per-app roots.json files stay put.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProjectRoot } from '../context.mjs';

const ROOTS_MANIFEST_VERSION = 1;
const ROOTS_FILE = 'roots.json';
const POINTER_FILE = 'app-root.json';

const PRODUCT_NAMES = ['PRODUCT.md', 'Product.md', 'product.md'];
const DESIGN_NAMES = ['DESIGN.md', 'Design.md', 'design.md'];
const CONTEXT_FALLBACK_DIRS = ['.agents/context', 'docs'];

// Presence of any of these marks a directory as a dev-served app root.
const DEV_CONFIG_MARKERS = [
  'vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs',
  'svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts',
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.cjs',
  'nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs',
  'remix.config.js', 'react-router.config.ts',
  'angular.json',
  'webpack.config.js', 'webpack.config.ts',
];

const CANDIDATE_SCAN_IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', 'vendors',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.turbo', '.cache', '.vercel',
]);
const CANDIDATE_SCAN_DEPTH = 2;

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function firstExisting(dir, names) {
  for (const name of names) {
    const abs = path.join(dir, name);
    if (exists(abs)) return abs;
  }
  return null;
}

function hasDevConfig(dir) {
  if (DEV_CONFIG_MARKERS.some((name) => exists(path.join(dir, name)))) return true;
  // A plain Vite app can run with zero config: index.html + package.json.
  return exists(path.join(dir, 'index.html')) && exists(path.join(dir, 'package.json'));
}

function isAppRoot(dir) {
  // A directory already configured for live IS an app root, dev config or not
  // (plain static multi-page projects have no bundler config).
  return hasDevConfig(dir) || exists(path.join(dir, '.impeccable', 'live', 'config.json'));
}

function findContextFile(dir, names) {
  const direct = firstExisting(dir, names);
  if (direct) return direct;
  for (const rel of CONTEXT_FALLBACK_DIRS) {
    const nested = firstExisting(path.join(dir, rel), names);
    if (nested) return nested;
  }
  return null;
}

export function findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  const home = path.resolve(os.homedir());
  while (true) {
    if (dir === home) return null;
    if (exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function walkUp(startDir, upperBound, visit) {
  let dir = path.resolve(startDir);
  const stop = path.resolve(upperBound);
  const home = path.resolve(os.homedir());
  while (true) {
    if (dir === home) return null;
    const hit = visit(dir);
    if (hit) return hit;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function insideOrEqual(candidate, root) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isSymlink(target) {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

function nearestExistingPath(target) {
  let current = path.resolve(target);
  const missing = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function assertNoSymlinkComponents(target, root, label) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!insideOrEqual(absoluteTarget, absoluteRoot)) throw new Error(`${label} is outside its governing root`);
  let cursor = absoluteRoot;
  if (isSymlink(cursor)) throw new Error(`${label} governing root must not be a symlink`);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  for (const segment of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, segment);
    if (isSymlink(cursor)) throw new Error(`${label} must not contain symlink components`);
  }
}

function assertContainedPath(target, root, label, { allowMissing = false } = {}) {
  if (typeof target !== 'string' || target.length === 0) throw new Error(`${label} is missing`);
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const realRoot = fs.realpathSync(absoluteRoot);
  const realTarget = nearestExistingPath(absoluteTarget);
  if (!insideOrEqual(realTarget, realRoot)) throw new Error(`${label} resolves outside its governing root`);
  if (insideOrEqual(absoluteTarget, absoluteRoot)) assertNoSymlinkComponents(absoluteTarget, absoluteRoot, label);
  if (isSymlink(absoluteTarget)) throw new Error(`${label} must not be a symbolic link`);
  if (!allowMissing && !exists(absoluteTarget)) throw new Error(`${label} does not exist`);
  return realTarget;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return value;
}

function requireDirectory(target, label, { allowMissing = false } = {}) {
  if (!allowMissing && !exists(target)) throw new Error(`${label} does not exist`);
  if (exists(target) && !isDir(target)) throw new Error(`${label} must be a directory`);
  return target;
}

/** Validate persisted roots before they can influence chdir or filesystem writes. */
export function validateRootsManifest(manifest, { expectedAppRoot = null } = {}) {
  if (!manifest || typeof manifest !== 'object' || manifest.version !== ROOTS_MANIFEST_VERSION) {
    throw new Error('malformed live roots manifest');
  }
  const appRootValue = requireAbsolutePath(manifest.appRoot, 'live roots manifest appRoot');
  const repoRootValue = requireAbsolutePath(manifest.repoRoot, 'live roots manifest repoRoot');
  if (isSymlink(appRootValue)) throw new Error('live roots manifest appRoot is invalid');
  if (isSymlink(repoRootValue)) throw new Error('live roots manifest repoRoot is invalid');
  if (insideOrEqual(appRootValue, repoRootValue)) assertNoSymlinkComponents(appRootValue, repoRootValue, 'appRoot');
  const appRoot = fs.realpathSync(path.resolve(appRootValue));
  if (expectedAppRoot && appRoot !== fs.realpathSync(path.resolve(expectedAppRoot))) return null;
  requireDirectory(appRoot, 'live roots manifest appRoot');

  const discoveredRepoRoot = findGitRoot(appRoot) || appRoot;
  let repoRoot;
  try {
    repoRoot = fs.realpathSync(path.resolve(repoRootValue));
  } catch (error) {
    throw new Error('live roots manifest repoRoot does not match the governing Git boundary', { cause: error });
  }
  if (repoRoot !== fs.realpathSync(discoveredRepoRoot)) {
    throw new Error('live roots manifest repoRoot does not match the governing Git boundary');
  }
  assertContainedPath(appRoot, repoRoot, 'appRoot');

  const sessionRootValue = requireAbsolutePath(manifest.sessionRoot, 'sessionRoot');
  const sessionRoot = assertContainedPath(sessionRootValue, appRoot, 'sessionRoot', { allowMissing: true });
  requireDirectory(sessionRoot, 'sessionRoot', { allowMissing: true });
  const contextRoot = manifest.contextRoot == null
    ? null
    : requireDirectory(assertContainedPath(requireAbsolutePath(manifest.contextRoot, 'contextRoot'), repoRoot, 'contextRoot'), 'contextRoot');
  const validateContextFile = (value, label) => {
    if (value == null) return null;
    const file = assertContainedPath(requireAbsolutePath(value, label), repoRoot, label, { allowMissing: true });
    if (!exists(file)) return file;
    let stat;
    try { stat = fs.statSync(file); } catch { throw new Error(`${label} is unreadable`); }
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    return file;
  };
  return {
    ...manifest,
    appRoot,
    repoRoot,
    contextRoot,
    sessionRoot,
    productPath: validateContextFile(manifest.productPath, 'productPath'),
    designPath: validateContextFile(manifest.designPath, 'designPath'),
  };
}

/**
 * Scan downward (bounded depth) for directories carrying a dev-server config.
 * Used when live boots from a directory that is not itself an app root and no
 * --target narrows the choice: one candidate is auto-picked, several become a
 * selection prompt.
 */
export function discoverAppCandidates(rootDir, depth = CANDIDATE_SCAN_DEPTH) {
  const found = [];
  const scan = (dir, remaining) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || CANDIDATE_SCAN_IGNORED.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      // Same criterion as the upward walk (isAppRoot): a live-configured
      // plain-static site with no bundler markers is still an app, and
      // missing it here would silently fall back to the wrong root.
      if (isAppRoot(abs)) {
        found.push(abs);
        continue; // nested apps below an app root are that app's business
      }
      if (remaining > 1) scan(abs, remaining - 1);
    }
  };
  scan(path.resolve(rootDir), depth);
  return found.sort();
}

/**
 * Fresh root resolution. Never reads a persisted manifest.
 *
 * Returns { manifest } on success or { selection } when several candidate
 * apps exist and nothing disambiguates.
 */
export function resolveRoots({ cwd = process.cwd(), targetPath = null } = {}) {
  const absCwd = path.resolve(cwd);
  const absTarget = targetPath
    ? (path.isAbsolute(targetPath) ? targetPath : path.resolve(absCwd, targetPath))
    : null;
  const targetDir = absTarget
    ? (isDir(absTarget) ? absTarget : path.dirname(absTarget))
    : absCwd;

  // The walk bound must be an ancestor of the target: a git root found from
  // the CWD is only usable when the target actually lives inside it,
  // otherwise the walk would climb out of both trees.
  const targetGitRoot = findGitRoot(targetDir);
  const cwdGitRoot = targetGitRoot ? null : findGitRoot(absCwd);
  const repoRoot = targetGitRoot
    || (cwdGitRoot && insideOrEqual(targetDir, cwdGitRoot) ? cwdGitRoot : null);
  // Without a git boundary, never ascend above the starting directory: the
  // filesystem above an unversioned project is not ours to interpret.
  const upperBound = repoRoot || targetDir;

  // The workspace-aware legacy resolution (context.mjs) still decides two
  // things: the fallback when no app marker exists, and how far the marker
  // walk may ascend when an explicit target selected a workspace child. A
  // root-level live config must never shadow a child the target picked.
  const legacyRoot = resolveProjectRoot(absCwd, absTarget ? { targetPath: absTarget } : {});
  const markerBound = absTarget && insideOrEqual(targetDir, legacyRoot) && insideOrEqual(legacyRoot, upperBound)
    ? legacyRoot
    : upperBound;

  let appRoot = walkUp(targetDir, markerBound, (dir) => (isAppRoot(dir) ? dir : null));
  let resolvedFrom = appRoot
    ? (absTarget ? `target:${path.relative(absCwd, absTarget) || '.'}` : 'cwd')
    : null;

  if (!appRoot && !absTarget) {
    const candidates = discoverAppCandidates(absCwd);
    if (candidates.length === 1) {
      appRoot = candidates[0];
      resolvedFrom = `candidate:${path.relative(absCwd, appRoot)}`;
    } else if (candidates.length > 1) {
      return {
        selection: {
          candidates: candidates.map((abs) => ({
            name: path.basename(abs),
            path: path.relative(absCwd, abs).split(path.sep).join('/'),
          })),
        },
      };
    }
  }

  if (!appRoot) {
    // No app marker anywhere: defer to the workspace-aware legacy resolution
    // (workspace child for a targeted monorepo path, cwd otherwise). Never
    // adopt an arbitrary ancestor just because it has a package.json, and
    // never adopt a root that does not even contain the target.
    appRoot = insideOrEqual(targetDir, legacyRoot) ? legacyRoot : targetDir;
    resolvedFrom = 'fallback';
  }

  const effectiveRepoRoot = repoRoot && insideOrEqual(appRoot, repoRoot) ? repoRoot : appRoot;

  // Each context file resolves independently: a child app may carry its own
  // PRODUCT.md while inheriting DESIGN.md from the repo root (or vice versa).
  const productPath = walkUp(appRoot, effectiveRepoRoot, (dir) => findContextFile(dir, PRODUCT_NAMES));
  const designPath = walkUp(appRoot, effectiveRepoRoot, (dir) => findContextFile(dir, DESIGN_NAMES));
  const contextRoot = productPath
    ? path.dirname(productPath)
    : designPath
      ? path.dirname(designPath)
      : null;

  const manifest = validateRootsManifest({
    version: ROOTS_MANIFEST_VERSION,
    appRoot,
    repoRoot: effectiveRepoRoot,
    contextRoot,
    sessionRoot: path.join(appRoot, '.impeccable', 'live'),
    productPath,
    designPath,
    resolvedFrom,
  });
  return { manifest };
}

function rootsFilePath(appRoot) {
  return path.join(appRoot, '.impeccable', 'live', ROOTS_FILE);
}

function pointerFilePath(repoRoot) {
  return path.join(repoRoot, '.impeccable', 'live', POINTER_FILE);
}

function ensureSafeDirectory(target, root, label) {
  const absoluteRoot = assertContainedPath(root, root, `${label} root`);
  const absoluteTarget = assertContainedPath(target, absoluteRoot, label, { allowMissing: true });
  const relative = path.relative(absoluteRoot, absoluteTarget);
  let current = absoluteRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
      if (!stat.isDirectory()) throw new Error(`${label} parent is not a directory`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fs.mkdirSync(current);
    }
  }
  return absoluteTarget;
}

function writeManifestFile(file, root, text) {
  assertContainedPath(file, root, 'manifest file', { allowMissing: true });
  if (isSymlink(file)) throw new Error('manifest file must not be a symbolic link');
  fs.writeFileSync(file, text, { mode: 0o644 });
}

export function writeRootsManifest(manifest) {
  const safeManifest = validateRootsManifest(manifest);
  const file = rootsFilePath(safeManifest.appRoot);
  ensureSafeDirectory(path.dirname(file), safeManifest.appRoot, 'app roots directory');
  writeManifestFile(file, safeManifest.appRoot, JSON.stringify(safeManifest, null, 2));
  if (path.resolve(safeManifest.repoRoot) !== path.resolve(safeManifest.appRoot)) {
    const pointer = pointerFilePath(safeManifest.repoRoot);
    ensureSafeDirectory(path.dirname(pointer), safeManifest.repoRoot, 'repo roots directory');
    // The pointer records EVERY app that has booted live in this repo, most
    // recent first. A single last-boot-wins value made a helper run from the
    // repo root silently target whichever app booted last, even while an
    // earlier app's session was the one still live.
    const entries = readPointerEntries(safeManifest.repoRoot)
      .map((entry) => ({ ...entry, appRoot: validatePointerAppRoot(entry.appRoot, safeManifest.repoRoot) }))
      .filter((entry) => path.resolve(entry.appRoot) !== path.resolve(safeManifest.appRoot));
    entries.unshift({ appRoot: safeManifest.appRoot, bootedAt: new Date().toISOString() });
    writeManifestFile(pointer, safeManifest.repoRoot, JSON.stringify({ version: 2, appRoots: entries }));
  }
  return file;
}

function readPointerEntries(repoRoot) {
  const pointer = pointerFilePath(repoRoot);
  assertContainedPath(pointer, fs.realpathSync(repoRoot), 'live roots pointer', { allowMissing: true });
  try {
    if (isSymlink(pointer)) throw new Error('live roots pointer must not be a symbolic link');
    const raw = JSON.parse(fs.readFileSync(pointer, 'utf-8'));
    if (Array.isArray(raw?.appRoots)) {
      if (raw.version !== 2 || raw.appRoots.some((entry) => !entry || typeof entry.appRoot !== 'string')) {
        throw new Error('malformed live roots pointer');
      }
      return raw.appRoots;
    }
    if (raw && typeof raw.appRoot === 'string' && (raw.version == null || raw.version === 1)) return [{ appRoot: raw.appRoot }];
    throw new Error('malformed live roots pointer');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (error instanceof SyntaxError) throw new Error('malformed live roots pointer');
    throw error;
  }
}

function validatePointerAppRoot(value, repoRoot) {
  const appRoot = requireAbsolutePath(value, 'live roots pointer appRoot');
  return assertContainedPath(appRoot, repoRoot, 'live roots pointer appRoot', { allowMissing: true });
}

/**
 * True when the app's live helper server is recorded and its pid is alive.
 * A liveness signal alone misclassifies a REUSED pid (helper died without
 * removing server.json, the OS handed the pid to something else), so the
 * process's command line must also look like a node process; that removes
 * reuse by arbitrary processes. A pid reused by another node process remains
 * a residual false positive, which the multi-app warning and --target
 * escape hatch cover.
 */
function hasLiveServer(appRoot) {
  let pid;
  let port;
  let token;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(appRoot, '.impeccable', 'live', 'server.json'), 'utf-8'));
    if (!info || typeof info.pid !== 'number') return false;
    pid = info.pid;
    port = Number(info.port);
    token = typeof info.token === 'string' ? info.token : null;
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: the process exists but is not signalable by this user.
    if (error?.code !== 'EPERM') return false;
  }
  // Liveness alone misclassifies a REUSED pid, and a bare TCP connect
  // misclassifies a coincidental listener on a reused port. The decisive
  // signal is IDENTITY: the helper answers its authenticated /status
  // endpoint with the token server.json records; nothing else on that port
  // can. The probe is a spawned node one-liner so it works identically on
  // every platform.
  if (Number.isInteger(port) && port > 0 && token) {
    try {
      execFileSync(process.execPath, ['-e', [
        "const req = require('node:http').get({ host: '127.0.0.1', port: Number(process.argv[1]), path: '/status?token=' + encodeURIComponent(process.argv[2]), timeout: 1200 }, (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); });",
        "req.on('timeout', () => { req.destroy(); process.exit(1); });",
        "req.on('error', () => process.exit(1));",
      ].join(''), String(port), token], { timeout: 4000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  // Every server.json this codebase has ever written records port + token
  // (see writeLiveServerInfo). A record without them is malformed or foreign
  // and cannot be authenticated, so it does not count as a live helper;
  // resolution falls to the durable-session tier, which is the correct
  // recovery path for a stopped or crashed helper anyway.
  return false;
}

const TERMINAL_SESSION_PHASES = new Set(['completed', 'discarded']);

/**
 * True when the app's durable session store holds a session that is not
 * terminal. With every helper server stopped, this is what distinguishes
 * "the app whose interrupted session the user is trying to recover" from an
 * app that merely booted more recently.
 */
function hasActiveDurableSession(appRoot) {
  const dir = path.join(appRoot, '.impeccable', 'live', 'sessions');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (!name.endsWith('.snapshot.json')) continue;
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
      if (snapshot?.phase && !TERMINAL_SESSION_PHASES.has(snapshot.phase)) return true;
    } catch { /* skip unreadable snapshots */ }
  }
  return false;
}

function readManifestAt(appRoot) {
  if (isSymlink(appRoot)) throw new Error('live roots manifest appRoot must not be a symbolic link');
  if (!exists(appRoot)) return null;
  const file = rootsFilePath(appRoot);
  assertContainedPath(file, fs.realpathSync(appRoot), 'live roots manifest', { allowMissing: true });
  if (isSymlink(file)) throw new Error('live roots manifest must not be a symbolic link');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('malformed live roots manifest');
    throw error;
  }
  if (!raw || typeof raw.appRoot !== 'string') throw new Error('malformed live roots manifest');
  // A manifest is only trusted where it claims to live; anything else is a
  // copied or stale file. Compare canonical paths so `/var` and `/private/var`
  // aliases on macOS do not make a valid manifest look stale.
  if (path.resolve(raw.appRoot) !== path.resolve(appRoot)) {
    try {
      if (fs.realpathSync(raw.appRoot) !== fs.realpathSync(appRoot)) return null;
    } catch { return null; }
  }
  return validateRootsManifest(raw, { expectedAppRoot: appRoot });
}

/**
 * Resolve the roots for the live session governing `cwd`, preferring a
 * persisted manifest (written by the boot) over fresh detection:
 *
 *   1. Walk up from cwd looking for .impeccable/live/roots.json.
 *   2. At the git root, follow .impeccable/live/app-root.json to the app.
 *   3. Fresh resolveRoots().
 *
 * Fresh results are NOT persisted here; only the boot (live.mjs / server
 * startup) writes manifests, so ad-hoc helper invocations cannot mint
 * conflicting truth.
 */
export function resolveLiveRoots(cwd = process.cwd(), { targetPath = null } = {}) {
  const absCwd = path.resolve(cwd);

  if (!targetPath) {
    const gitRoot = findGitRoot(absCwd);
    const persisted = walkUp(absCwd, gitRoot || absCwd, (dir) => readManifestAt(dir));
    if (persisted) return { manifest: persisted, source: 'persisted' };

    if (gitRoot) {
      // Several apps in one repo may have booted live. Preference order:
      // a running helper server, then an app whose durable store still holds
      // a non-terminal session (the stopped session the user is recovering),
      // then the most recent boot. A stale pointer entry must never redirect
      // status/poll/accept onto the wrong app's session store.
      const pointerRoot = fs.realpathSync(gitRoot);
      const candidates = readPointerEntries(pointerRoot)
        .map((entry) => readManifestAt(validatePointerAppRoot(entry.appRoot, pointerRoot)))
        .filter(Boolean);
      if (candidates.length > 0) {
        const liveApps = candidates.filter((manifest) => hasLiveServer(manifest.appRoot));
        const recoveringApps = liveApps.length > 0
          ? liveApps
          : candidates.filter((manifest) => hasActiveDurableSession(manifest.appRoot));
        const tier = recoveringApps.length > 0 ? recoveringApps : candidates;
        // Multiple apps qualifying at the same tier is inherent ambiguity:
        // intent is unknowable from the repo root. The choice stays
        // deterministic (most recent boot first), but it must be LOUD, not
        // silent, so the agent can re-anchor when it meant the other app.
        if (tier.length > 1) {
          const chosen = tier[0].appRoot;
          const others = tier.slice(1).map((manifest) => manifest.appRoot).join(', ');
          process.stderr.write(
            `[impeccable live] Multiple apps in this repo have live state; using ${chosen}. `
            + `Other candidate(s): ${others}. Run from the app directory (or pass --target) to address a specific app.\n`,
          );
        }
        return { manifest: tier[0], source: 'pointer' };
      }
    }
  }

  const fresh = resolveRoots({ cwd: absCwd, targetPath });
  if (fresh.selection) return { selection: fresh.selection, source: 'fresh' };
  return { manifest: fresh.manifest, source: 'fresh' };
}

/**
 * Consume a `--target <path>` / `--target=<path>` pair from an argv array,
 * returning the value and removing the tokens so downstream flag parsers
 * (which do not know the option) never see them.
 */
export function consumeTargetArg(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      const value = argv[i + 1];
      // A --target with no usable value must not degrade into implicit root
      // selection: these helpers mutate session state, and "the most recent
      // app" is exactly what the caller was trying NOT to get.
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        throw new Error('--target requires a path value (use --target <path> or --target=<path>)');
      }
      argv.splice(i, 2);
      return value;
    }
    if (typeof arg === 'string' && arg.startsWith('--target=')) {
      const value = arg.slice('--target='.length);
      if (value === '') {
        throw new Error('--target requires a path value (use --target <path> or --target=<path>)');
      }
      argv.splice(i, 1);
      return value;
    }
  }
  return null;
}

/**
 * Entry-point guard for live CLI scripts: resolve the governing roots and
 * make appRoot the process cwd so every downstream path derivation agrees
 * with the boot. An explicit `--target <path>` on the helper's command line
 * overrides pointer resolution, which is what disambiguates a repo with
 * several live apps (the multi-app warning names this escape hatch, so it
 * has to actually work on every helper). Returns the manifest. On selection
 * ambiguity it stays in the current directory (the boot flow handles
 * prompting); a malformed --target exits with an error instead of silently
 * falling back to implicit selection, which could mutate the wrong app.
 */
export function enterLiveRoot(cwd = process.cwd()) {
  let targetPath;
  try {
    targetPath = consumeTargetArg(process.argv);
  } catch (err) {
    console.error(`[impeccable live] ${err.message}`);
    process.exit(1);
  }
  const resolved = resolveLiveRoots(cwd, targetPath ? { targetPath } : {});
  if (!resolved.manifest) return null;
  const appRoot = resolved.manifest.appRoot;
  if (path.resolve(cwd) !== path.resolve(appRoot)) {
    // Failing to land on the resolved appRoot must be fatal: a helper that
    // silently keeps its ambient cwd derives server, session, and source
    // paths from a different project and mutates the wrong state. A manifest
    // pointing at a deleted directory is stale ambient truth, not a reason
    // to guess.
    if (!isDir(appRoot)) {
      console.error(`[impeccable live] resolved app root does not exist: ${appRoot} (stale roots manifest? re-run the live boot, or pass --target <path>)`);
      process.exit(1);
    }
    try {
      process.chdir(appRoot);
    } catch (err) {
      console.error(`[impeccable live] could not enter app root ${appRoot}: ${err.message}`);
      process.exit(1);
    }
  }
  return resolved.manifest;
}
