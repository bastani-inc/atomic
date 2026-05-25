#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const docsDir = path.join(repoRoot, "packages/coding-agent/docs");
const docsJsonPath = path.join(docsDir, "docs.json");

const markdownExtensions = new Set([".md", ".mdx"]);
const externalTargetPattern = /^[a-z][a-z0-9+.-]*:/i;
const markdownPageExtensionPattern = /\.(md|mdx)$/i;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type DocsConfig = {
  navigation?: {
    groups?: JsonValue;
  };
};

type FindingKind = "bad-extension" | "missing-target" | "missing-nav-page";

type Finding = {
  kind: FindingKind;
  file: string;
  line: number;
  target: string;
  suggestion: string;
};

function pushFinding(
  findings: Finding[],
  kind: FindingKind,
  file: string,
  line: number,
  target: string,
  suggestion: string,
): void {
  findings.push({ kind, file, line, target, suggestion });
}

function rel(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function markdownFiles(): string[] {
  return walk(docsDir)
    .filter((file) => markdownExtensions.has(path.extname(file)))
    .sort();
}

function slugForFile(file: string): string {
  const relative = path.relative(docsDir, file);
  return toPosix(relative).replace(markdownPageExtensionPattern, "");
}

function collectDocsJsonPages(value: JsonValue | undefined, pages: string[] = []): string[] {
  if (value === undefined || value === null) return pages;

  if (typeof value === "string") {
    pages.push(value.replace(/^\//, ""));
    return pages;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectDocsJsonPages(item, pages);
    return pages;
  }

  if (typeof value === "object" && value.pages !== undefined) {
    collectDocsJsonPages(value.pages, pages);
  }
  return pages;
}

function splitTarget(rawTarget: string): { target: string; pathPart: string; suffix: string } | null {
  let target = rawTarget.trim();
  if (!target || target.startsWith("#")) return null;

  if (target.startsWith("<")) {
    const close = target.indexOf(">");
    if (close === -1) return null;
    target = target.slice(1, close);
  } else {
    target = target.split(/\s+/)[0] ?? "";
  }

  if (!target || target.startsWith("#") || externalTargetPattern.test(target) || target.startsWith("//")) {
    return null;
  }

  const suffixIndex = target.search(/[?#]/);
  const pathPart = suffixIndex === -1 ? target : target.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : target.slice(suffixIndex);
  if (!pathPart) return null;
  return { target, pathPart, suffix };
}

function docsSlugForTarget(sourceFile: string, pathPart: string): string | null {
  const sourceDir = toPosix(path.relative(docsDir, path.dirname(sourceFile)));
  const targetPath = pathPart.startsWith("/") ? pathPart.slice(1) : path.posix.join(sourceDir, pathPart);
  const normalized = path.posix.normalize(targetPath);

  if (normalized === "." || normalized.startsWith("../")) return null;
  return normalized.replace(markdownPageExtensionPattern, "");
}

function localPathForTarget(sourceFile: string, pathPart: string): string | null {
  if (pathPart.startsWith("/")) return path.join(docsDir, pathPart.slice(1));
  const full = path.resolve(path.dirname(sourceFile), pathPart);
  if (!toPosix(path.relative(docsDir, full)).startsWith("..")) return full;
  return null;
}

function suggestionForMissing(sourceFile: string, pathPart: string, suffix: string, knownSlugs: Set<string>): string {
  const slug = docsSlugForTarget(sourceFile, pathPart);
  if (slug) {
    if (knownSlugs.has(slug)) return `/${slug}${suffix}`;
  }

  const basename = path.posix.basename(pathPart).replace(markdownPageExtensionPattern, "");
  if (knownSlugs.has(basename)) return `/${basename}${suffix}`;

  return "create the target file or update the link";
}

function stripInlineCode(line: string): string {
  let output = "";
  let i = 0;
  let inCode = false;
  while (i < line.length) {
    if (line[i] === "`") {
      const start = i;
      while (i < line.length && line[i] === "`") i++;
      output += " ".repeat(i - start);
      inCode = !inCode;
      continue;
    }
    output += inCode ? " " : line[i];
    i++;
  }
  return output;
}

function validateMarkdownLink(
  file: string,
  lineNumber: number,
  rawTarget: string,
  knownSlugs: Set<string>,
  findings: Finding[],
): void {
  const parsed = splitTarget(rawTarget);
  if (!parsed) return;

  const { target, pathPart, suffix } = parsed;
  const extension = path.posix.extname(pathPart).toLowerCase();
  const isAbsoluteDocsPath = pathPart.startsWith("/");
  const hasMarkdownPageExtension = markdownExtensions.has(extension);
  const docsSlug = docsSlugForTarget(file, pathPart);
  const localPath = localPathForTarget(file, pathPart);

  function addFinding(kind: FindingKind, suggestion: string): void {
    pushFinding(findings, kind, rel(file), lineNumber, target, suggestion);
  }

  if (hasMarkdownPageExtension && docsSlug && knownSlugs.has(docsSlug)) {
    addFinding("bad-extension", `/${docsSlug}${suffix}`);
    return;
  }

  if (isAbsoluteDocsPath && !extension) {
    const route = path.posix.normalize(pathPart.slice(1));
    if (!knownSlugs.has(route)) {
      addFinding("missing-target", "add a docs page to docs.json or update the route");
    }
    return;
  }

  if (isAbsoluteDocsPath && extension) {
    if (localPath && !existsSync(localPath)) {
      addFinding("missing-target", suggestionForMissing(file, pathPart, suffix, knownSlugs));
    }
    return;
  }

  if (!isAbsoluteDocsPath) {
    if (localPath && extension && !existsSync(localPath)) {
      addFinding("missing-target", suggestionForMissing(file, pathPart, suffix, knownSlugs));
    } else if (localPath && !extension && docsSlug && !knownSlugs.has(docsSlug) && !existsSync(localPath)) {
      addFinding("missing-target", "create the target file or use an existing docs route");
    }
  }
}

function validateFile(file: string, knownSlugs: Set<string>, findings: Finding[]): void {
  const linkPattern = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let inFence = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const lineWithoutInlineCode = stripInlineCode(line);
    linkPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(lineWithoutInlineCode))) {
      validateMarkdownLink(file, index + 1, match[1] ?? "", knownSlugs, findings);
    }
  }
}

function main(): number {
  const files = markdownFiles();
  const knownSlugs = new Set(files.map(slugForFile));
  const findings: Finding[] = [];

  const docsConfig = JSON.parse(readFileSync(docsJsonPath, "utf8")) as DocsConfig;
  const navPages = collectDocsJsonPages(docsConfig.navigation?.groups);
  for (const page of navPages) {
    if (!page || page.startsWith("http://") || page.startsWith("https://")) continue;
    if (!knownSlugs.has(page)) {
      pushFinding(
        findings,
        "missing-nav-page",
        rel(docsJsonPath),
        1,
        page,
        `create packages/coding-agent/docs/${page}.md or remove it from docs.json`,
      );
    }
  }

  for (const file of files) validateFile(file, knownSlugs, findings);

  if (findings.length > 0) {
    console.error(`Docs link validation failed with ${findings.length} finding${findings.length === 1 ? "" : "s"}:`);
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} ${finding.kind}: ${finding.target}`);
      console.error(`  suggestion: ${finding.suggestion}`);
    }
    return 1;
  }

  console.log(`Docs link validation passed (${files.length} Markdown/MDX files, ${knownSlugs.size} docs pages).`);
  return 0;
}

process.exit(main());
