/** @jsxImportSource @opentui/react */

import { useStore, useGraphTheme, useStoreVersion } from "./orchestrator-panel-contexts.ts";

export function Statusline({
  attachMsg,
}: {
  attachMsg: string;
}) {
  const store = useStore();
  const theme = useGraphTheme();
  useStoreVersion(store);

  return (
    <box height={1} flexDirection="row" backgroundColor={theme.backgroundElement}>
      {/* Mode badge — always GRAPH since this bar is only visible in the orchestrator window */}
      <box backgroundColor={theme.primary} paddingLeft={1} paddingRight={1} alignItems="center">
        <text>
          <span fg={theme.backgroundElement} bg={theme.primary}>
            <strong>GRAPH</strong>
          </span>
        </text>
      </box>

      {store.backgroundTaskCount > 0 ? (
        <box backgroundColor={theme.backgroundElement} paddingLeft={1} alignItems="center">
          <text>
            <span fg={theme.textDim} bg={theme.backgroundElement}>{"\u00B7"} </span>
            <span fg={theme.warning} bg={theme.backgroundElement}>{"\u25C6"} </span>
            <span fg={theme.textMuted} bg={theme.backgroundElement}>
              {store.backgroundTaskCount} background
            </span>
          </text>
        </box>
      ) : null}

      <box flexGrow={1} />

      {/* Navigation hints — always graph-mode (tmux status bar handles attached-mode hints) */}
      <box paddingRight={2} alignItems="center">
        {attachMsg ? (
          <text>
            <span fg={theme.text} bg={theme.backgroundElement}>
              <strong>{attachMsg}</strong>
            </span>
          </text>
        ) : (
          <text>
            <span fg={theme.text} bg={theme.backgroundElement}>{"\u2191\u2193\u2190\u2192"}</span>
            <span fg={theme.textMuted} bg={theme.backgroundElement}> navigate</span>
            <span fg={theme.textDim} bg={theme.backgroundElement}> {"\u00B7"} </span>
            <span fg={theme.text} bg={theme.backgroundElement}>{"\u21B5"}</span>
            <span fg={theme.textMuted} bg={theme.backgroundElement}> attach</span>
            <span fg={theme.textDim} bg={theme.backgroundElement}> {"\u00B7"} </span>
            <span fg={theme.text} bg={theme.backgroundElement}>/</span>
            <span fg={theme.textMuted} bg={theme.backgroundElement}> stages</span>
            <span fg={theme.textDim} bg={theme.backgroundElement}> {"\u00B7"} </span>
            <span fg={theme.text} bg={theme.backgroundElement}>ctrl+b d</span>
            <span fg={theme.textMuted} bg={theme.backgroundElement}> detach</span>
            <span fg={theme.textDim} bg={theme.backgroundElement}> {"\u00B7"} </span>
            <span fg={theme.text} bg={theme.backgroundElement}>q</span>
            <span fg={theme.textMuted} bg={theme.backgroundElement}> quit</span>
          </text>
        )}
      </box>
    </box>
  );
}
