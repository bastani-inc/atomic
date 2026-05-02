/** @jsxImportSource @opentui/react */
/**
 * WorkflowPickerPanel — interactive TUI for `atomic workflow -a <agent>`.
 *
 * Telescope-style fuzzy picker with a two-phase flow:
 *
 *   1. PICK   — filter workflows scoped to the current agent, navigate with
 *               ↑/↓ or ⌃j/⌃k, press ↵ to lock in a selection.
 *   2. PROMPT — fill the workflow's declared input schema (one field per
 *               declared `WorkflowInput`). Free-form workflows fall back to
 *               a single `prompt` text field.
 *
 * Pressing ⌃d in the prompt phase validates required fields and opens a
 * CONFIRM modal that shows the fully-composed shell command before
 * submission. y/↵ confirms, n/esc cancels back to the form.
 *
 * Lifecycle:
 *
 *   const panel = await WorkflowPickerPanel.create({ agent, registry });
 *   const result = await panel.waitForSelection();
 *   panel.destroy();
 *   if (result) await executeWorkflow({ ... });
 *
 * `waitForSelection()` resolves with `null` if the user exits without
 * committing (esc in PICK phase, or ⌃c anywhere) and with a
 * `{ workflow, inputs }` record if they confirm the run.
 */

import {
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  type Root,
} from "@opentui/react";
import { useState, useEffect, useMemo, useRef, useCallback, useContext, createContext, memo } from "react";
import { useLatest } from "./hooks.ts";
import { resolveTheme, type TerminalTheme } from "../runtime/theme.ts";
import type { AgentType, WorkflowInput, WorkflowDefinition, Registry } from "../types.ts";
import { ErrorBoundary } from "./error-boundary.tsx";
import {
  requestRendererBackgroundRepaint,
  resetRendererTerminalBackground,
  setRendererBackground,
} from "./renderer-background.ts";

// ─── Theme ──────────────────────────────────────
// The picker uses a slightly extended palette vs. the base terminal theme:
// an `info` (sky) hue for built-in workflows and a `mauve` hue for global
// ones — the same distinctions `atomic workflow list` already draws. The
// rest is sourced from {@link resolveTheme} so light/dark mode tracks the
// orchestrator panel.
export interface PickerTheme {
  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  surface: string;
  text: string;
  textMuted: string;
  textDim: string;
  primary: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  mauve: string;
  border: string;
  borderActive: string;
}

export function buildPickerTheme(base: TerminalTheme): PickerTheme {
  return {
    background: base.bg,
    backgroundPanel: base.backgroundPanel,
    backgroundElement: base.backgroundElement,
    surface: base.surface,
    text: base.text,
    textMuted: base.textMuted,
    textDim: base.dim,
    primary: base.accent,
    success: base.success,
    error: base.error,
    warning: base.warning,
    info: base.info,
    mauve: base.mauve,
    border: base.borderDim,
    borderActive: base.border,
  };
}

// ─── Theme Context ─────────────────────────────
// Avoids drilling `theme` through every component in the tree.

const PickerThemeContext = createContext<PickerTheme | null>(null);

function usePickerTheme(): PickerTheme {
  const theme = useContext(PickerThemeContext);
  if (!theme) throw new Error("usePickerTheme must be used within a PickerThemeContext provider");
  return theme;
}

// ─── Types ──────────────────────────────────────

type Phase = "pick" | "prompt";

/** The payload the picker resolves with on successful submission. */
export interface WorkflowPickerResult {
  /** The workflow the user committed to running. */
  workflow: WorkflowDefinition;
  /** Populated form values, one per declared input (or { prompt } for free-form). */
  inputs: Record<string, string>;
}

// ─── Helpers ────────────────────────────────────

/** Per-agent display color in the picker list / section headers. */
const AGENT_COLOR: Record<AgentType, keyof PickerTheme> = {
  claude: "warning",
  copilot: "success",
  opencode: "mauve",
};

/**
 * Subsequence fuzzy match — Telescope-style. Returns a score (lower =
 * better) or null for no match. Adjacent matches are rewarded; jumps over
 * non-matching characters are penalized proportionally to the gap.
 */
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
      if (t[ti] === q[qi]) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found === -1) return null;
    score += found === prev + 1 ? 1 : 4 + (found - prev);
    prev = found;
    ti++;
  }
  return score;
}

// ─── List Building ──────────────────────────────

interface ListEntry {
  workflow: WorkflowDefinition;
  /** Agent the workflow belongs to — used for section grouping. */
  section: AgentType;
}

type ListRow =
  | { kind: "section"; agent: AgentType }
  | { kind: "entry"; entry: ListEntry };

