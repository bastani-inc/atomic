import { WORKFLOWS } from "./workflow-picker-data.js";
import type { AgentType, ListEntry, ListRow, Source, Workflow } from "./workflow-picker-types.js";

export function fuzzyMatch(query: string, target: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === q[qi]) { found = ti; break; }
      ti++;
    }
    if (found === -1) return null;
    score += found === prev + 1 ? 1 : 4 + (found - prev);
    prev = found;
    ti++;
  }
  return score;
}

export function buildEntries(query: string, agent: AgentType): ListEntry[] {
  const scored: { wf: Workflow; score: number }[] = [];
  for (const wf of WORKFLOWS) {
    if (!wf.agents.includes(agent)) continue;
    const nameScore = fuzzyMatch(query, wf.name);
    const descScore = fuzzyMatch(query, wf.description);
    const best = nameScore !== null && descScore !== null
      ? Math.min(nameScore, descScore + 2)
      : nameScore !== null ? nameScore
      : descScore !== null ? descScore + 2
      : null;
    if (best !== null) scored.push({ wf, score: best });
  }

  if (query === "") {
    const entries: ListEntry[] = [];
    for (const source of ["local", "global", "builtin"] as Source[]) {
      const group = scored
        .filter((s) => s.wf.source === source)
        .sort((a, b) => a.wf.name.localeCompare(b.wf.name));
      for (const s of group) entries.push({ workflow: s.wf, section: source });
    }
    return entries;
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => ({ workflow: s.wf, section: s.wf.source }));
}

export function buildRows(entries: ListEntry[], query: string): ListRow[] {
  const rows: ListRow[] = [];
  if (query === "") {
    let lastSection: string | null = null;
    for (const entry of entries) {
      if (entry.section !== lastSection) {
        rows.push({ kind: "section", source: entry.section });
        lastSection = entry.section;
      }
      rows.push({ kind: "entry", entry });
    }
  } else {
    for (const entry of entries) rows.push({ kind: "entry", entry });
  }
  return rows;
}

export function isFieldValid(field: { required?: boolean; type: string }, value: string): boolean {
  if (!field.required) return true;
  if (field.type === "enum") return value !== "";
  return value.trim() !== "";
}
