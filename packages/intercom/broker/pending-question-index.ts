import type { Message, SessionInfo } from "../types.js";
import { AwayAsks, type HeldAwayMessage } from "./away-asks.js";
export interface PendingQuestion {
  senderSessionId: string;
  targetSessionId: string;
  messageId: string;
}

/** Tracks delivered questions until their reply or either peer's departure. */
export class PendingQuestionIndex {
  private readonly questions = new Map<string, PendingQuestion[]>();
  /**
   * #4751: questions whose asker, or whose recipient, is away (closed without ending its session, or released), and
   * the replies held for an away asker. An ask has no expiry, so these wait for that session to register again.
   */
  private away: AwayAsks | undefined;

  /** Keep what waits for away sessions in this store (the broker's durable one); in memory until then. */
  useAwayStore(store: AwayAsks): void {
    this.away = store;
  }

  private awayAsks(): AwayAsks {
    this.away ??= new AwayAsks();
    return this.away;
  }

  /** Keep questions whose peer is away until it is back. */
  keepDormant(questions: readonly PendingQuestion[], senderReturnAddress?: string): void {
    if (questions.length === 0) return;
    this.awayAsks().keep(questions, senderReturnAddress);
  }

  /** The asker is away now too: its questions kept for an away recipient wait for it under its return address (#4761). */
  markAwayAsker(senderSessionId: string, senderReturnAddress: string | undefined): void {
    this.away?.markAsker(senderSessionId, senderReturnAddress);
  }

  /** A released subagent asker's questions kept for an away recipient: its owner's route waits on them too (#4765). */
  dormantForReleasedAsker(senderSessionId: string): PendingQuestion[] {
    return this.away?.forReleasedAsker(senderSessionId) ?? [];
  }

  /** A kept question answered through its released asker's owner no longer waits for its peers (#4765). */
  forgetDormant(question: PendingQuestion): void {
    this.away?.forget(question);
  }

  /** Whether `replierSessionId` answers the kept question `questionId`, whose asker is away (#4751). */
  hasDormantReply(questionId: string, replierSessionId: string): boolean {
    return this.awayAsks().question(questionId, replierSessionId) !== undefined;
  }

  /** The kept question `questionId` that `replierSessionId` answers while its asker is away (#4751). */
  dormantReply(
    questionId: string,
    replierSessionId: string,
  ): (PendingQuestion & { readonly senderReturnAddress?: string }) | undefined {
    return this.awayAsks().question(questionId, replierSessionId);
  }

  /** A session is back under its id: its kept questions route again once both of their peers are connected. */
  restoreDormant(
    sessionId: string,
    returnAddress: string | undefined,
    isConnected: (sessionId: string) => boolean,
  ): PendingQuestion[] {
    const restored = this.awayAsks().restore(sessionId, returnAddress, isConnected);
    for (const question of restored) this.record(question.senderSessionId, question.targetSessionId, question.messageId);
    return restored;
  }

  /**
   * Kept questions to a recipient that ended or can no longer answer. Their askers are away, so each gets a failed-ask
   * message held until it is back (#4751).
   */
  failDormantForTarget(target: SessionInfo, reason: string, idPrefix: string): void {
    this.awayAsks().failForTarget(target, reason, idPrefix, this.failsThroughOwner);
  }

  private failsThroughOwner: (question: PendingQuestion) => boolean = () => false;

  /** #4765: kept questions a released subagent's owner fails on its own route are not also held for the subagent. */
  failThroughOwnerWhen(check: (question: PendingQuestion) => boolean): void {
    this.failsThroughOwner = check;
  }

  /** The session ended for good: nothing waits for it any more. */
  dropAway(returnAddress: string | undefined): void {
    this.awayAsks().drop(returnAddress);
  }

  /** Hold a reply for the away asker of `question`, delivered once when it registers again (#4751). */
  holdForAwayAsker(
    question: PendingQuestion & { readonly senderReturnAddress: string },
    from: SessionInfo,
    message: Message,
  ): void {
    this.awayAsks().hold(question, from, message);
  }

  /** Whether this reply is already held for its asker. */
  isHeldForAwayAsker(messageId: string, replierSessionId: string): boolean {
    return this.awayAsks().isHeld(messageId, replierSessionId);
  }

  /** What is held for the asker that proves itself by its return address, in the order it was held. */
  heldForAsker(askerReturnAddress: string | undefined): HeldAwayMessage[] {
    return this.awayAsks().held(askerReturnAddress);
  }

  /** The verified asker saved a held message. */
  releaseHeld(messageId: string, askerReturnAddress: string | undefined): void {
    this.away?.release(messageId, askerReturnAddress);
  }

  private readonly parked = new Map<string, { ownerSessionId: string; questions: PendingQuestion[] }>();
  /** #4751: asks of released subagents whose reply is held for them, by owner and child name. */
  private readonly parkedAskers = new Map<string, PendingQuestion[]>();

