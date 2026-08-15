/**
 * Small read-only probes the framework entries share.
 *
 * Every helper here is cheap and failure-tolerant: detection runs on every
 * inject, against project trees that may be half-installed, so a missing or
 * malformed file means "not this framework", never a throw.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export function assertSafeProjectRelative(value, label = 'project path', { allowGlob = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} must be a safe project-relative path`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/u.test(value) || value.startsWith('\\')) {
    throw new Error(`${label} must be project-relative`);
  }
  const segments = value.split(/[\\/]+/u);
  if (segments.includes('..') || (!allowGlob && segments.some((part) => /[*?[]/u.test(part)))) {
    throw new Error(`${label} must not escape the project root`);
  }
  return value.split('\\').join('/');
}

function insideOrEqual(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveProjectPath(cwd, relativePath, { mustExist = false, kind = null } = {}) {
  const normalized = assertSafeProjectRelative(relativePath);
  const root = fs.realpathSync(cwd);
  const absolute = path.resolve(root, normalized);
  if (!insideOrEqual(absolute, root)) throw new Error('project path escapes the project root');
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('project path contains a symbolic link');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  if (fs.existsSync(absolute)) {
    const real = fs.realpathSync(absolute);
    if (!insideOrEqual(real, root)) throw new Error('project path resolves outside the project root');
    const stat = fs.statSync(real);
    if (kind === 'file' && !stat.isFile()) throw new Error('project path must be a regular file');
    if (kind === 'directory' && !stat.isDirectory()) throw new Error('project path must be a directory');
  } else if (mustExist) {
    throw new Error('project path does not exist');
  }
  return absolute;
}

function ensureProjectDirectory(cwd, relativeDirectory) {
  const root = fs.realpathSync(cwd);
  const normalized = relativeDirectory === '.' ? '' : assertSafeProjectRelative(relativeDirectory, 'project directory');
  let current = root;
  for (const segment of normalized.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('project directory is not a safe directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o755 });
    }
  }
  return current;
}

export function writeProjectFileAtomic(cwd, relativePath, contents) {
  const normalized = assertSafeProjectRelative(relativePath);
  const absolute = resolveProjectPath(cwd, normalized);
  ensureProjectDirectory(cwd, path.posix.dirname(normalized));
  const temporary = `${absolute}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: typeof contents === 'string' ? 'utf-8' : undefined, mode: 0o644, flag: 'wx' });
    fs.renameSync(temporary, absolute);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
  return absolute;
}

/** Merged dependency names from package.json, or an empty object. */
export function readPackageDeps(cwd) {
  try {
    const file = resolveProjectPath(cwd, 'package.json', { mustExist: true, kind: 'file' });
    const pkg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    };
  } catch {
    return {};
  }
}

export function hasAnyDependency(cwd, names) {
  const deps = readPackageDeps(cwd);
  return names.some((name) => Boolean(deps[name]));
}

/** First top-level file name matching `re`, or null. */
export function findConfigFile(cwd, re) {
  try {
    return fs.readdirSync(cwd, { withFileTypes: true })
      .find((entry) => entry.isFile() && re.test(entry.name))
      ?.name ?? null;
  } catch {
    return null;
  }
}

export function fileExists(cwd, rel) {
  try {
    return fs.existsSync(resolveProjectPath(cwd, rel, { kind: 'file' }));
  } catch {
    return false;
  }
}

export function firstExistingFile(cwd, candidates) {
  for (const rel of candidates) {
    if (fileExists(cwd, rel)) return rel;
  }
  return null;
}

/**
 * Literal (non-glob) entries of `config.files` that exist on disk. Several
 * detectors read the configured injection target as a signal, which is how the
 * bare fixtures — a tree of `.astro` files with no astro.config — still resolve
 * to the framework that authored them.
 */
export function literalConfigFiles(cwd, config) {
  const files = Array.isArray(config?.files) ? config.files : [];
  const out = [];
  for (const rel of files) {
    if (typeof rel !== 'string' || rel.includes('*') || rel.includes('?')) continue;
    try {
      const normalized = assertSafeProjectRelative(rel);
      if (fileExists(cwd, normalized)) out.push(normalized);
    } catch { /* unsafe configured paths are never framework signals */ }
  }
  return out;
}
