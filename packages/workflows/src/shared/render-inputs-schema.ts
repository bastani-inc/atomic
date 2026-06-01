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
 *     blocks that match the indented `INPUTS` aesthetic established in
 *     `src/tui/session-list.ts`. Drawn for any interactive surface where the
 *     terminal supports colour.
 *   - **plain**  (used when no theme is supplied)         — emits the
 *     historical flat indented form. Required for tests that diff exact text
 *     and for non-TTY consumers (LLM tool results, logfiles, --help in
 *     redirected output).
 *
 * The layout in pretty mode mirrors bastani/atomic's `renderInputsText` so a
 * dev moving between the atomic CLI and the pi extension feels at home:
 *
 *     INPUTS FOR ralph
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
import { renderRoundedBox, chatWidth } from "../tui/chat-surface.js";
import { truncateToWidth } from "../tui/text-helpers.js";
import type { WorkflowInputEntry } from "../extension/render-result.js";

export interface RenderInputsSchemaOptions {
  /** When provided, output uses ANSI colours and indented `INPUTS` chrome. */
  theme?: GraphTheme;
  /** Optional host render width in terminal cells. */
  width?: number;
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
  return opts.theme === undefined
    ? renderPlain(name, inputs, opts.width)
    : renderPretty(name, inputs, opts.theme, opts.width);
}

// ---------------------------------------------------------------------------
// Plain renderer — rounded, marker-free workflow-tool output without ANSI.
// ---------------------------------------------------------------------------

function renderPlain(name: string, inputs: WorkflowInputEntry[], width?: number): string {
  const boxWidth = chatWidth(width);
  const body: string[] = [];

  if (inputs.length === 0) {
    body.push(` Workflow has no declared inputs. Workflow: "${name}". `);
  } else {
    for (let i = 0; i < inputs.length; i++) {
      if (i > 0) body.push("");
      body.push(...renderInputRows(inputs[i]!));
    }
    body.push("");
    body.push(` ${inputsSummary(name, inputs)} `);
  }

  return renderRoundedBox({
    title: `INPUTS FOR ${name}`,
    bodyLines: body,
    width: boxWidth,
  });
}

// ---------------------------------------------------------------------------
// Pretty renderer — ANSI-coloured, themed, matches the session-list aesthetic.
//
// Section labels lead with a two-cell indent and the field name is rendered
// bold-bright so the eye scans the form top-to-bottom. The `required` tag is yellow
// (theme.warning) — yellow draws attention to "you must fill this in"
// without being alarming the way red would.
// ---------------------------------------------------------------------------

function renderPretty(
  name: string,
  inputs: WorkflowInputEntry[],
  theme: GraphTheme,
  width?: number,
): string {
  const boxWidth = chatWidth(width);
  const body: string[] = [];

  if (inputs.length === 0) {
    body.push(` ${paint(`Workflow has no declared inputs. Workflow: "${name}".`, theme.dim)} `);
  } else {
    for (let i = 0; i < inputs.length; i++) {
      if (i > 0) body.push("");
      body.push(...renderInputRows(inputs[i]!, theme));
    }
    body.push("");
    body.push(` ${paint(inputsSummary(name, inputs), theme.dim)} `);
  }

  return renderRoundedBox({
    title: `INPUTS FOR ${name.toUpperCase()}`,
    bodyLines: body,
    accent: theme.mauve,
    theme,
    width: boxWidth,
  });
}

function renderInputRows(
  field: WorkflowInputEntry,
  theme?: GraphTheme,
): string[] {
  const tagLabel = field.required ? "required" : "optional";
  const heading = theme
    ? ` ${paint(field.name, theme.text, { bold: true })}  ${paint(field.type, theme.dim)}  ·  ${paint(tagLabel, field.required ? theme.warning : theme.dim)} `
    : ` ${field.name}  ${field.type}  ·  ${tagLabel} `;
  const lines: string[] = [heading];

  if (field.description) {
    lines.push(`   ${theme ? paint(field.description, theme.textMuted) : field.description} `);
  }
  if (field.choices && field.choices.length > 0) {
    const values = field.choices.join("  ·  ");
    lines.push(`   ${theme ? paint("values: ", theme.dim) + paint(values, theme.text) : `values: ${values}`} `);
  }
  if (field.default !== undefined) {
    const value = JSON.stringify(field.default);
    lines.push(`   ${theme ? paint("default: ", theme.dim) + paint(value, theme.text) : `default: ${value}`} `);
  }
  if (field.placeholder) {
    lines.push(`   ${theme ? paint("placeholder: ", theme.dim) + paint(field.placeholder, theme.textMuted) : `placeholder: ${field.placeholder}`} `);
  }

  return lines;
}

function inputsSummary(name: string, inputs: readonly WorkflowInputEntry[]): string {
  const required = inputs.filter((i) => i.required).length;
  const total = inputs.length;
  const totalLabel = `${total} input${total === 1 ? "" : "s"}`;
  const reqLabel = `${required} required`;
  return `${totalLabel}  ·  ${reqLabel}  ·  pass via key=value or run \`/workflow ${name}\` with no args for picker`;
}

