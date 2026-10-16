import assert from "node:assert/strict";
import type { TUI } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import ticTacToe from "../examples/extensions/tic-tac-toe.ts";
import type { TicTacToeComponent } from "../examples/extensions/tic-tac-toe-rendering.ts";
import type { BoardDetails } from "../examples/extensions/tic-tac-toe-state.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { StorageUnavailableError } from "../src/core/storage/session/errors.ts";
import { createTestExtensionsResult } from "./utilities.ts";

test("a failed human move save leaves the board and turn playable for retry", async () => {
	const failure = new StorageUnavailableError({ adapter: "test", location: "game" }, new Error("save failed"));
	const saveRelease = Promise.withResolvers<void>();
	const append = vi
		.fn()
		.mockImplementationOnce(() => saveRelease.promise)
		.mockResolvedValue(undefined);
	const send = vi.fn().mockResolvedValue(undefined);
	const notices: string[] = [];
	const loaded = await createTestExtensionsResult([
		(pi) =>
			ticTacToe({
				...pi,
				appendEntry: append,
				setSessionName: async () => {},
				sendMessage: send,
			}),
	]);
	const extension = loaded.extensions[0];
	const command = extension.commands.get("tic-tac-toe");
	const seeBoard = extension.tools.get("tic_tac_toe_see_board");
	assert.ok(command);
	assert.ok(seeBoard);
	let component: TicTacToeComponent | undefined;
	const context = {
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		ui: {
			notify(message: string) {
				notices.push(message);
			},
			async custom(factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) {
				component = (await factory(
					{ requestRender() {} } as TUI,
					{} as Parameters<typeof factory>[1],
					{} as Parameters<typeof factory>[2],
					() => {},
				)) as TicTacToeComponent;
			},
		},
	} as ExtensionCommandContext;
	await command.handler("", context);
	assert.ok(component);
	const board = async () =>
		(await seeBoard.definition.execute("board", {}, undefined, undefined, context)).details as BoardDetails;
	const before = await board();
	component.handleInput("\r");
	await vi.waitFor(() => assert.equal(append.mock.calls.length, 1));
	const pendingBoard = await board();
	assert.equal(send.mock.calls.length, 0);
	saveRelease.reject(failure);
	await vi.waitFor(() => assert.deepEqual(notices, [failure.message]));
	assert.deepEqual(pendingBoard, before, "pending saves do not publish moves");
	assert.deepEqual(await board(), before, "failed save retains the user's turn");
	component.handleInput("\r");
	await vi.waitFor(() => assert.equal(send.mock.calls.length, 1));
	assert.equal(append.mock.calls.length, 2);
	assert.equal((await board()).board[1][1], "X");
	assert.equal((await board()).currentTurn, "O");
});

for (const action of ["cursor", "play", "win"] as const) {
	test(`a failed agent ${action} save preserves the board, cursor and turn for retry`, async () => {
		const failure = new StorageUnavailableError({ adapter: "test", location: "game" }, new Error("save failed"));
		const append = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
		const send = vi.fn().mockResolvedValue(undefined);
		const loaded = await createTestExtensionsResult([
			(pi) => ticTacToe({ ...pi, appendEntry: append, setSessionName: async () => {}, sendMessage: send }),
		]);
		const extension = loaded.extensions[0];
		const initial: BoardDetails = {
			board:
				action === "win"
					? [
							["O", "O", " "],
							["X", "X", " "],
							[" ", " ", " "],
						]
					: [
							[" ", " ", " "],
							[" ", "X", " "],
							[" ", " ", " "],
						],
			agentCursorRow: 0,
			agentCursorCol: action === "win" ? 2 : 0,
			status: "playing",
			currentTurn: "O",
		};
		const ctx = {
			mode: "tui",
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "toolResult", toolName: "tic_tac_toe", details: initial } },
				],
			},
			ui: { custom: async () => {}, notify() {} },
		} as ExtensionCommandContext;
		await extension.commands.get("tic-tac-toe")!.handler("", ctx);
		const tool = extension.tools.get("tic_tac_toe")!.definition;
		const seeBoard = extension.tools.get("tic_tac_toe_see_board")!.definition;
		const board = async () =>
			(await seeBoard.execute("board", {}, undefined, undefined, ctx)).details as BoardDetails;
		const move = () =>
			tool.execute("move", { action: action === "cursor" ? "move_right" : "play" }, undefined, undefined, ctx);
		await assert.rejects(move(), (error: Error) => error === failure);
		assert.deepEqual(await board(), initial, "failed saves must not publish game state");
		assert.equal(send.mock.calls.length, 0, "failed saves do not announce game over");
		await move();
		assert.equal(append.mock.calls.length, 2);
		const saved = await board();
		if (action === "cursor") assert.equal(saved.agentCursorCol, 1);
		else {
			assert.equal(saved.board[0][action === "win" ? 2 : 0], "O");
			assert.equal(saved.status, action === "win" ? "win_O" : "playing");
			assert.equal(send.mock.calls.length, action === "win" ? 1 : 0);
		}
	});
}
