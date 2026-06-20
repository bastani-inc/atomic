import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerEntry } from "./types.ts";

export interface ConfigWritePreview {
  path: string;
  existed: boolean;
  changed: boolean;
  beforeText: string;
  afterText: string;
  diffText: string;
}

function serializeRawConfig(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

function buildUnifiedDiff(beforeText: string, afterText: string): string {
  if (beforeText === afterText) return "(no changes)";

  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const rows = before.length;
  const cols = after.length;
  const lcs = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: string[] = ["--- before", "+++ after"];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i++;
      j++;
      continue;
    }
    if (j < cols && (i === rows || lcs[i][j + 1] >= lcs[i + 1][j])) {
      lines.push(`+ ${after[j]}`);
      j++;
      continue;
    }
    if (i < rows) {
      lines.push(`- ${before[i]}`);
      i++;
    }
  }

  return lines.join("\n");
}

export function buildConfigWritePreview(filePath: string, nextRaw: Record<string, unknown>): ConfigWritePreview {
  const existed = existsSync(filePath);
  const beforeRaw = readRawConfigObject(filePath);
  const beforeText = existed ? serializeRawConfig(beforeRaw) : "";
  const afterText = serializeRawConfig(nextRaw);
  return {
    path: filePath,
    existed,
    changed: beforeText !== afterText,
    beforeText,
    afterText,
    diffText: buildUnifiedDiff(beforeText, afterText),
  };
}

export function readRawConfigObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function writeRawConfigObject(filePath: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, filePath);
}

export function getServersObject(raw: Record<string, unknown>): Record<string, ServerEntry> {
  const existing = raw.mcpServers ?? raw["mcp-servers"] ?? {};
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return {};
  }
  return existing as Record<string, ServerEntry>;
}

export function setServersObject(raw: Record<string, unknown>, servers: Record<string, ServerEntry>): void {
  delete raw["mcp-servers"];
  raw.mcpServers = servers;
}

