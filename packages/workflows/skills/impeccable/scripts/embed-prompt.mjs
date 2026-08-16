#!/usr/bin/env node
// Embed a generation prompt into an image so the intent travels with the file,
// across harnesses and machines. Read it back with --read.
//
//   node embed-prompt.mjs <image> --prompt "the prompt text"
//   node embed-prompt.mjs <image> --prompt-file prompt.txt
//   node embed-prompt.mjs <image> --read
//
// Formats: PNG (tEXt chunk, keyword "impeccable:prompt"), JPEG (COM segment),
// and a JSON sidecar fallback for other formats. Paths are deliberately scoped
// to the active Git/project root because this command writes its input asset.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const KEYWORD = 'impeccable:prompt';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function findProjectRoot(startDir) {
  let current = fs.realpathSync(startDir);
  while (true) {
    try {
      if (fs.lstatSync(path.join(current, '.git'))) return current;
    } catch {
      // Keep walking; a missing .git entry is normal above a project root.
    }
    const parent = path.dirname(current);
    if (parent === current) return fs.realpathSync(startDir);
    current = parent;
  }
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} must be a safe project-relative path`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/u.test(value) || value.startsWith('\\')) {
    throw new Error(`${label} must be project-relative`);
  }
  if (value.split(/[\\/]+/u).includes('..')) {
    throw new Error(`${label} must not contain traversal segments`);
  }
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function existingRegularPath(root, value, label) {
  assertSafeRelativePath(value, label);
  const absolute = path.resolve(root, value);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} does not exist`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  const realRoot = fs.realpathSync(root);
  const realPath = fs.realpathSync(absolute);
  if (!isInside(realPath, realRoot)) throw new Error(`${label} resolves outside the project root`);
  return realPath;
}

function sidecarPath(root, file) {
  const candidate = `${file}.json`;
  const absolute = path.resolve(root, candidate);
  const realRoot = fs.realpathSync(root);
  if (!isInside(absolute, realRoot)) throw new Error('sidecar path resolves outside the project root');
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('sidecar path must not be a symbolic link');
    if (!stat.isFile()) throw new Error('sidecar path must be a regular file');
    if (!isInside(fs.realpathSync(absolute), realRoot)) throw new Error('sidecar path resolves outside the project root');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return absolute;
}

/** Resolve an existing project-relative file and reject symlink escapes. */
export function resolveInputPath(value, { cwd = process.cwd() } = {}) {
  const root = findProjectRoot(cwd);
  return existingRegularPath(root, value, 'image path');
}

/** Write through a sibling temporary file, then atomically replace the target. */
export function writeAtomic(filePath, contents) {
  const directory = path.dirname(filePath);
  let targetStat = null;
  try {
    targetStat = fs.lstatSync(filePath);
    if (targetStat.isSymbolicLink()) throw new Error('refusing to replace a symbolic link');
    if (!targetStat.isFile()) throw new Error('target must be a regular file');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const mode = targetStat ? targetStat.mode & 0o777 : 0o644;
  const temporary = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

const crc32 = (data) => {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

function pngChunk(type, data) {
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, 'ascii');
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return output;
}

function parsePngChunks(buffer) {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('malformed PNG');
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error('malformed PNG chunk');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length), raw: buffer.subarray(offset, end) });
    offset = end;
    if (type === 'IEND') return { chunks, iendOffset: offset - chunks.at(-1).raw.length };
  }
  throw new Error('malformed PNG: missing IEND');
}

export function readPngText(buffer) {
  try {
    for (const { type, data } of parsePngChunks(buffer).chunks) {
      if (type !== 'tEXt' && type !== 'zTXt') continue;
      const separator = data.indexOf(0);
      if (separator === -1 || data.toString('latin1', 0, separator) !== KEYWORD) continue;
      if (type === 'tEXt') return data.toString('utf8', separator + 1);
      if (data[separator + 1] !== 0) continue;
      try { return zlib.inflateSync(data.subarray(separator + 2)).toString('utf8'); } catch { return null; }
    }
  } catch {
    return null;
  }
  return null;
}

export function readJpegCom(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    if (marker === 0xda) break;
    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buffer.length) break;
    if (marker === 0xfe) {
      const text = buffer.toString('utf8', offset + 4, end);
      if (text.startsWith(`${KEYWORD}\0`)) return text.slice(KEYWORD.length + 1);
    }
    offset = end;
  }
  return null;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const fileArgument = args.find((arg) => !arg.startsWith('--'));
  if (!fileArgument) throw new Error('image file required');
  const root = findProjectRoot(cwd);
  const file = existingRegularPath(root, fileArgument, 'image path');
  const sidecar = sidecarPath(root, file);
  const buffer = fs.readFileSync(file);
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;

  if (args.includes('--read')) {
    let prompt = isPng ? readPngText(buffer) : isJpeg ? readJpegCom(buffer) : null;
    if (prompt == null) {
      try { prompt = JSON.parse(fs.readFileSync(sidecar, 'utf8')).prompt ?? null; } catch { /* fall through */ }
    }
    if (prompt == null) throw Object.assign(new Error('no embedded prompt found'), { exitCode: 2 });
    console.log(prompt);
    return;
  }

  const promptFile = argumentValue(args, '--prompt-file');
  const prompt = argumentValue(args, '--prompt') ?? (promptFile ? fs.readFileSync(existingRegularPath(root, promptFile, 'prompt file'), 'utf8') : null);
  if (!prompt) throw new Error('--prompt or --prompt-file required');

  if (isPng) {
    const parsed = parsePngChunks(buffer);
    const body = parsed.chunks
      .filter(({ type, data }) => {
        if (type !== 'tEXt' && type !== 'zTXt') return type !== 'IEND';
        const separator = data.indexOf(0);
        return separator === -1 || data.toString('latin1', 0, separator) !== KEYWORD;
      })
      .map(({ raw }) => raw);
    const output = Buffer.concat([
      PNG_SIGNATURE,
      ...body,
      pngChunk('tEXt', Buffer.concat([Buffer.from(KEYWORD, 'latin1'), Buffer.from([0]), Buffer.from(prompt, 'utf8')])),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    writeAtomic(file, output);
    console.log(`EMBEDDED: ${fileArgument} (png tEXt, ${prompt.length} chars)`);
    return;
  }

  if (isJpeg) {
    const segment = Buffer.from(`${KEYWORD}\0${prompt}`, 'utf8');
    if (segment.length + 2 > 0xffff) throw new Error('prompt too long for a JPEG segment');
    const comment = Buffer.alloc(4 + segment.length);
    comment[0] = 0xff;
    comment[1] = 0xfe;
    comment.writeUInt16BE(segment.length + 2, 2);
    segment.copy(comment, 4);
    writeAtomic(file, Buffer.concat([buffer.subarray(0, 2), comment, buffer.subarray(2)]));
    console.log(`EMBEDDED: ${fileArgument} (jpeg COM, ${prompt.length} chars)`);
    return;
  }

  writeAtomic(sidecar, JSON.stringify({ prompt, createdAt: new Date().toISOString() }, null, 2));
  console.log(`EMBEDDED: ${fileArgument}.json (sidecar fallback for this format)`);
}

const runningPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (runningPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`embed-prompt: ${error.message}`);
    process.exit(error?.exitCode || 1);
  }
}
