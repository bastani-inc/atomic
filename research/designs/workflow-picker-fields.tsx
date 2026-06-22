/** @jsxImportSource @opentui/react */
import { theme } from "./workflow-picker-theme.js";
import type { WorkflowInput } from "./workflow-picker-types.js";

export const TEXT_FIELD_LINES = 3;

// When a focused field is empty, we want the cursor to sit *on* the
// first character of the placeholder — so typing replaces the
// placeholder starting at the insertion point, not after it. This
// renders the first char of the placeholder (or a space if the
// placeholder itself is empty) with inverted fg/bg while the cursor
// is blinking on, and as plain dim text while it's off — producing
// a block-cursor effect that matches huh/noice/readline conventions.
function PlaceholderWithCursor({
  placeholder,
  cursorShown,
  bgCol,
}: {
  placeholder: string;
  cursorShown: boolean;
  bgCol: string;
}) {
  // Graceful fallback so the cursor still renders when a field has
  // no placeholder text defined at all.
  const effective = placeholder.length > 0 ? placeholder : " ";
  const first = effective.slice(0, 1);
  const rest = effective.slice(1);

  return (
    <text>
      <span
        fg={cursorShown ? theme.surface : theme.textDim}
        bg={cursorShown ? theme.primary : bgCol}
      >
        {first}
      </span>
      <span fg={theme.textDim}>{rest}</span>
    </text>
  );
}

function TextAreaContent({
  value,
  placeholder,
  focused,
  cursorOn,
  lines,
  bgCol,
}: {
  value: string;
  placeholder: string;
  focused: boolean;
  cursorOn: boolean;
  lines: number;
  bgCol: string;
}) {
  const textLines = value.split("\n");
  // Scroll with content so the cursor line stays visible even when the
  // user has typed more than `lines` rows.
  const start = Math.max(0, textLines.length - lines);
  const visible: string[] = [];
  for (let i = 0; i < lines; i++) {
    visible.push(textLines[start + i] ?? "");
  }
  const cursorLine = Math.min(lines - 1, textLines.length - 1 - start);
  const isEmpty = value === "";
  const cursorShown = focused && cursorOn;

  return (
    <box flexDirection="column">
      {visible.map((line, i) => {
        // Empty + first line: placeholder with the cursor overlapping
        // its first character (the insertion point).
        if (isEmpty && i === 0) {
          return (
            <box key={i} height={1}>
              <PlaceholderWithCursor
                placeholder={placeholder}
                cursorShown={cursorShown}
                bgCol={bgCol}
              />
            </box>
          );
        }
        // Non-empty line: text + trailing cursor on the cursor line.
        const showCursorHere = cursorShown && !isEmpty && i === cursorLine;
        return (
          <box key={i} height={1}>
            <text>
              <span fg={theme.text}>{line}</span>
              <span fg={showCursorHere ? theme.primary : bgCol}>▋</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

function StringContent({
  value,
  placeholder,
  focused,
  cursorOn,
  bgCol,
}: {
  value: string;
  placeholder: string;
  focused: boolean;
  cursorOn: boolean;
  bgCol: string;
}) {
  const isEmpty = value === "";
  const cursorShown = focused && cursorOn;

  // Empty: cursor overlaps first char of placeholder at the
  // insertion point — so the first keystroke replaces the
  // placeholder instead of pushing a cursor past it.
  if (isEmpty) {
    return (
      <box height={1} flexDirection="row">
        <PlaceholderWithCursor
          placeholder={placeholder}
          cursorShown={cursorShown}
          bgCol={bgCol}
        />
      </box>
    );
  }

  // Non-empty: standard line-input layout with cursor after the value.
  return (
    <box height={1} flexDirection="row">
      <text>
        <span fg={theme.text}>{value}</span>
        <span fg={cursorShown ? theme.primary : bgCol}>▋</span>
      </text>
    </box>
  );
}

function EnumContent({
  values,
  selected,
  focused,
}: {
  values: string[];
  selected: string;
  focused: boolean;
}) {
  return (
    <box height={1} flexDirection="row">
      {values.map((v, i) => {
        const isSelected = v === selected;
        const marker = isSelected ? "●" : "○";
        const markerColor = isSelected
          ? focused ? theme.primary : theme.success
          : theme.textDim;
        const textColor = isSelected
          ? focused ? theme.text : theme.textMuted
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

export function Field({
  field,
  value,
  focused,
  cursorOn,
}: {
  field: WorkflowInput;
  value: string;
  focused: boolean;
  cursorOn: boolean;
}) {
  // Focused fields light up with the primary accent and a slightly
  // warmer panel background — an unambiguous "edit me" signal.
  const borderCol = focused ? theme.primary : theme.border;
  const bgCol = focused ? theme.backgroundPanel : theme.backgroundElement;

  // Fixed row heights per type — string/enum are single-row, text is
  // multi-row so paragraphs have room to breathe.
  const boxHeight = field.type === "text" ? TEXT_FIELD_LINES + 2 : 3;

  // Caption: type · required|optional · description — dim, single line,
  // sits directly under the field so the form scans cleanly top-to-bottom.
  const tagCol = field.required ? theme.warning : theme.textDim;
  const tagLabel = field.required ? "required" : "optional";
  const captionDesc = field.description ? "  ·  " + field.description : "";

  return (
    <box flexDirection="column">
      <box
        border
        borderStyle="rounded"
        borderColor={borderCol}
        backgroundColor={bgCol}
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        height={boxHeight}
        justifyContent={field.type === "text" ? "flex-start" : "center"}
        title={` ${field.name} `}
        titleAlignment="left"
      >
        {field.type === "text" ? (
          <TextAreaContent
            value={value}
            placeholder={field.placeholder ?? ""}
            focused={focused}
            cursorOn={cursorOn}
            lines={TEXT_FIELD_LINES}
            bgCol={bgCol}
          />
        ) : field.type === "string" ? (
          <StringContent
            value={value}
            placeholder={field.placeholder ?? ""}
            focused={focused}
            cursorOn={cursorOn}
            bgCol={bgCol}
          />
        ) : field.type === "enum" ? (
          <EnumContent
            values={field.values ?? []}
            selected={value}
            focused={focused}
          />
        ) : null}
      </box>

      {/* Caption row directly under the box */}
      <box paddingLeft={2} paddingRight={2} height={1}>
        <text>
          <span fg={theme.textDim}>{field.type}</span>
          <span fg={theme.textDim}>{"  ·  "}</span>
          <span fg={tagCol}>{tagLabel}</span>
          <span fg={theme.textDim}>{captionDesc}</span>
        </text>
      </box>

      {/* Gap between fields */}
      <box height={1} />
    </box>
  );
}

