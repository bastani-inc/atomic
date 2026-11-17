import { readFileSync, writeFileSync } from "node:fs";

interface SessionMethods {
	exportText(): string;
	readonly title: string;
}

class SessionBase {
	readonly id: string = "session";
}

export interface Session extends SessionBase, SessionMethods {}

export const Session = SessionBase as unknown as { new (): Session; readonly prototype: Session };

function exportText(this: Session): string {
	writeFileSync("export.txt", this.id);
	return this.id;
}

const sessionMethods = { exportText };

function installSessionAccessors(prototype: Session): void {
	Object.defineProperties(prototype, {
		title: {
			get(this: Session) {
				return readFileSync("title.txt", "utf8");
			},
		},
	});
}

installSessionAccessors(Session.prototype);
Object.assign(Session.prototype, sessionMethods);
