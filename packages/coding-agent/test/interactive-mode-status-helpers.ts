import { Container } from "@earendil-works/pi-tui";
import type { SourceInfo } from "../src/core/source-info.ts";

export type ExtensionFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

export function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

export function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

export function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}
