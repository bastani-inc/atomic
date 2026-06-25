/** @jsxImportSource @opentui/react */
/**
 * Atomic — Workflow Picker TUI
 *
 * OpenTUI React prototype of the interactive picker that appears when
 * `atomic workflow -a <agent>` is invoked without a workflow name.
 *
 * Run:   bun run research/designs/workflow-picker-tui.tsx -a <agent>
 * Exit:  esc (in pick phase) · ctrl-c (anywhere)
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { CURRENT_AGENT, DEFAULT_PROMPT_INPUT, WORKFLOWS } from "./workflow-picker-data.js";
import { theme } from "./workflow-picker-theme.js";
import { EmptyPreview, FilterBar, Preview, WorkflowList } from "./workflow-picker-list-preview.js";
import { buildEntries, buildRows, isFieldValid } from "./workflow-picker-search.js";
import { ConfirmModal, Header, InputPhase, Statusline } from "./workflow-picker-shell.js";
import type { KeyHint, Phase, WorkflowInput } from "./workflow-picker-types.js";

function workflowFields(workflow: { inputs?: WorkflowInput[] } | undefined): WorkflowInput[] {
  return workflow?.inputs && workflow.inputs.length > 0
    ? workflow.inputs
    : [DEFAULT_PROMPT_INPUT];
}

function seedFieldValues(fields: WorkflowInput[]): Record<string, string> {
  const initial: Record<string, string> = {};
  for (const field of fields) {
    initial[field.name] = field.default ?? (field.type === "enum" ? field.values?.[0] ?? "" : "");
  }
  return initial;
}

function WorkflowPicker() {
  const renderer = useRenderer();
  const [phase, setPhase] = useState<Phase>("pick");
  const [query, setQuery] = useState("");
  const [entryIdx, setEntryIdx] = useState(0);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [focusedFieldIdx, setFocusedFieldIdx] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cursorTick, setCursorTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setCursorTick((c: number) => (c + 1) % 2), 530);
    return () => clearInterval(id);
  }, []);

  const cursorOn = cursorTick === 0;
  const entries = useMemo(() => buildEntries(query, CURRENT_AGENT), [query]);
  const rows = useMemo(() => buildRows(entries, query), [entries, query]);

  useEffect(() => {
    if (entryIdx >= entries.length) setEntryIdx(Math.max(0, entries.length - 1));
  }, [entries.length, entryIdx]);

  const focusedWf = entries[entryIdx]?.workflow;
  const currentFields = workflowFields(focusedWf);
  const currentField = currentFields[focusedFieldIdx];
  const invalidFieldIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < currentFields.length; i++) {
      const field = currentFields[i]!;
      if (!isFieldValid(field, fieldValues[field.name] ?? "")) out.push(i);
    }
    return out;
  }, [currentFields, fieldValues]);
  const isFormValid = invalidFieldIndices.length === 0;

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") { renderer.destroy(); return; }
    if (confirmOpen) {
      if (key.name === "y" || key.name === "return") { renderer.destroy(); return; }
      if (key.name === "n" || key.name === "escape") setConfirmOpen(false);
      return;
    }
    if (phase === "pick") {
      if (key.name === "escape") { renderer.destroy(); return; }
      if (key.name === "up" || (key.ctrl && key.name === "k")) { setEntryIdx((i: number) => Math.max(0, i - 1)); return; }
      if (key.name === "down" || (key.ctrl && key.name === "j")) { setEntryIdx((i: number) => Math.min(entries.length - 1, i + 1)); return; }
      if (key.name === "return") {
        if (focusedWf) {
          const fields = workflowFields(focusedWf);
          setFieldValues(seedFieldValues(fields));
          setFocusedFieldIdx(0);
          setPhase("prompt");
        }
        return;
      }
      if (key.name === "backspace") { setQuery((q: string) => q.slice(0, -1)); return; }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        const c = key.sequence;
        if (c >= " " && c <= "~") setQuery((q: string) => q + c);
      }
      return;
    }

    if (key.name === "escape") { setPhase("pick"); return; }
    if (key.ctrl && key.name === "s") {
      if (!isFormValid) { setFocusedFieldIdx(invalidFieldIndices[0]!); return; }
      setConfirmOpen(true);
      return;
    }
    if (key.name === "tab") {
      setFocusedFieldIdx((i: number) => {
        const len = currentFields.length;
        if (len <= 1) return 0;
        return key.shift ? (i - 1 + len) % len : (i + 1) % len;
      });
      return;
    }
    if (!currentField) return;
    if (currentField.type === "enum") {
      const values = currentField.values ?? [];
      if (values.length === 0) return;
      if (key.name === "left" || key.name === "right") {
        setFieldValues((prev: Record<string, string>) => {
          const cur = prev[currentField.name] ?? values[0] ?? "";
          const idx = Math.max(0, values.indexOf(cur));
          const nextIdx = (idx + (key.name === "left" ? -1 : 1) + values.length) % values.length;
          return { ...prev, [currentField.name]: values[nextIdx] ?? "" };
        });
      }
      return;
    }
    if (key.name === "return") {
      if (currentField.type === "text") {
        setFieldValues((prev: Record<string, string>) => ({ ...prev, [currentField.name]: (prev[currentField.name] ?? "") + "\n" }));
      } else {
        setFocusedFieldIdx((i: number) => Math.min(currentFields.length - 1, i + 1));
      }
      return;
    }
    if (key.name === "backspace") {
      setFieldValues((prev: Record<string, string>) => ({ ...prev, [currentField.name]: (prev[currentField.name] ?? "").slice(0, -1) }));
      return;
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      const c = key.sequence;
      if (c >= " " && c <= "~") setFieldValues((prev: Record<string, string>) => ({ ...prev, [currentField.name]: (prev[currentField.name] ?? "") + c }));
    }
  });

  const pickHints: KeyHint[] = [{ key: "↑↓", label: "navigate" }, { key: "↵", label: "select" }, { key: "esc", label: "quit" }];
  const promptHints: KeyHint[] = [{ key: "tab", label: "to navigate forward" }, { key: "shift+tab", label: "to navigate backward" }, { key: "ctrl+s", label: "to run", dim: !isFormValid }];
  const confirmHints: KeyHint[] = [{ key: "y", label: "submit" }, { key: "n", label: "cancel" }];
  const hints = confirmOpen ? confirmHints : phase === "pick" ? pickHints : promptHints;

  return (
    <box position="relative" width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      <Header phase={phase} confirmOpen={confirmOpen} selectedAgent={CURRENT_AGENT} scopedCount={WORKFLOWS.filter((w) => w.agents.includes(CURRENT_AGENT)).length} />
      {phase === "pick" ? (
        <box flexGrow={1} flexDirection="row" paddingLeft={2} paddingRight={2} paddingTop={1}>
          <box width={36} flexDirection="column"><FilterBar query={query} count={entries.length} cursorOn={cursorOn} /><box height={1} /><WorkflowList rows={rows} focusedEntryIdx={entryIdx} /></box>
          <box width={1} backgroundColor={theme.border} />
          <box flexGrow={1} flexDirection="column">{focusedWf ? <Preview wf={focusedWf} /> : <EmptyPreview query={query} />}</box>
        </box>
      ) : phase === "prompt" && focusedWf ? (
        <InputPhase workflow={focusedWf} agent={CURRENT_AGENT} fields={currentFields} values={fieldValues} focusedFieldIdx={focusedFieldIdx} cursorOn={cursorOn} />
      ) : null}
      <Statusline phase={phase} confirmOpen={confirmOpen} hints={hints} focusedWf={focusedWf} />
      {confirmOpen && focusedWf ? <ConfirmModal workflow={focusedWf} agent={CURRENT_AGENT} fields={currentFields} values={fieldValues} /> : null}
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<WorkflowPicker />);
