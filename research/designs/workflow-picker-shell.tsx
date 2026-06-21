/** @jsxImportSource @opentui/react */
import { theme, SOURCE_COLOR, SOURCE_DIR, SOURCE_DISPLAY, AGENT_PILL_COLOR } from "./workflow-picker-theme.js";
import { DEFAULT_PROMPT_INPUT } from "./workflow-picker-data.js";
import { Field } from "./workflow-picker-fields.js";
import type { AgentType, Phase, Workflow, WorkflowInput } from "./workflow-picker-types.js";

export function InputPhase({
  workflow,
  agent,
  fields,
  values,
  focusedFieldIdx,
  cursorOn,
}: {
  workflow: Workflow;
  agent: AgentType;
  fields: WorkflowInput[];
  values: Record<string, string>;
  focusedFieldIdx: number;
  cursorOn: boolean;
}) {
  const isStructured = workflow.inputs !== undefined && workflow.inputs.length > 0;

  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingRight={3}
      paddingTop={2}
      flexGrow={1}
    >
      {/* Locked-in workflow chip — the visual commitment to the selection */}
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
          <span fg={theme.primary}><strong>▸ </strong></span>
          <span fg={theme.text}><strong>{workflow.name}</strong></span>
          <span fg={theme.textDim}>{"  ·  "}</span>
          <span fg={theme.mauve}>{agent}</span>
          <span fg={theme.textDim}>{"  ·  "}</span>
          <span fg={theme[SOURCE_COLOR[workflow.source]]}>
            {SOURCE_DISPLAY[workflow.source]}
          </span>
          <span fg={theme.textDim}>
            {" (" + SOURCE_DIR[workflow.source] + ")"}
          </span>
        </text>
        <box height={1} />
        <text><span fg={theme.textMuted}>{workflow.description}</span></text>
      </box>

      <box height={2} />

      {/* Section label — shows a field count for structured forms, or
          just "prompt" for the free-form fallback. */}
      <box flexDirection="row" height={1}>
        <text>
          <span fg={theme.textDim}>
            <strong>{isStructured ? "INPUTS" : "PROMPT"}</strong>
          </span>
        </text>
        <box flexGrow={1} />
        <text>
          <span fg={theme.textDim}>
            {isStructured
              ? `${focusedFieldIdx + 1} / ${fields.length}`
              : ""}
          </span>
        </text>
      </box>
      <box height={1} />

      {/* One Field per input — for free-form workflows, there's a single
          text field bound to DEFAULT_PROMPT_INPUT. */}
      {fields.map((f, i) => (
        <Field
          key={f.name}
          field={f}
          value={values[f.name] ?? ""}
          focused={i === focusedFieldIdx}
          cursorOn={cursorOn}
        />
      ))}
    </box>
  );
}

