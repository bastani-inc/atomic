import type net from "node:net";
import type { BrokerMessage, Message, SessionInfo } from "../types.js";
import type { HeldAwayMessage } from "./away-asks.js";
import type { PendingQuestion, PendingQuestionIndex } from "./pending-question-index.js";
import { type BrokerConnectedSession, messageFrameFor } from "./send-handler.js";

export interface AskFailure {
	/** The asker, connected to this broker. */
	readonly asker: BrokerConnectedSession;
	readonly question: PendingQuestion;
	/** The recipient the failure is from, as the asker's ask names it. */
	readonly from: SessionInfo;
	/** One id per ask and kind of failure, so a failure held or written again is saved once. */
	readonly id: string;
	readonly reason: string;
	readonly pending: PendingQuestionIndex;
	readonly write: (socket: net.Socket, frame: BrokerMessage) => unknown;
	/** What a client that does not confirm saves gets instead of the failed-ask message (its frame before #5004). */
	readonly legacy?: BrokerMessage;
}

/**
 * #5004: deliver a failure the broker generates for an ask as durably as a reply. An asker that confirms saves has it
 * held under its return address until it confirms (`received`), and is sent it again when it registers again without
 * having confirmed; its inbox saves it once, by its id. A client that does not confirm saves gets what it always got,
 * written once.
 */
export function deliverAskFailure(failure: AskFailure): void {
	const message: Message = {
		id: failure.id,
		timestamp: Date.now(),
		replyTo: failure.question.messageId,
		replyError: failure.reason,
		content: { text: failure.reason },
	};
	deliverHeldToAsker(failure, message);
}

/**
 * #5004: write a message the broker holds for an asker (a failed ask, or a reply held for a released subagent) as
 * durably as a reply: see {@link deliverAskFailure}.
 */
export function deliverHeldToAsker(
	target: Pick<AskFailure, "asker" | "question" | "from" | "pending" | "write" | "legacy">,
	message: Message,
): void {
	const { asker, question, from, pending, write } = target;
	const returnAddress = asker.registrationReturnAddress;
	if (asker.acknowledgesReceipt !== true || !returnAddress) {
		write(asker.socket, target.legacy ?? messageFrameFor(asker, from, message));
		return;
	}
	// Held under the asker's return address as for an away asker: `received` releases it, and the asker's next
	// registration is sent it again until then.
	pending.holdForAwayAsker({ ...question, senderReturnAddress: returnAddress }, from, message);
	write(asker.socket, messageFrameFor(asker, from, message));
}

/**
 * #5095: a reply never reached its asker after its recipient ended (its write failed, or it lapsed unsaved), so the
 * ask fails now with the failure prepared when the recipient ended: delivered like any failed ask to a connected
 * asker, held for an away asker that can prove itself by its return address.
 */
export function failLostReply(lost: {
	readonly question: PendingQuestion;
	readonly held: HeldAwayMessage;
	readonly askerReturnAddress: string | undefined;
	readonly asker: BrokerConnectedSession | undefined;
	readonly pending: PendingQuestionIndex;
	readonly write: (socket: net.Socket, frame: BrokerMessage) => unknown;
}): void {
	const { question, held, askerReturnAddress, asker, pending } = lost;
	if (asker !== undefined) {
		deliverHeldToAsker(
			{
				asker,
				question,
				from: held.from,
				pending,
				write: lost.write,
				legacy: {
					type: "peer_disconnected",
					replyTo: question.messageId,
					peerSessionId: question.targetSessionId,
					...(held.from.name === undefined ? {} : { peerName: held.from.name }),
				},
			},
			held.message,
		);
		return;
	}
	if (askerReturnAddress !== undefined && askerReturnAddress !== "")
		pending.holdForAwayAsker({ ...question, senderReturnAddress: askerReturnAddress }, held.from, held.message);
}