export function buildEntries(
  query: string,
  workflows: WorkflowDefinition[],
): ListEntry[] {
  type Scored = { wf: WorkflowDefinition; score: number };
  const scored: Scored[] = [];
  for (const wf of workflows) {
    const nameScore = fuzzyMatch(query, wf.name);
    const descScore = fuzzyMatch(query, wf.description);
    const best =
      nameScore !== null && descScore !== null
        ? Math.min(nameScore, descScore + 2)
        : nameScore !== null
          ? nameScore
          : descScore !== null
            ? descScore + 2
            : null;
    if (best !== null) scored.push({ wf, score: best });
  }

  if (query === "") {
    const rest: ListEntry[] = [];
    for (const agent of ["claude", "copilot", "opencode"] as AgentType[]) {
      const group = scored
        .filter((s) => s.wf.agent === agent)
        .sort((a, b) => a.wf.name.localeCompare(b.wf.name));
      for (const s of group) rest.push({ workflow: s.wf, section: agent });
    }
    return rest;
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.map<ListEntry>((s) => ({
    workflow: s.wf,
    section: s.wf.agent,
  }));
}

export function buildRows(entries: ListEntry[], query: string): ListRow[] {
  const rows: ListRow[] = [];
  if (query === "") {
    let lastSection: string | null = null;
    for (const e of entries) {
      if (e.section !== lastSection) {
        rows.push({ kind: "section", agent: e.section });
        lastSection = e.section;
      }
      rows.push({ kind: "entry", entry: e });
    }
  } else {
    for (const e of entries) rows.push({ kind: "entry", entry: e });
  }
  return rows;
}

// ─── Validation ─────────────────────────────────

export function isFieldValid(field: WorkflowInput, value: string): boolean {
  if (field.type === "integer") {
    const trimmed = value.trim();
    if (trimmed === "") return !field.required;
    const parsed = Number.parseInt(trimmed, 10);
    return (
      Number.isFinite(parsed) &&
      Number.isInteger(parsed) &&
      String(parsed) === trimmed
    );
  }
  if (!field.required) return true;
  if (field.type === "enum") return value !== "";
  return value.trim() !== "";
}

// ─── Components ─────────────────────────────────

const SectionLabel = memo(function SectionLabel({
  label,
}: {
  label: string;
}) {
  const theme = usePickerTheme();
  return (
    <box height={1} flexDirection="row">
      <text>
        <span fg={theme.mauve}>▎ </span>
        <span fg={theme.textMuted}>
          <strong>{label}</strong>
        </span>
      </text>
    </box>
  );
});

function FilterBar({
  query,
  focused,
  onInput,
}: {
  query: string;
  focused: boolean;
  onInput: (value: string) => void;
}) {
  const theme = usePickerTheme();
  return (
    <box
      minHeight={3}
      border
      borderStyle="rounded"
      borderColor={theme.borderActive}
      backgroundColor={theme.backgroundPanel}
      flexDirection="row"
      paddingLeft={2}
      paddingRight={2}
      alignItems="center"
    >
      <text>
        <span fg={theme.primary}>
          <strong>❯ </strong>
        </span>
      </text>
      <input
        value={query}
        focused={focused}
        onInput={onInput}
        textColor={theme.text}
        backgroundColor={theme.backgroundPanel}
        focusedBackgroundColor={theme.backgroundPanel}
        focusedTextColor={theme.text}
        flexGrow={1}
      />
    </box>
  );
}

const WorkflowList = memo(function WorkflowList({
  rows,
  focusedEntryIdx,
}: {
  rows: ListRow[];
  focusedEntryIdx: number;
}) {
  const theme = usePickerTheme();
  // Pre-compute entry indices so the render pass is side-effect-free.
  // Must live before any early return to satisfy the Rules of Hooks.
  const entryIndexByRow = useMemo(() => {
    const map = new Map<number, number>();
    let counter = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row && row.kind === "entry") {
        map.set(i, counter++);
      }
    }
    return map;
  }, [rows]);

  if (rows.length === 0) {
    return (
      <box paddingLeft={2} paddingTop={2} backgroundColor={theme.backgroundPanel}>
        <text>
          <span fg={theme.textDim}>no matches</span>
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" backgroundColor={theme.backgroundPanel}>
      {rows.map((row, i) => {
        if (row.kind === "section") {
          const ag = row.agent;
          return (
            <box
              key={`section-${ag}`}
              height={2}
              paddingTop={1}
              paddingLeft={2}
              backgroundColor={theme.backgroundPanel}
            >
              <text>
                <span fg={theme[AGENT_COLOR[ag]]}>
                  {ag}
                </span>
              </text>
            </box>
          );
        }
        const entryIdx = entryIndexByRow.get(i) ?? -1;
        const isFocused = entryIdx === focusedEntryIdx;
        const wf = row.entry.workflow;
        const nameCol = isFocused ? theme.text : theme.textMuted;

        return (
          <box
            key={`wf-${wf.agent}-${wf.name}`}
            height={1}
            flexDirection="row"
            backgroundColor={isFocused ? theme.border : theme.backgroundPanel}
            paddingLeft={1}
            paddingRight={2}
          >
            <text>
              <span fg={isFocused ? theme.primary : theme.textDim}>
                {isFocused ? "▸ " : "  "}
              </span>
              <span fg={nameCol}>
                {wf.name}
              </span>
            </text>
          </box>
        );
      })}
    </box>
  );
});

const ArgumentRow = memo(function ArgumentRow({
  field,
}: {
  field: WorkflowInput;
}) {
  const theme = usePickerTheme();
  const isRequired = field.required ?? false;
  const tagCol = isRequired ? theme.warning : theme.textDim;
  const tagLabel = isRequired ? "required" : "optional";
  const enumValues =
    field.type === "enum" && field.values && field.values.length > 0
      ? field.values
      : null;

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2}>
      <box flexDirection="row" height={1}>
        <text>
          <span fg={theme.text}>{field.name}</span>
        </text>
        <box flexGrow={1} />
        <text>
          <span fg={theme.textDim}>{field.type}</span>
          <span fg={theme.textDim}>{"  ·  "}</span>
          <span fg={tagCol}>{tagLabel}</span>
        </text>
      </box>

      {field.description ? (
        <box height={1}>
          <text>
            <span fg={theme.textMuted}>{field.description}</span>
          </text>
        </box>
      ) : null}

      {enumValues ? (
        <box height={1}>
          <text>
            <span fg={theme.textDim}>{enumValues.join("  ·  ")}</span>
          </text>
        </box>
      ) : null}

      <box height={1} />
    </box>
  );
});

