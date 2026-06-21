import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface GitignoreRule {
  baseDirectory: string;
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  hasSlash: boolean;
  matcher: RegExp;
}

export interface GitignoreMatcher {
  ignores(path: string, isDirectory: boolean): boolean;
}

export function createGitignoreMatcher(root: string): GitignoreMatcher {
  return new WorkspaceGitignoreMatcher(root);
}

class WorkspaceGitignoreMatcher implements GitignoreMatcher {
  private readonly rulesByDirectory = new Map<string, GitignoreRule[]>();

  constructor(private readonly root: string) {}

  ignores(path: string, isDirectory: boolean): boolean {
    const normalizedPath = normalizePath(path).replace(/^\/+/, "").replace(/\/+$/, "");
    let ignored = false;

    for (const directory of ruleDirectoriesFor(normalizedPath, isDirectory)) {
      for (const rule of this.rulesForDirectory(directory)) {
        if (matchesRule(rule, normalizedPath, isDirectory)) {
          ignored = !rule.negated;
        }
      }
    }

    return ignored;
  }

  private rulesForDirectory(relativeDirectory: string): GitignoreRule[] {
    const normalizedDirectory = normalizePath(relativeDirectory).replace(/^\/+|\/+$/g, "");
    const cached = this.rulesByDirectory.get(normalizedDirectory);
    if (cached) return cached;

    const ignorePath = join(this.root, normalizedDirectory, ".gitignore");
    const rules = existsSync(ignorePath)
      ? parseGitignore(readFileSync(ignorePath, "utf8"), normalizedDirectory)
      : [];
    this.rulesByDirectory.set(normalizedDirectory, rules);
    return rules;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function ruleDirectoriesFor(path: string, isDirectory: boolean): string[] {
  const parentDirectory = parentOf(path, isDirectory);
  if (!parentDirectory) return [""];

  const directories = [""];
  let current = "";
  for (const part of parentDirectory.split("/")) {
    current = current ? `${current}/${part}` : part;
    directories.push(current);
  }
  return directories;
}

function parentOf(path: string, isDirectory: boolean): string {
  if (!path) return "";
  const parts = path.split("/");
  if (isDirectory) parts.pop();
  return isDirectory ? parts.join("/") : parts.slice(0, -1).join("/");
}

function parseGitignore(contents: string, baseDirectory: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const rule = parseRuleLine(rawLine, baseDirectory);
    if (rule) rules.push(rule);
  }

  return rules;
}

function parseRuleLine(rawLine: string, baseDirectory: string): GitignoreRule | null {
  let line = trimTrailingUnescapedSpaces(rawLine);
  if (!line || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }
  if (!line) return null;

  line = unescapeLeadingHashOrBang(line);
  const anchored = line.startsWith("/");
  const directoryOnly = line.endsWith("/");
  line = line.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!line) return null;

  const hasSlash = line.includes("/");

  return {
    baseDirectory,
    pattern: line,
    negated,
    directoryOnly,
    anchored,
    hasSlash,
    matcher: globToRegExp(line, hasSlash || anchored),
  };
}

function trimTrailingUnescapedSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === " ") {
    let slashCount = 0;
    for (let index = end - 2; index >= 0 && value[index] === "\\"; index -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 1) break;
    end -= 1;
  }
  return value.slice(0, end);
}

function unescapeLeadingHashOrBang(line: string): string {
  if (line.startsWith("\\#") || line.startsWith("\\!")) return line.slice(1);
  return line;
}

function matchesRule(rule: GitignoreRule, path: string, isDirectory: boolean): boolean {
  const relativePath = relativeToBase(path, rule.baseDirectory);
  if (relativePath === null) return false;

  if (!rule.hasSlash && !rule.anchored) {
    return matchesBasenameRule(rule, relativePath, isDirectory);
  }

  if (rule.directoryOnly) return rule.matcher.test(relativePath);
  return rule.matcher.test(relativePath) || isDirectoryAncestorMatch(rule, relativePath);
}

function relativeToBase(path: string, baseDirectory: string): string | null {
  if (!baseDirectory) return path;
  if (path === baseDirectory) return "";
  const prefix = `${baseDirectory}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function matchesBasenameRule(rule: GitignoreRule, relativePath: string, isDirectory: boolean): boolean {
  const parts = relativePath ? relativePath.split("/") : [""];
  const candidateParts = rule.directoryOnly && !isDirectory ? parts.slice(0, -1) : parts;
  return candidateParts.some((part) => rule.matcher.test(part));
}

function isDirectoryAncestorMatch(rule: GitignoreRule, relativePath: string): boolean {
  const parts = relativePath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    if (rule.matcher.test(parts.slice(0, index).join("/"))) return true;
  }
  return false;
}

function globToRegExp(pattern: string, pathPattern: boolean): RegExp {
  const source = pathPattern ? globPathSource(pattern) : globSegmentSource(pattern);
  const suffix = pathPattern ? "(?:/.*)?" : "";
  return new RegExp(`^${source}${suffix}$`);
}

function globPathSource(pattern: string): string {
  return pattern
    .split("/")
    .map((segment, index, segments) => {
      if (segment === "**") {
        return index === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
      }
      return globSegmentSource(segment);
    })
    .join("/")
    .replace(/(?:\(\?:\[\^\/\]\+\/\)\*\/)+/g, "(?:[^/]+/)*");
}

function globSegmentSource(segment: string): string {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const parsed = parseCharacterClass(segment, index);
      source += parsed.source;
      index = parsed.endIndex;
    } else if (char === "\\" && index + 1 < segment.length) {
      index += 1;
      source += escapeRegExp(segment[index]);
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

function parseCharacterClass(segment: string, startIndex: number): { source: string; endIndex: number } {
  const endIndex = segment.indexOf("]", startIndex + 1);
  if (endIndex === -1) return { source: "\\[", endIndex: startIndex };

  let body = segment.slice(startIndex + 1, endIndex);
  if (body.startsWith("!")) body = `^${body.slice(1)}`;
  return { source: `[${body}]`, endIndex };
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
