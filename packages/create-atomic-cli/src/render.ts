/**
 * Tiny template renderer. Substitutes `{{key}}` placeholders with values
 * from a vars object. No nesting, no logic, no escapes — keep templates
 * mechanical and readable.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Vars = Record<string, string>;

const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

export function render(template: string, vars: Vars): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Template missing variable: {{${key}}}`);
    }
    return vars[key]!;
  });
}

/**
 * Recursively render every `*.tpl` under `srcDir` into `dstDir`, stripping
 * the `.tpl` suffix. Non-`.tpl` files are copied verbatim.
 */
export function renderTree(srcDir: string, dstDir: string, vars: Vars): void {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const outName = entry.name.endsWith(".tpl")
      ? entry.name.slice(0, -".tpl".length)
      : entry.name;
    const dstPath = path.join(dstDir, outName);
    if (entry.isDirectory()) {
      renderTree(srcPath, dstPath, vars);
      continue;
    }
    if (entry.name.endsWith(".tpl")) {
      const text = readFileSync(srcPath, "utf8");
      writeFileSync(dstPath, render(text, vars), "utf8");
    } else {
      writeFileSync(dstPath, readFileSync(srcPath));
    }
  }
}