const Preview = memo(function Preview({
  wf,
}: {
  wf: WorkflowDefinition;
}) {
  const theme = usePickerTheme();
  const args = wf.inputs;

  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingRight={3}
      paddingTop={1}
    >
      <text>
        <span fg={theme.text}>
          <strong>{wf.name}</strong>
        </span>
      </text>

      <box height={1} />

      <text>
        <span fg={theme[AGENT_COLOR[wf.agent]]}>
          {wf.agent}
        </span>
      </text>

      <box height={2} />

      <text>
        <span fg={theme.textMuted}>
          {wf.description || "(no description)"}
        </span>
      </text>

      {args.length > 0 && (
        <>
          <box height={2} />
          <SectionLabel label="ARGUMENTS" />
          <box height={1} />
          {args.map((f) => (
            <ArgumentRow key={f.name} field={f} />
          ))}
        </>
      )}
    </box>
  );
});

function EmptyPreview({
  query,
}: {
  query: string;
}) {
  const theme = usePickerTheme();
  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingRight={3}
      paddingTop={3}
    >
      <text>
        <span fg={theme.textMuted}>No workflows match </span>
        <span fg={theme.text}>"{query}"</span>
      </text>
      <box height={2} />
      <text>
        <span fg={theme.textDim}>
          Press backspace to widen your search, or
        </span>
      </text>
      <box height={2} />
      <text>
        <span fg={theme.textDim}>
          define one with{" "}
        </span>
        <span fg={theme.primary}>defineWorkflow(...).for&lt;"agent"&gt;(...)</span>
        <span fg={theme.textDim}>,</span>
      </text>
      <box height={1} />
      <text>
        <span fg={theme.textDim}>
          then register and start it via{" "}
        </span>
        <span fg={theme.primary}>createRegistry().register(wf)</span>
      </text>
      <box height={1} />
      <text>
        <span fg={theme.textDim}>{"and "}</span>
        <span fg={theme.primary}>createWorkflowCli(registry).run()</span>
        <span fg={theme.textDim}>{" in your entrypoint"}</span>
      </text>
    </box>
  );
}

// ─── Field renderers ────────────────────────────

const TEXT_FIELD_LINES = 3;

function TextAreaContent({
  value,
  placeholder,
  focused,
  onInput,
}: {
  value: string;
  placeholder: string;
  focused: boolean;
  onInput: (value: string) => void;
}) {
  const theme = usePickerTheme();
  const backgroundColor = focused ? theme.backgroundPanel : theme.backgroundElement;
  const instanceRef = useRef<TextareaRenderable | null>(null);
  const onInputRef = useLatest(onInput);
  const lastTextRef = useRef(value);

  // Read plainText on the next microtask so the textarea has applied the
  // keystroke/paste before we observe its content, then fire onInput if
  // it changed.
  const flushPending = useCallback(() => {
    queueMicrotask(() => {
      const inst = instanceRef.current;
      if (!inst) return;
      const current = inst.plainText;
      if (current !== lastTextRef.current) {
        lastTextRef.current = current;
        onInputRef.current(current);
      }
    });
  }, []);

  const refCallback = useCallback((instance: TextareaRenderable | null) => {
    instanceRef.current = instance;
  }, []);

  // Sync external value → textarea when it diverges (e.g. initial value
  // or reset after phase transition).
  useEffect(() => {
    if (instanceRef.current && instanceRef.current.plainText !== value) {
      instanceRef.current.setText(value);
      lastTextRef.current = value;
    }
  }, [value]);

  // flushPending fires on each keystroke via useKeyboard; onPaste handles
  // bracketed pastes (which don't fire keydown). The native Zig edit
  // buffer's "content-changed" event is unreliable for propagating to the
  // JS _contentChangeListener in certain installed environments, so we
  // hook into useKeyboard (which fires before the textarea processes the
  // key) and defer the read with queueMicrotask so the textarea has
  // processed the keystroke by the time we read plainText.
  useKeyboard(flushPending);

  return (
    <textarea
      ref={refCallback}
      initialValue={value}
      placeholder={placeholder}
      focused={focused}
      textColor={theme.text}
      backgroundColor={backgroundColor}
      focusedBackgroundColor={backgroundColor}
      focusedTextColor={theme.text}
      placeholderColor={theme.textDim}
      wrapMode="word"
      flexGrow={1}
      onPaste={flushPending}
    />
  );
}

function StringContent({
  value,
  placeholder,
  focused,
  onInput,
}: {
  value: string;
  placeholder: string;
  focused: boolean;
  onInput: (value: string) => void;
}) {
  const theme = usePickerTheme();
  const backgroundColor = focused ? theme.backgroundPanel : theme.backgroundElement;
  return (
    <input
      value={value}
      placeholder={placeholder}
      focused={focused}
      onInput={onInput}
      textColor={theme.text}
      backgroundColor={backgroundColor}
      focusedBackgroundColor={backgroundColor}
      focusedTextColor={theme.text}
      flexGrow={1}
    />
  );
}

