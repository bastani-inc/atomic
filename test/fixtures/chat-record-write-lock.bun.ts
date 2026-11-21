import { test } from "bun:test";
import {
	assertChatRecordWaitsWithoutStoppingTheEventLoop,
	CHAT_RECORD_LOCK_CASE_BUDGET_MS,
	CHAT_RECORD_LOCK_CASES,
} from "../helpers/chat-record-write-lock.js";

// Atomic's binary runs on Bun's node:sqlite: the same wait must keep its event loop running too (#5682).
for (const which of CHAT_RECORD_LOCK_CASES)
	test(
		`on Bun, saving ${which} waits for another process's SQLite write lock without stopping the event loop`,
		() => assertChatRecordWaitsWithoutStoppingTheEventLoop(which),
		CHAT_RECORD_LOCK_CASE_BUDGET_MS,
	);
