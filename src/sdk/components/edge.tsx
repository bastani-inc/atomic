/** @jsxImportSource @opentui/react */

import type { ConnectorResult } from "./connectors.ts";

export function Edge({ text, col, row, width, height, color: edgeColor, backgroundColor }: ConnectorResult) {
  return (
    <box position="absolute" left={col} top={row} width={width} height={height} backgroundColor={backgroundColor}>
      <text>
        <span fg={edgeColor} bg={backgroundColor}>{text}</span>
      </text>
    </box>
  );
}