function EnumContent({
  values,
  selected,
  focused,
}: {
  values: readonly string[];
  selected: string;
  focused: boolean;
}) {
  const theme = usePickerTheme();
  return (
    <box height={1} flexDirection="row">
      {values.map((v, i) => {
        const isSelected = v === selected;
        const marker = isSelected ? "●" : "○";
        const markerColor = isSelected
          ? focused
            ? theme.primary
            : theme.success
          : theme.textDim;
        const textColor = isSelected
          ? focused
            ? theme.text
            : theme.textMuted
          : theme.textDim;
        return (
          <box
            key={v}
            flexDirection="row"
            paddingLeft={i > 0 ? 3 : 0}
            height={1}
          >
            <text>
              <span fg={markerColor}>{marker} </span>
              <span fg={textColor}>{v}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

const Field = memo(function Field({
  id,
  field,
  value,
  focused,
  onFieldInput,
}: {
  id?: string;
  field: WorkflowInput;
  value: string;
  focused: boolean;
  onFieldInput: (fieldName: string, value: string) => void;
}) {
  const theme = usePickerTheme();
  const borderCol = focused ? theme.primary : theme.border;
  const bgCol = focused ? theme.backgroundPanel : theme.backgroundElement;

  const boxHeight = field.type === "text" ? TEXT_FIELD_LINES + 2 : 3;

  const tagCol = field.required ? theme.warning : theme.textDim;
  const tagLabel = field.required ? "required" : "optional";
  const captionDesc = field.description ? "  ·  " + field.description : "";

  // Bind the field name once so the parent doesn't need a per-field closure.
  const onInput = useCallback(
    (v: string) => onFieldInput(field.name, v),
    [onFieldInput, field.name],
  );

  return (
    <box id={id} flexDirection="column">
      <box
        border
        borderStyle="rounded"
        borderColor={borderCol}
        backgroundColor={bgCol}
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        minHeight={boxHeight}
        justifyContent={field.type === "text" ? "flex-start" : "center"}
        title={` ${field.name} `}
        titleAlignment="left"
      >
        {field.type === "text" ? (
          <TextAreaContent
            value={value}
            placeholder={field.placeholder ?? ""}
            focused={focused}
            onInput={onInput}
          />
        ) : field.type === "string" || field.type === "integer" ? (
          <StringContent
            value={value}
            placeholder={field.placeholder ?? ""}
            focused={focused}
            onInput={onInput}
          />
        ) : field.type === "enum" ? (
          <EnumContent
            values={field.values ?? []}
            selected={value}
            focused={focused}
          />
        ) : null}
      </box>

      <box paddingLeft={2} paddingRight={2} height={1}>
        <text>
          <span fg={theme.textDim}>{field.type}</span>
          <span fg={theme.textDim}>{"  ·  "}</span>
          <span fg={tagCol}>{tagLabel}</span>
          <span fg={theme.textDim}>{captionDesc}</span>
        </text>
      </box>

      <box height={1} />
    </box>
  );
});

function InputPhase({
  workflow,
  agent,
  fields,
  values,
  focusedFieldIdx,
  onFieldInput,
}: {
  workflow: WorkflowDefinition;
  agent: AgentType;
  fields: readonly WorkflowInput[];
  values: Record<string, string>;
  focusedFieldIdx: number;
  onFieldInput: (fieldName: string, value: string) => void;
}) {
  const theme = usePickerTheme();
  const isStructured = workflow.inputs.length > 0;
  const scrollboxRef = useRef<ScrollBoxRenderable>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Auto-scroll to keep the focused field visible.
  // Sync scrollTop immediately so the visibility check below
  // marks the field as visible on the same render pass.
  useEffect(() => {
    const sb = scrollboxRef.current;
    const field = fields[focusedFieldIdx];
    if (!sb || !field) return;
    sb.scrollChildIntoView(`field-${field.name}`);
    setScrollTop(sb.scrollTop);
  }, [focusedFieldIdx, fields]);

  // Sync scrollTop on every OpenTUI render frame via renderBefore.
  // This replaces a polling timer — it fires at the renderer's native
  // frame rate so the focused field defocuses within one frame of
  // scrolling out of view, preventing the terminal cursor from
  // bleeding into the fixed header above.
  const syncScrollFrame = useCallback(function (this: unknown) {
    const sb = scrollboxRef.current;
    if (!sb) return;
    setScrollTop((prev) => {
      const cur = sb.scrollTop;
      return cur !== prev ? cur : prev;
    });
  }, []);

  // The bordered content box (where the cursor lives) must be fully
  // inside the viewport. If even one row is clipped the field loses
  // focus so the cursor can never land in a clipped row.
  const isFocusedFieldVisible = useMemo(() => {
    const sb = scrollboxRef.current;
    if (!sb) return true;
    const vpH = sb.viewport.height;
    if (vpH <= 0) return true;
    let y = 0;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      const inputH = f.type === "text" ? TEXT_FIELD_LINES + 2 : 3;
      if (i === focusedFieldIdx) {
        return y >= scrollTop && y + inputH <= scrollTop + vpH;
      }
      // Caption row (1) + spacer row (1) below the bordered box.
      y += inputH + 2;
    }
    return true;
  }, [fields, focusedFieldIdx, scrollTop]);

  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingRight={3}
      paddingTop={2}
      flexGrow={1}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.backgroundPanel}
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <text>
          <span fg={theme.primary}>
            <strong>▸ </strong>
          </span>
          <span fg={theme.text}>
            <strong>{workflow.name}</strong>
          </span>
          <span fg={theme.textDim}>{"  ·  "}</span>
          <span fg={theme.mauve}>{agent}</span>
        </text>
        <box height={1} />
        <text>
          <span fg={theme.textMuted}>
            {workflow.description || "(no description)"}
          </span>
        </text>
      </box>

      <box height={2} />

      <box flexDirection="row" height={1}>
        <text>
          <span fg={theme.textDim}>
            <strong>INPUTS</strong>
          </span>
        </text>
        <box flexGrow={1} />
        <text>
          <span fg={theme.textDim}>
            {isStructured ? `${focusedFieldIdx + 1} / ${fields.length}` : ""}
          </span>
        </text>
      </box>
      <box height={1} />

      <scrollbox
        ref={scrollboxRef}
        scrollY
        viewportCulling
        flexGrow={1}
        renderBefore={syncScrollFrame}
        style={{
          rootOptions: {
            backgroundColor: theme.background,
            border: false,
          },
          contentOptions: {
            flexDirection: "column",
          },
          verticalScrollbarOptions: {
            showArrows: false,
            trackOptions: {
              foregroundColor: theme.border,
              backgroundColor: theme.backgroundElement,
            },
          },
        }}
      >
        {fields.map((f, i) => {
          const active = i === focusedFieldIdx && isFocusedFieldVisible;
          return (
            <Field
              key={f.name}
              id={`field-${f.name}`}
              field={f}
              value={values[f.name] ?? ""}
              focused={active}
              onFieldInput={onFieldInput}
            />
          );
        })}
      </scrollbox>
    </box>
  );
}

function ConfirmModal({
  workflow,
  agent,
}: {
  workflow: WorkflowDefinition;
  agent: AgentType;
}) {
  const theme = usePickerTheme();
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      zIndex={100}
      backgroundColor={theme.background}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={theme.success}
        backgroundColor={theme.backgroundPanel}
        flexDirection="column"
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        title=" ready to run "
        titleAlignment="center"
      >
        {/* Header — the form the user just filled in already shows the
            workflow name, agent, and field values, so the modal stays
            minimal and focuses on the submit/cancel question rather
            than restating the full invocation. */}
        <text>
          <span fg={theme.success}>
            <strong>✓ </strong>
          </span>
          <span fg={theme.text}>
            <strong>{workflow.name}</strong>
          </span>
          <span fg={theme.textDim}>{"  ·  "}</span>
          <span fg={theme.mauve}>{agent}</span>
        </text>

        <box height={1} />

        <text>
          <span fg={theme.textDim}>
            submit and run this workflow?{"  "}
          </span>
          <span fg={theme.success}>
            <strong>y</strong>
          </span>
          <span fg={theme.textDim}> submit  ·  </span>
          <span fg={theme.error}>
            <strong>n</strong>
          </span>
          <span fg={theme.textDim}> cancel</span>
        </text>
      </box>
    </box>
  );
}

// Stable hint arrays — pre-built so they never create new references.
type Hint = { key: string; label: string; dim?: boolean };

const PICK_HINTS: Hint[] = [
  { key: "↑↓", label: "navigate" },
  { key: "↵", label: "select" },
  { key: "esc", label: "quit" },
];
const CONFIRM_HINTS: Hint[] = [
  { key: "y", label: "submit" },
  { key: "n", label: "cancel" },
];
const PROMPT_HINTS_VALID: Hint[] = [
  { key: "tab", label: "to navigate forward" },
  { key: "shift+tab", label: "to navigate backward" },
  { key: "ctrl+d", label: "to run" },
];
const PROMPT_HINTS_INVALID: Hint[] = [
  { key: "tab", label: "to navigate forward" },
  { key: "shift+tab", label: "to navigate backward" },
  { key: "ctrl+d", label: "to run", dim: true },
];

// Per-agent brand color used as the Header pill background.
const AGENT_PILL_COLOR: Record<AgentType, keyof PickerTheme> = {
  claude: "warning",
  copilot: "success",
  opencode: "mauve",
};

const Header = memo(function Header({
  phase,
  confirmOpen,
  selectedAgent,
  scopedCount,
}: {
  phase: Phase;
  confirmOpen: boolean;
  selectedAgent: AgentType;
  scopedCount: number;
}) {
  const theme = usePickerTheme();
  const phaseLabel = confirmOpen
    ? "confirm"
    : phase === "pick"
      ? "select"
      : "compose";
  const pillBg = theme[AGENT_PILL_COLOR[selectedAgent]];

  return (
    <box
      height={1}
      backgroundColor={theme.surface}
      flexDirection="row"
      paddingRight={2}
      alignItems="center"
    >
      <text>
        <span fg={theme.surface} bg={pillBg}>
          <strong>{" " + selectedAgent.toUpperCase() + " "}</strong>
        </span>
      </text>
      <text>
        <span fg={theme.textDim}>{"  workflow  "}</span>
      </text>
      <text>
        <span fg={theme.textMuted}>›</span>
      </text>
      <text>
        <span fg={theme.textDim}>{"  " + phaseLabel}</span>
      </text>
      <box flexGrow={1} />
      <text>
        <span fg={theme.textDim}>
          {scopedCount + (scopedCount === 1 ? " workflow" : " workflows")}
        </span>
      </text>
    </box>
  );
});

const Statusline = memo(function Statusline({
  phase,
  confirmOpen,
  hints,
  focusedWf,
}: {
  phase: Phase;
  confirmOpen: boolean;
  hints: { key: string; label: string; dim?: boolean }[];
  focusedWf: WorkflowDefinition | undefined;
}) {
  const theme = usePickerTheme();
  const modeLabel = confirmOpen
    ? "CONFIRM"
    : phase === "pick"
      ? "PICK"
      : "PROMPT";
  const modeColor = confirmOpen
    ? theme.mauve
    : phase === "pick"
      ? theme.primary
      : theme.success;

  return (
    <box height={1} flexDirection="row" backgroundColor={theme.surface} position="relative" zIndex={101}>
      <box
        backgroundColor={modeColor}
        paddingLeft={1}
        paddingRight={1}
        alignItems="center"
      >
        <text fg={theme.surface}>
          <strong>{modeLabel}</strong>
        </text>
      </box>

      {focusedWf ? (
        <box paddingLeft={1} paddingRight={1} alignItems="center">
          <text>
            <span fg={theme.text}>
              {focusedWf.name}
            </span>
          </text>
        </box>
      ) : null}

      <box flexGrow={1} />

      <box paddingRight={2} alignItems="center" flexDirection="row">
        {hints.map((h, i) => (
          <box key={h.key} flexDirection="row">
            {i > 0 ? (
              <text>
                <span fg={theme.textDim}>{"  ·  "}</span>
              </text>
            ) : null}
            <text>
              <span fg={h.dim ? theme.textDim : theme.text}>{h.key}</span>
              <span fg={h.dim ? theme.textDim : theme.textMuted}>
                {" " + h.label}
              </span>
            </text>
          </box>
        ))}
      </box>
    </box>
  );
});

// ─── Keyboard hook ─────────────────────────────

interface PickerKeyboardState {
  entries: ListEntry[];
  clampedEntryIdx: number;
  savedEntryIdx: number;
  focusedWf: WorkflowDefinition | undefined;
  fieldValues: Record<string, string>;
  isFormValid: boolean;
  invalidFieldIndices: number[];
  currentFields: readonly WorkflowInput[];
  currentField: WorkflowInput | undefined;
  phase: Phase;
  confirmOpen: boolean;
  onSubmit: (result: WorkflowPickerResult) => void;
  onCancel: () => void;
  setPhase: (p: Phase) => void;
  setEntryIdx: React.Dispatch<React.SetStateAction<number>>;
  setSavedEntryIdx: (i: number) => void;
  setFieldValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setFocusedFieldIdx: React.Dispatch<React.SetStateAction<number>>;
  setConfirmOpen: (open: boolean) => void;
}

/**
 * Encapsulates all keyboard handling for the picker's three phases
 * (pick, prompt, confirm). Reads state through refs to avoid stale
 * closures — useKeyboard captures the first callback identity.
 */
function usePickerKeyboard(state: PickerKeyboardState): void {
  const onSubmitRef = useLatest(state.onSubmit);
  const onCancelRef = useLatest(state.onCancel);
  const entriesRef = useLatest(state.entries);
  const entryIdxRef = useLatest(state.clampedEntryIdx);
  const savedEntryIdxRef = useLatest(state.savedEntryIdx);
  const focusedWfRef = useLatest(state.focusedWf);
  const fieldValuesRef = useLatest(state.fieldValues);
  const isFormValidRef = useLatest(state.isFormValid);
  const invalidFieldIndicesRef = useLatest(state.invalidFieldIndices);
  const currentFieldsRef = useLatest(state.currentFields);
  const currentFieldRef = useLatest(state.currentField);
  const phaseRef = useLatest(state.phase);
  const confirmOpenRef = useLatest(state.confirmOpen);

  const {
    setPhase,
    setEntryIdx,
    setSavedEntryIdx,
    setFieldValues,
    setFocusedFieldIdx,
    setConfirmOpen,
  } = state;

  const onConfirmKey = useCallback((key: KeyEvent) => {
    key.stopPropagation();
    if (key.name === "y" || key.name === "return") {
      const wf = focusedWfRef.current;
      if (!wf) return;
      onSubmitRef.current({ workflow: wf, inputs: { ...fieldValuesRef.current } });
      return;
    }
    if (key.name === "n" || key.name === "escape") {
      setConfirmOpen(false);
    }
  }, []);

  const onPickKey = useCallback((key: KeyEvent) => {
    if (key.name === "escape") {
      key.stopPropagation();
      onCancelRef.current();
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "k")) {
      key.stopPropagation();
      setEntryIdx(Math.max(0, entryIdxRef.current - 1));
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "j")) {
      key.stopPropagation();
      setEntryIdx(Math.min(entriesRef.current.length - 1, entryIdxRef.current + 1));
      return;
    }
    if (key.name === "return") {
      key.stopPropagation();
      const wf = focusedWfRef.current;
      if (wf) {
        const initial: Record<string, string> = {};
        for (const f of wf.inputs) {
          initial[f.name] =
            f.default !== undefined
              ? String(f.default)
              : f.type === "enum"
                ? (f.values?.[0] ?? "")
                : "";
        }
        setFieldValues(initial);
        setFocusedFieldIdx(0);
        setSavedEntryIdx(entryIdxRef.current);
        setPhase("prompt");
      }
    }
  }, []);

  const onPromptKey = useCallback((key: KeyEvent) => {
    if (key.name === "escape") {
      key.stopPropagation();
      setEntryIdx(savedEntryIdxRef.current);
      setPhase("pick");
      return;
    }
    if (key.ctrl && key.name === "d") {
      key.stopPropagation();
      if (!isFormValidRef.current) {
        const firstInvalid = invalidFieldIndicesRef.current[0];
        if (firstInvalid !== undefined) setFocusedFieldIdx(firstInvalid);
        return;
      }
      setConfirmOpen(true);
      return;
    }
    if (key.name === "tab") {
      key.stopPropagation();
      setFocusedFieldIdx((i: number) => {
        const len = currentFieldsRef.current.length;
        if (len <= 1) return 0;
        return key.shift ? (i - 1 + len) % len : (i + 1) % len;
      });
      return;
    }
    const field = currentFieldRef.current;
    if (!field) return;

    if (field.type === "enum") {
      const values = field.values ?? [];
      if (values.length === 0) return;
      if (key.name === "left" || key.name === "right") {
        key.stopPropagation();
        setFieldValues((prev: Record<string, string>) => {
          const cur = prev[field.name] ?? values[0] ?? "";
          const idx = Math.max(0, values.indexOf(cur));
          const delta = key.name === "left" ? -1 : 1;
          const nextIdx = (idx + delta + values.length) % values.length;
          return { ...prev, [field.name]: values[nextIdx] ?? "" };
        });
      }
      return;
    }

    if (
      (field.type === "string" || field.type === "integer") &&
      key.name === "return"
    ) {
      key.stopPropagation();
      setFocusedFieldIdx((i: number) =>
        Math.min(currentFieldsRef.current.length - 1, i + 1),
      );
    }
  }, []);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.stopPropagation();
      onCancelRef.current();
      return;
    }
    if (confirmOpenRef.current) return onConfirmKey(key);
    if (phaseRef.current === "pick") return onPickKey(key);
    onPromptKey(key);
  });
}

