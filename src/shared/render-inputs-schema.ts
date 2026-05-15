/**
 * renderInputsSchema — canonical formatter for a workflow's declared input
 * schema. Single source of truth for every surface that needs to show input
 * metadata:
 *
 *   - renderResult({ action: "inputs", ... })  (LLM tool path; see render-result.ts)
 *   - /workflow inputs <name>                  (slash command; extension/index.ts)
 *   - /workflow <name> --help                  (slash help branch)
 *   - programmatic workflow validation failures (workflow-runner.ts)
 *
 * The renderer has two output modes:
 *
 *   - **pretty** (default when a GraphTheme is supplied) — emits ANSI-coloured
 *     blocks that match the `▎ INPUTS` aesthetic established in
 *     `src/tui/session-list.ts`. Drawn for any interactive surface where the
 *     terminal supports colour.
 *   - **plain**  (used when no theme is supplied)         — emits the
 *     historical flat indented form. Required for tests that diff exact text
 *     and for non-TTY consumers (LLM tool results, logfiles, --help in
 *     redirected output).
 *
 * The layout in pretty mode mirrors flora131/atomic's `renderInputsText` so a
 * dev moving between the atomic CLI and the pi extension feels at home:
 *
 *   ▎ INPUTS FOR ralph
 *
 *     prompt          text · required
 *       The high-level task to plan and execute.
 *
 *     iterations      number · optional
 *       Loop budget before bailing out.
 *       default: 5
 *
 *     focus           select · required
 *       How aggressively to scope the work.
 *       values: minimal, standard, exhaustive
 *       default: standard
 *
 *   3 inputs · 1 required · pass via key=value or run with no args for picker
 */

import type { GraphTheme } from "../tui/graph-theme.js";
import { paint } from "../tui/color-utils.js";
import type { WorkflowInputEntry } from "../extension/render-result.js";

export interface RenderInputsSchemaOptions {
  /** When provided, output uses ANSI colours and the `▎ INPUTS` chrome. */
  theme?: GraphTheme;
}

/**
 * Render the schema as a printable block. With `opts.theme` the result is
 * ANSI-coloured and structured for TUI surfaces; without it the output is
 * the historical plain-text form, byte-for-byte stable for snapshot tests.
 */
export function renderInputsSchema(
  name: string,
  inputs: WorkflowInputEntry[],
  opts: RenderInputsSchemaOptions = {},
): string {
  if (inputs.length === 0) return `Workflow "${name}" has no declared inputs.`;
  if (opts.theme === undefined) return renderPlain(name, inputs);
  return renderPretty(name, inputs, opts.theme);
}

// ---------------------------------------------------------------------------
// Plain renderer — historical shape preserved for the LLM tool path and
// non-TTY consumers. Stable byte-for-byte so existing snapshots keep passing.
// ---------------------------------------------------------------------------

function renderPlain(name: string, inputs: WorkflowInputEntry[]): string {
  const lines = inputs.map((inp) => {
    const req = inp.required ? " (required)" : "";
    const def =
      inp.default !== undefined ? ` [default: ${JSON.stringify(inp.default)}]` : "";
    const choices =
      inp.choices && inp.choices.length > 0
        ? ` {choices: ${inp.choices.join(", ")}}`
        : "";
    const desc = inp.description ? ` — ${inp.description}` : "";
    return `  ${inp.name}: ${inp.type}${req}${def}${choices}${desc}`;
  });
  return `Inputs for "${name}":\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Pretty renderer — ANSI-coloured, themed, matches the session-list aesthetic.
//
// Section labels lead with `▎ ` in mauve (the same glyph used across the
// extension's TUI surfaces) and the field name is rendered bold-bright so
// the eye scans the form top-to-bottom. The `required` tag is yellow
// (theme.warning) — yellow draws attention to "you must fill this in"
// without being alarming the way red would.
// ---------------------------------------------------------------------------

function renderPretty(
  name: string,
  inputs: WorkflowInputEntry[],
  theme: GraphTheme,
): string {
  const out: string[] = [];

  // Section header — mauve indicator bar + bold caps label, matching
  // session-list.ts. Includes the workflow name so the block is
  // self-titling when printed inline in a chat surface.
  out.push("");
  out.push(
    `${paint("▎", theme.mauve)} ${paint(
      `INPUTS FOR ${name.toUpperCase()}`,
      theme.textMuted,
      { bold: true },
    )}`,
  );
  out.push("");

  // Compute a stable left column for the name so types/required tags
  // line up vertically — the form should *look* like a form, not a
  // ragged paragraph. Cap at 24 chars so a stray long input name
  // doesn't push everything off the right edge.
  const nameWidth = Math.min(
    24,
    Math.max(...inputs.map((i) => i.name.length)),
  );
  const dimDot = paint("  ·  ", theme.dim);

  for (const field of inputs) {
    const namePad = field.name.padEnd(nameWidth);
    const tagColour = field.required ? theme.warning : theme.dim;
    const tagLabel = field.required ? "required" : "optional";

    // Row 1: name · type · required|optional
    out.push(
      "  " +
        paint(namePad, theme.text, { bold: true }) +
        "  " +
        paint(field.type, theme.dim) +
        dimDot +
        paint(tagLabel, tagColour),
    );

    // Row 2: description (when present)
    if (field.description) {
      out.push("    " + paint(field.description, theme.textMuted));
    }

    // Row 3: choices for selects — dot-separator style so the values
    // read as a clear closed set.
    if (field.choices && field.choices.length > 0) {
      const joined = field.choices
        .map((v) => paint(v, theme.text))
        .join(dimDot);
      out.push("    " + paint("values: ", theme.dim) + joined);
    }

    // Row 4: default (when present)
    if (field.default !== undefined) {
      out.push(
        "    " +
          paint("default: ", theme.dim) +
          paint(String(field.default), theme.text),
      );
    }

    // Row 5: placeholder hint (optional, mostly used by the picker)
    if (field.placeholder) {
      out.push(
        "    " +
          paint("placeholder: ", theme.dim) +
          paint(field.placeholder, theme.textMuted),
      );
    }

    out.push(""); // spacer between fields
  }

  // Summary footer — total/required count + the two-path hint that
  // teaches the slash key=value form and the picker fallback in one line.
  const required = inputs.filter((i) => i.required).length;
  const total = inputs.length;
  const totalLabel = `${total} input${total === 1 ? "" : "s"}`;
  const reqLabel = `${required} required`;
  out.push(
    "  " +
      paint(totalLabel, theme.dim) +
      dimDot +
      paint(reqLabel, theme.dim) +
      dimDot +
      paint(
        `pass via key=value or run \`/workflow ${name}\` with no args for picker`,
        theme.dim,
      ),
  );
  out.push("");

  return out.join("\n");
}
