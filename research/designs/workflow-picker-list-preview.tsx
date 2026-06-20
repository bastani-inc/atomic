/** @jsxImportSource @opentui/react */
import { theme, SOURCE_COLOR, SOURCE_DIR, SOURCE_DISPLAY } from "./workflow-picker-theme.js";
import { DEFAULT_PROMPT_INPUT } from "./workflow-picker-data.js";
import type { ListRow, Workflow, WorkflowInput } from "./workflow-picker-types.js";

export function SectionLabel({ label }: { label: string }) {
  return (
    <box height={1} flexDirection="row">
      <text>
        <span fg={theme.mauve}>  </span>
        <span fg={theme.textMuted}><strong>{label}</strong></span>
      </text>
    </box>
  );
}


export function FilterBar({
  query,
  count,
  cursorOn,
}: {
  query: string;
  count: number;
  cursorOn: boolean;
}) {
  return (
    <box
      height={3}
      border
      borderStyle="rounded"
      borderColor={theme.borderActive}
      backgroundColor={theme.backgroundPanel}
      flexDirection="row"
      paddingLeft={2}
      paddingRight={2}
      alignItems="center"
    >
      <text><span fg={theme.primary}><strong>❯ </strong></span></text>
      <text>
        <span fg={theme.text}>{query}</span>
        <span fg={cursorOn ? theme.text : theme.backgroundPanel}>▋</span>
      </text>
      <box flexGrow={1} />
      <text>
        <span fg={theme.text}>{count}</span>
        <span fg={theme.textDim}> {count === 1 ? "match" : "matches"}</span>
      </text>
    </box>
  );
}

export function WorkflowList({
  rows,
  focusedEntryIdx,
}: {
  rows: ListRow[];
  focusedEntryIdx: number;
}) {
  if (rows.length === 0) {
    return (
      <box paddingLeft={2} paddingTop={2}>
        <text><span fg={theme.textDim}>no matches</span></text>
      </box>
    );
  }

  let entryCounter = -1;
  return (
    <box flexDirection="column">
      {rows.map((row, i) => {
        if (row.kind === "section") {
          const src = row.source!;
          return (
            <box
              key={`s${i}`}
              height={2}
              paddingTop={1}
              paddingLeft={2}
            >
              <text>
                <span fg={theme[SOURCE_COLOR[src]]}>
                  {SOURCE_DISPLAY[src]}
                </span>
                <span fg={theme.textDim}>
                  {" (" + SOURCE_DIR[src] + ")"}
                </span>
              </text>
            </box>
          );
        }
        entryCounter++;
        const isFocused = entryCounter === focusedEntryIdx;
        const wf = row.entry!.workflow;

        return (
          <box
            key={`e${i}`}
            height={1}
            flexDirection="row"
            backgroundColor={isFocused ? theme.border : "transparent"}
            paddingLeft={1}
            paddingRight={2}
          >
            <text>
              <span fg={isFocused ? theme.primary : theme.textDim}>
                {isFocused ? "▸ " : "  "}
              </span>
              <span fg={isFocused ? theme.text : theme.textMuted}>
                {wf.name}
              </span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

// A single argument shown in the preview pane. Three-row layout:
//
//   Row 1 — name (left) | type · required|optional (right)
//   Row 2 — description (muted)
//   Row 3 — enum values list (only for `type: "enum"`)
//
// `required` flips the right-hand tag between warning-yellow ("required")
// and textDim ("optional") so the eye can scan down a form and find the
// mandatory fields immediately.
export function ArgumentRow({ field }: { field: WorkflowInput }) {
  const isRequired = field.required ?? false;
  const tagCol = isRequired ? theme.warning : theme.textDim;
  const tagLabel = isRequired ? "required" : "optional";
  const showEnumValues =
    field.type === "enum" && field.values && field.values.length > 0;

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2}>
      {/* Row 1: name + type · required */}
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

      {/* Row 2: description */}
      {field.description ? (
        <box height={1}>
          <text><span fg={theme.textMuted}>{field.description}</span></text>
        </box>
      ) : null}

      {/* Row 3: enum values, joined with mid-dots */}
      {showEnumValues ? (
        <box height={1}>
          <text>
            <span fg={theme.textDim}>{field.values!.join("  ·  ")}</span>
          </text>
        </box>
      ) : null}

      {/* Gap between args */}
      <box height={1} />
    </box>
  );
}

export function Preview({ wf }: { wf: Workflow }) {
  // Every workflow has at least one argument to show. Structured
  // workflows use their declared inputs; everything else falls back to
  // DEFAULT_PROMPT_INPUT so users still see a clear "prompt — text —
  // required" row.
  const args: WorkflowInput[] =
    wf.inputs && wf.inputs.length > 0 ? wf.inputs : [DEFAULT_PROMPT_INPUT];

  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingRight={3}
      paddingTop={1}
    >
      {/* Name */}
      <text>
        <span fg={theme.text}><strong>{wf.name}</strong></span>
      </text>

      <box height={1} />

      {/* Source — matches the `atomic workflow -l` label + dim dir hint */}
      <text>
        <span fg={theme[SOURCE_COLOR[wf.source]]}>
          {SOURCE_DISPLAY[wf.source]}
        </span>
        <span fg={theme.textDim}>
          {" (" + SOURCE_DIR[wf.source] + ")"}
        </span>
      </text>

      <box height={2} />

      {/* Description */}
      <text><span fg={theme.textMuted}>{wf.description}</span></text>

      <box height={2} />

      {/* ARGUMENTS — the mauve   indicator bar gives the section label
          real weight against the preview body. */}
      <SectionLabel label="ARGUMENTS" />
      <box height={1} />
      {args.map((f) => (
        <ArgumentRow key={f.name} field={f} />
      ))}
    </box>
  );
}

export function EmptyPreview({ query }: { query: string }) {
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
      <text><span fg={theme.textDim}>Press backspace to widen your search, or</span></text>
      <box height={2} />
      <text><span fg={theme.textDim}>create a new one at</span></text>
      <box height={1} />
      <box paddingLeft={2}>
        <text><span fg={theme.primary}>.atomic/workflows/&lt;name&gt;/&lt;agent&gt;/index.ts</span></text>
      </box>
    </box>
  );
}

// ─── Field renderers ────────────────────────────
// One per FieldType. Each takes a `focused` flag so the input chrome
// (border, cursor, placeholder) adapts to which field is being edited.

