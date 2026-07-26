import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = "packages/workflows/builtin";
const rows: string[] = [];
for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts")).sort()) {
  const path = join(directory, file);
  const lines = readFileSync(path, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const declaration = line.match(/^export\s+(default\s+)?(declare\s+)?(async\s+)?(const|let|var|function|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/);
    if (declaration) {
      const kind = declaration[4] === "let" || declaration[4] === "var" ? "const" : declaration[4];
      rows.push(`${path}:${kind} ${declaration[1] ? "default" : declaration[5]}`);
      continue;
    }
    if (/^export\s+default\b/.test(line)) {
      rows.push(`${path}:default default`);
      continue;
    }
    if (!/^export\s+(type\s+)?\{/.test(line)) continue;
    let block = line;
    while (!/\}\s*(from\s+[^;]+)?;?\s*$/.test(block) && index + 1 < lines.length) block += `\n${lines[index += 1]}`;
    const body = block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
    for (const raw of body.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const typeOnly = /^type\s+/.test(item) || /^export\s+type\s+/.test(line);
      const clean = item.replace(/^type\s+/, "").trim();
      const parts = clean.split(/\s+as\s+/);
      rows.push(`${path}:${typeOnly ? "type-re-export" : "re-export"} ${(parts[1] ?? parts[0]).trim()}`);
    }
  }
}
console.log("# command: bun .atomic/research/prompt-opt/baseline/export-inventory-rerun.ts > .atomic/research/prompt-opt/baseline/exports.txt");
console.log(rows.sort().join("\n"));