// ConfirmModal — centered overlay shown when the user hits ⌃s in the
// prompt phase. Displays the fully-composed shell invocation so users
// can sanity-check the flags (and copy them out via terminal text
// selection) before committing.
//
// PRODUCTION INTEGRATION:
// In the real Atomic CLI, accepting this modal should:
//   1. Invoke the workflow runner with { workflow, agent, inputs:
//      fieldValues } — see src/commands/cli/workflow.ts for the entry
//      point that `atomic workflow <name> -a <agent> ...` already uses.
//   2. Tear down the picker renderer and hand control to the workflow's
//      live run view, the same surface `atomic workflow <name>` lands
//      on when flags are passed directly on the command line.
// Neither hook is wired up at the prototype layer — the demo just
// destroys the renderer on confirm, and the `// TODO(prod):` callsite
// below marks where the real trigger + navigation belongs.
export function ConfirmModal({
  workflow,
  agent,
  fields,
  values,
}: {
  workflow: Workflow;
  agent: AgentType;
  fields: WorkflowInput[];
  values: Record<string, string>;
}) {
  const isStructured = workflow.inputs !== undefined && workflow.inputs.length > 0;

  // Shorten a single value for display on one line. Long text fields
  // get truncated with an ellipsis so the command preview stays readable.
  function shortVal(v: string): string {
    const trimmed = v.replace(/\n/g, " ").trim();
    if (trimmed.length > 48) return trimmed.slice(0, 45) + "…";
    return trimmed;
  }

  // Free-form fallback: pull the single prompt value from DEFAULT_PROMPT_INPUT.
  const promptText = values[DEFAULT_PROMPT_INPUT.name] ?? "";
  const promptShort = shortVal(promptText) || "your question…";

  return (
    // Full-screen absolute overlay container. No backdrop fill — the
    // InputPhase stays faintly visible around the card, giving the
    // modal a "floating panel over a still form" feel rather than a
    // hard page transition.
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      zIndex={100}
    >
      {/* The modal card — sized to content, centered both axes. */}
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
        <text>
          <span fg={theme.success}><strong>✓ </strong></span>
          <span fg={theme.text}><strong>command composed</strong></span>
        </text>

        <box height={1} />

        <box paddingLeft={2} flexDirection="column">
          <text>
            <span fg={theme.textMuted}>atomic workflow </span>
            <span fg={theme.text}>{workflow.name}</span>
            <span fg={theme.textMuted}>{" \\"}</span>
          </text>
          <text>
            <span fg={theme.textMuted}>  -a </span>
            <span fg={theme.text}>{agent}</span>
            <span fg={theme.textMuted}>{" \\"}</span>
          </text>
          {isStructured ? (
            <box flexDirection="column">
              {fields.map((f, i) => {
                const last = i === fields.length - 1;
                const val = shortVal(values[f.name] ?? "") || `<${f.type}>`;
                return (
                  <text key={f.name}>
                    <span fg={theme.textMuted}>  --</span>
                    <span fg={theme.text}>{f.name}</span>
                    <span fg={theme.textMuted}>="</span>
                    <span fg={theme.text}>{val}</span>
                    <span fg={theme.textMuted}>"</span>
                    <span fg={theme.textDim}>{last ? "" : " \\"}</span>
                  </text>
                );
              })}
            </box>
          ) : (
            <text>
              <span fg={theme.textMuted}>  "</span>
              <span fg={theme.text}>{promptShort}</span>
              <span fg={theme.textMuted}>"</span>
            </text>
          )}
        </box>

        <box height={1} />

        {/* Prompt + key legend — the modal's own footer. The globally
            mapped keys here are duplicated in the Statusline hints so
            users scanning either surface find the same answer. esc
            still cancels silently since it costs nothing to support,
            but it's not advertised — y/n is the documented path. */}
        <text>
          <span fg={theme.textDim}>submit and run this workflow?  </span>
          <span fg={theme.success}><strong>y</strong></span>
          <span fg={theme.textDim}> submit  ·  </span>
          <span fg={theme.error}><strong>n</strong></span>
          <span fg={theme.textDim}> cancel</span>
        </text>
      </box>
    </box>
  );
}

export function Header({
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
  // When the confirm modal is open we shift the breadcrumb to "confirm"
  // so the header reflects the active surface, even though the
  // underlying phase is still "prompt".
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
      {/* Identity pill — shows the backend this session is pinned to,
          with a per-agent background hue so the badge is recognisable
          at a glance. Rendered in all caps to match the PICK / PROMPT
          / DONE mode pill in the statusline. Fixed at launch from the
          `-a` flag; not selectable from within the UI. */}
      <text>
        <span fg={theme.surface} bg={pillBg}>
          <strong>{" " + selectedAgent.toUpperCase() + " "}</strong>
        </span>
      </text>
      <text><span fg={theme.textDim}>{"  workflow  "}</span></text>
      <text><span fg={theme.textMuted}>›</span></text>
      <text><span fg={theme.textDim}>{"  " + phaseLabel}</span></text>
      <box flexGrow={1} />
      {/* Right side: workflow count for the currently-selected agent. */}
      <text>
        <span fg={theme.textDim}>
          {scopedCount + (scopedCount === 1 ? " workflow" : " workflows")}
        </span>
      </text>
    </box>
  );
}

export function Statusline({
  phase,
  confirmOpen,
  hints,
  focusedWf,
}: {
  phase: Phase;
  confirmOpen: boolean;
  // `dim: true` fades the key to textDim so callers can mark a hint as
  // visually disabled — used to signal that ⌃s is currently blocked
  // by unfilled required fields.
  hints: { key: string; label: string; dim?: boolean }[];
  focusedWf: Workflow | undefined;
}) {
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
    <box height={1} flexDirection="row" backgroundColor={theme.surface}>
      <box
        backgroundColor={modeColor}
        paddingLeft={1}
        paddingRight={1}
        alignItems="center"
      >
        <text fg={theme.surface}><strong>{modeLabel}</strong></text>
      </box>

      {focusedWf ? (
        <box paddingLeft={1} paddingRight={1} alignItems="center">
          <text>
            <span fg={theme.text}>{focusedWf.name}</span>
          </text>
        </box>
      ) : null}

      <box flexGrow={1} />

      <box paddingRight={2} alignItems="center" flexDirection="row">
        {hints.map((h, i) => (
          <box key={i} flexDirection="row">
            {i > 0 ? (
              <text><span fg={theme.textDim}>{"  ·  "}</span></text>
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
}

// ─── Validation ─────────────────────────────────

// A field is valid when it's optional, or required + non-empty. Enum
// fields are always seeded with a default or the first value on phase
// transition, so in practice they can't be empty — but we check
// defensively anyway. Text and string fields are validated after
