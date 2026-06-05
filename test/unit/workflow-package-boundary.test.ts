import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import * as ts from "typescript";

interface BoundaryViolation {
  readonly file: string;
  readonly specifier: string;
}

const repoRoot = resolve(import.meta.dir, "../..");
const workflowsSourceRoot = resolve(repoRoot, "packages/workflows/src");
const codingAgentSourceImportPatterns: readonly RegExp[] = [
  /(?:^|\/)packages\/coding-agent\/src(?:\/|$)/,
  /(?:^|\/)(?:\.\.\/)+coding-agent\/src(?:\/|$)/,
];

async function collectTypeScriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

function getStaticImportSpecifiers(filePath: string, sourceText: string): readonly string[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  return specifiers;
}

function isCodingAgentSourceImport(specifier: string): boolean {
  const normalizedSpecifier = specifier.replace(/\\/g, "/");
  return codingAgentSourceImportPatterns.some((pattern) => pattern.test(normalizedSpecifier));
}

function repoRelativePath(filePath: string): string {
  return relative(repoRoot, filePath).split(sep).join("/");
}

describe("workflow package boundary", () => {
  test("workflows source imports coding-agent APIs only through package public surfaces", async () => {
    const violations: BoundaryViolation[] = [];

    for (const filePath of await collectTypeScriptFiles(workflowsSourceRoot)) {
      const sourceText = await readFile(filePath, "utf8");
      for (const specifier of getStaticImportSpecifiers(filePath, sourceText)) {
        if (isCodingAgentSourceImport(specifier)) {
          violations.push({ file: repoRelativePath(filePath), specifier });
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      "packages/workflows/src must not import packages/coding-agent/src internals",
    );
  });
});
