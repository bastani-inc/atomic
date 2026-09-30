import { hyperlink } from "@earendil-works/pi-tui";

export function authorizationNotice(url: string): string {
 const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
 return `Approve access in your browser. If it did not open, visit:\n${hyperlink(url, url)}\n${hyperlink(clickHint, url)}`;
}
