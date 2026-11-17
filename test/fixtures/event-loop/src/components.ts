import { existsSync, statSync } from "node:fs";
import type { Component } from "./terminal.ts";

export class GitBranchLine implements Component {
	render(): string[] {
		return [existsSync(".git/HEAD") ? "on a branch" : "no repository"];
	}
}

export const sizeBanner: Component = {
	render: () => [`${statSync("README.md").size} bytes`],
};

export class UnusedLine {
	render(): string[] {
		return [statSync("never-rendered").isFile() ? "file" : "other"];
	}
}