// ─── App ────────────────────────────────────────

interface PickerAppProps {
  theme: PickerTheme;
  agent: AgentType;
  workflows: WorkflowDefinition[];
  onSubmit: (result: WorkflowPickerResult) => void;
  onCancel: () => void;
}

export function WorkflowPicker({
  theme,
  agent,
  workflows,
  onSubmit,
  onCancel,
}: PickerAppProps) {
  const [phase, setPhase] = useState<Phase>("pick");
  const [query, setQuery] = useState("");
  const [entryIdx, setEntryIdx] = useState(0);
  const [savedEntryIdx, setSavedEntryIdx] = useState(0);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [focusedFieldIdx, setFocusedFieldIdx] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const entries = useMemo(() => buildEntries(query, workflows), [query, workflows]);
  const rows = useMemo(() => buildRows(entries, query), [entries, query]);

  // Clamp index when the list shrinks (e.g. typing filters entries out).
  // Derived during render — keyboard handlers read the clamped value via
  // refs (useLatest) so no sync-back effect is needed.
  const clampedEntryIdx = Math.min(entryIdx, Math.max(0, entries.length - 1));

  const focusedWf = entries[clampedEntryIdx]?.workflow;

  const currentFields = useMemo<readonly WorkflowInput[]>(
    () => focusedWf?.inputs ?? [],
    [focusedWf],
  );
  const currentField = currentFields[focusedFieldIdx];

  const invalidFieldIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < currentFields.length; i++) {
      const f = currentFields[i];
      if (!f) continue;
      const v = fieldValues[f.name] ?? "";
      if (!isFieldValid(f, v)) out.push(i);
    }
    return out;
  }, [currentFields, fieldValues]);
  const isFormValid = invalidFieldIndices.length === 0;

  // Stable callback for field input — the setter is referentially stable.
  const onFieldInput = useCallback(
    (name: string, v: string) => setFieldValues((prev) => ({ ...prev, [name]: v })),
    [],
  );

  usePickerKeyboard({
    entries,
    clampedEntryIdx,
    savedEntryIdx,
    focusedWf,
    fieldValues,
    isFormValid,
    invalidFieldIndices,
    currentFields,
    currentField,
    phase,
    confirmOpen,
    onSubmit,
    onCancel,
    setPhase,
    setEntryIdx,
    setSavedEntryIdx,
    setFieldValues,
    setFocusedFieldIdx,
    setConfirmOpen,
  });

  const hints = confirmOpen
    ? CONFIRM_HINTS
    : phase === "pick"
      ? PICK_HINTS
      : isFormValid
        ? PROMPT_HINTS_VALID
        : PROMPT_HINTS_INVALID;

  return (
    <PickerThemeContext value={theme}>
      <box
        position="relative"
        width="100%"
        height="100%"
        flexDirection="column"
        backgroundColor={theme.background}
      >
        <Header
          phase={phase}
          confirmOpen={confirmOpen}
          selectedAgent={agent}
          scopedCount={workflows.length}
        />

        {phase === "pick" ? (
          <box
            flexGrow={1}
            flexDirection="row"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
          >
            <box width={36} flexDirection="column">
              <FilterBar query={query} focused={phase === "pick"} onInput={setQuery} />
              <box height={1} />
              <WorkflowList
                rows={rows}
                focusedEntryIdx={clampedEntryIdx}
              />
            </box>
            <box width={1} backgroundColor={theme.border} />
            <box flexGrow={1} flexDirection="column">
              {focusedWf ? (
                <Preview wf={focusedWf} />
              ) : (
                <EmptyPreview query={query} />
              )}
            </box>
          </box>
        ) : phase === "prompt" && focusedWf ? (
          <InputPhase
            workflow={focusedWf}
            agent={agent}
            fields={currentFields}
            values={fieldValues}
            focusedFieldIdx={confirmOpen ? -1 : focusedFieldIdx}
            onFieldInput={onFieldInput}
          />
        ) : null}

        <Statusline
          phase={phase}
          confirmOpen={confirmOpen}
          hints={hints}
          focusedWf={focusedWf}
        />

        {confirmOpen && focusedWf ? (
          <ConfirmModal workflow={focusedWf} agent={agent} />
        ) : null}
      </box>
    </PickerThemeContext>
  );
}