  parkAsker(childName: string, ownerSessionId: string, question: PendingQuestion): void {
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    this.parkedAskers.set(key, [...(this.parkedAskers.get(key) ?? []), question]);
  }

  /** #4751: failed-ask messages for a released subagent whose recipient ended, by owner and child name. */
  private readonly heldForChildren = new Map<string, HeldAwayMessage[]>();

  holdForReleasedChild(childName: string, ownerSessionId: string, held: HeldAwayMessage): void {
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const list = this.heldForChildren.get(key) ?? [];
    if (!list.some((existing) => existing.message.id === held.message.id)) this.heldForChildren.set(key, [...list, held]);
  }

  hasHeldForReleasedChild(childName: string, ownerSessionId: string): boolean {
    return (this.heldForChildren.get(JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]))?.length ?? 0) > 0;
  }

  takeHeldForReleasedChild(childName: string, ownerSessionId: string): HeldAwayMessage[] {
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const held = this.heldForChildren.get(key) ?? [];
    this.heldForChildren.delete(key);
    return held;
  }

  takeParkedAskers(childName: string, ownerSessionId: string): PendingQuestion[] {
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const questions = this.parkedAskers.get(key) ?? [];
    this.parkedAskers.delete(key);
    return questions;
  }

  parkTarget(targetSessionId: string, childName: string, ownerSessionId: string): void {
    const questions = this.takeForTarget(targetSessionId);
    if (questions.length === 0) return;
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const previous = this.parked.get(key);
    if (previous !== undefined) previous.questions.push(...questions);
    else this.parked.set(key, { ownerSessionId, questions });
  }

  takeParked(childName: string, ownerSessionId: string): PendingQuestion[] {
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const parked = this.parked.get(key);
    if (parked === undefined) return [];
    this.parked.delete(key);
    return parked.questions;
  }

  takeParkedForOwner(ownerSessionId: string): PendingQuestion[] {
    const result: PendingQuestion[] = [];
    for (const [key, parked] of this.parked) {
      if (parked.ownerSessionId !== ownerSessionId) continue;
      this.parked.delete(key);
      result.push(...parked.questions);
    }
    return result;
  }

  record(senderSessionId: string, targetSessionId: string, messageId: string): void {
    const routes = this.questions.get(messageId) ?? [];
    if (routes.some((route) => route.senderSessionId === senderSessionId && route.targetSessionId === targetSessionId)) return;
    routes.push({ senderSessionId, targetSessionId, messageId });
    this.questions.set(messageId, routes);
  }

	/** Authorize only the exact reverse route of a broker-recorded live ask. */
	matchesReply(senderSessionId: string, targetSessionId: string, replyTo: string): boolean {
		return (
			this.questions
				.get(replyTo)
				?.some(
					(route) => route.targetSessionId === senderSessionId && route.senderSessionId === targetSessionId,
				) === true
		);
	}
  clearReply(senderSessionId: string, targetSessionId: string, replyTo: string): boolean {
    const routes = this.questions.get(replyTo);
    const index = routes?.findIndex(
      (route) => route.targetSessionId === senderSessionId && route.senderSessionId === targetSessionId,
    ) ?? -1;
    if (!routes || index < 0) return false;
    routes.splice(index, 1);
    if (routes.length === 0) this.questions.delete(replyTo);
    // #4765: a released subagent's ask can be kept for its away recipient while it is live again; answered, it is not.
    this.away?.forget({ messageId: replyTo, senderSessionId: targetSessionId, targetSessionId: senderSessionId });
    return true;
  }

  pruneSender(senderSessionId: string): void {
    this.takeForSender(senderSessionId);
  }

  takeForSender(senderSessionId: string): PendingQuestion[] {
    const pending: PendingQuestion[] = [];
    for (const [messageId, routes] of this.questions) {
      const remaining = routes.filter((route) => {
        if (route.senderSessionId !== senderSessionId) return true;
        pending.push(route);
        return false;
      });
      if (remaining.length === 0) this.questions.delete(messageId);
      else if (remaining.length !== routes.length) this.questions.set(messageId, remaining);
    }
    for (const [key, parked] of this.parked) {
      const remaining = parked.questions.filter((question) => {
        if (question.senderSessionId !== senderSessionId) return true;
        pending.push(question);
        return false;
      });
      if (remaining.length === 0) this.parked.delete(key);
      else parked.questions = remaining;
    }
    return pending;
  }

  takeForTarget(targetSessionId: string): PendingQuestion[] {
    const pending: PendingQuestion[] = [];
    for (const [messageId, routes] of this.questions) {
      const remaining = routes.filter((route) => {
        if (route.targetSessionId !== targetSessionId) return true;
        pending.push(route);
        return false;
      });
      if (remaining.length === 0) this.questions.delete(messageId);
      else if (remaining.length !== routes.length) this.questions.set(messageId, remaining);
    }
    return pending;
  }
}
