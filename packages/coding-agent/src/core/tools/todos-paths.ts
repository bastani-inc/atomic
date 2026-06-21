import path from "node:path";
import { APP_NAME, CONFIG_DIR_NAME, getEnvValue } from "../../config.ts";

const TODO_DIR_NAME = `${CONFIG_DIR_NAME}/todos`;
const TODO_PATH_ENV = `${APP_NAME.toUpperCase()}_TODO_PATH`;

export function getTodosDir(cwd: string): string {
	const overridePath = getEnvValue(TODO_PATH_ENV);
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return path.resolve(cwd, TODO_DIR_NAME);
}

export function getTodosDirLabel(cwd: string): string {
	const overridePath = getEnvValue(TODO_PATH_ENV);
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return TODO_DIR_NAME;
}

export function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

export function getLockPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.lock`);
}