// ─── Public class API ──────────────────────────

export interface WorkflowPickerPanelOptions {
  agent: AgentType;
  /**
   * Registry of compiled workflow definitions. The panel calls
   * `registry.list()` and filters to the selected `agent`.
   */
  registry: Registry<Record<string, WorkflowDefinition>>;
}

/**
 * Imperative shell around the React picker tree — mirrors the
 * {@link OrchestratorPanel} lifecycle so both panels can be used
 * interchangeably by the CLI command layer.
 */
export class WorkflowPickerPanel {
  private renderer: CliRenderer;
  private root: Root;
  private destroyed = false;
  private terminalBackgroundSynced: boolean;
  private resolveSelection: ((r: WorkflowPickerResult | null) => void) | null =
    null;
  private selectionPromise: Promise<WorkflowPickerResult | null>;

  private constructor(
    renderer: CliRenderer,
    options: WorkflowPickerPanelOptions,
    { syncTerminalBackground = false }: { syncTerminalBackground?: boolean } = {},
  ) {
    this.renderer = renderer;
    this.terminalBackgroundSynced = syncTerminalBackground;
    this.selectionPromise = new Promise((resolve) => {
      this.resolveSelection = resolve;
    });

    const termTheme = resolveTheme(renderer.themeMode);
    setRendererBackground(renderer, termTheme.bg, { syncTerminalDefault: syncTerminalBackground });
    const theme = buildPickerTheme(termTheme);
    // Filter registry to only the workflows for the selected agent.
    const workflows = options.registry
      .list()
      .filter((wf) => wf.agent === options.agent);
    this.root = createRoot(renderer);
    this.root.render(
      <ErrorBoundary
        fallback={(err) => (
          <box
            width="100%"
            height="100%"
            justifyContent="center"
            alignItems="center"
            backgroundColor={theme.background}
          >
            <text>
              <span fg={theme.error}>
                {`Fatal render error: ${err.message}`}
              </span>
            </text>
          </box>
        )}
      >
        <WorkflowPicker
          theme={theme}
          agent={options.agent}
          workflows={workflows}
          onSubmit={(result) => this.handleSubmit(result)}
          onCancel={() => this.handleCancel()}
        />
      </ErrorBoundary>,
    );
    requestRendererBackgroundRepaint(this.renderer);
  }

