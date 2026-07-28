import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const files = [
  ...readdirSync("packages/subagents/agents").filter((f) => f.endsWith(".md")).map((f) => join("packages/subagents/agents", f)),
  ...readdirSync("packages/subagents/prompts").filter((f) => f.endsWith(".md")).map((f) => join("packages/subagents/prompts", f)),
  ...readdirSync("packages/workflows/builtin").filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")).map((f) => join("packages/workflows/builtin", f)),
  "packages/workflows/skills/prompt-engineer/SKILL.md",
  ...readdirSync("packages/workflows/skills/prompt-engineer/references").filter((f) => f.endsWith(".md")).map((f) => join("packages/workflows/skills/prompt-engineer/references", f)),
].sort();
const promptTs = /(?:prompts|shared-prompts|ralph-core|ralph-reviewer-prompt|ralph-forked-prompts|ralph-runner|goal-prompts|goal-orchestrator-prompts|goal-runner|goal-review|review-convergence|open-claude-design-(?:setup|phases|feedback|utils|runner)|adversarial-verification-runner)\.ts$/;
let total = 0;
console.log("# Semantic rule inventory\n");
console.log("> Baseline checklist generated from every in-scope file. Entries preserve source wording where compression could hide a distinct condition. Frontmatter is separately preserved byte-for-byte in `frontmatter.txt`.\n");
for (const path of files) {
  const source = readFileSync(path, "utf8");
  const candidates: string[] = [];
  if (path.endsWith(".md")) {
    let yaml = false;
    let fences = false;
    for (const [index, raw] of source.split("\n").entries()) {
      if (index === 0 && raw === "---") { yaml = true; continue; }
      if (yaml) { if (raw === "---") yaml = false; continue; }
      if (/^```/.test(raw.trim())) { fences = !fences; continue; }
      if (fences || /^\s*$/.test(raw) || /^#{1,6}\s/.test(raw)) continue;
      let text = raw.trim().replace(/^[-*+]\s+/, "").replace(/^\d+[a-z]?\.\s+/, "").replace(/^>\s?/, "");
      if (/^\|?\s*:?-+/.test(text) || text === "---" || text.length < 10) continue;
      text = text.replace(/^\*\*([^*]+)\*\*:?\s*/, "$1: ").replace(/\s+/g, " ");
      candidates.push(text);
    }
  } else if (promptTs.test(path)) {
    for (const raw of source.split("\n")) {
      const line = raw.trim();
      for (const match of line.matchAll(/"((?:[^"\\]|\\.){12,})"/g)) candidates.push(match[1].replace(/\\n/g, " "));
      const template = line.match(/`([^`]{12,})`/);
      if (template) candidates.push(template[1]);
      if (/^\/\//.test(line) && /(?:must|only|never|always|when|before|after|so |means|requires|stops|approv|block|fallback|preserv|prompt|review)/i.test(line)) candidates.push(line.replace(/^\/\/\s?/, ""));
    }
  }
  const seen = new Set<string>();
  const rules = candidates.map((item) => item.replace(/\\`/g, "`").replace(/\\"/g, '"').trim()).filter((item) => {
    const key = item.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ");
    if (key.length < 10 || seen.has(key)) return false;
    seen.add(key); return true;
  });
  console.log(`## ${path}\n`);
  if (rules.length === 0) {
    console.log("R1. No model-facing instruction rule; runtime plumbing/schema behavior only.\n");
    total += 1;
  } else {
    rules.forEach((rule, index) => console.log(`R${index + 1}. ${rule}`));
    console.log(); total += rules.length;
  }
}
console.log(`## Total\n\nDistinct checklist entries: **${total}**`);