  /**
   * Create a new WorkflowPickerPanel. Initialises a CLI renderer and
   * mounts the interactive tree. The caller should `await
   * waitForSelection()` and then call `destroy()` regardless of outcome.
   */
  static async create(
    options: WorkflowPickerPanelOptions,
  ): Promise<WorkflowPickerPanel> {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [
        "SIGTERM",
        "SIGQUIT",
        "SIGABRT",
        "SIGHUP",
        "SIGPIPE",
        "SIGBUS",
        "SIGFPE",
      ],
    });
    return new WorkflowPickerPanel(renderer, options, { syncTerminalBackground: true });
  }

  /** Create with an externally-provided renderer (e.g. a test renderer). */
  static createWithRenderer(
    renderer: CliRenderer,
    options: WorkflowPickerPanelOptions,
  ): WorkflowPickerPanel {
    return new WorkflowPickerPanel(renderer, options);
  }

  /**
   * Resolve with the user's selection once they confirm, or `null` if
   * they exit the picker without committing. Idempotent — subsequent
   * calls return the same promise.
   */
  waitForSelection(): Promise<WorkflowPickerResult | null> {
    return this.selectionPromise;
  }

  /** Tear down the CLI renderer. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Ensure anyone still awaiting the selection promise is released.
    if (this.resolveSelection) {
      this.resolveSelection(null);
      this.resolveSelection = null;
    }
    try {
      if (this.terminalBackgroundSynced) {
        resetRendererTerminalBackground(this.renderer);
      }
      this.renderer.destroy();
    } catch (err) {
      console.error("[WorkflowPickerPanel] destroy failed:", err);
    }
  }

  private handleSubmit(result: WorkflowPickerResult): void {
    if (this.resolveSelection) {
      this.resolveSelection(result);
      this.resolveSelection = null;
    }
  }

  private handleCancel(): void {
    if (this.resolveSelection) {
      this.resolveSelection(null);
      this.resolveSelection = null;
    }
  }
}
