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

  /** Return addresses of sessions by id, live or departed: a live route is written durably with its peers' (#4829). */
  private returnAddressOf: (sessionId: string) => string | undefined = () => undefined;

  /**
   * Keep what waits for away sessions in this store (the broker's durable one); in memory until then. #4829: live
   * routes are written to it too, with the return addresses `returnAddressOf` resolves, so they outlive the broker.
   */
  useAwayStore(store: AwayAsks, returnAddressOf?: (sessionId: string) => string | undefined): void {
    this.away = store;
    store.onHeldForReleasedAsker((owner, childName) => this.heldForReleasedAsker(owner, childName));
    if (returnAddressOf !== undefined) this.returnAddressOf = returnAddressOf;
  }

  /** #4829: a live route outlives this broker only when its asker can prove itself by its return address. */
  writeLive(question: PendingQuestion): void {
    const senderReturnAddress = this.returnAddressOf(question.senderSessionId);
    if (this.away === undefined || senderReturnAddress === undefined || senderReturnAddress === "") return;
    this.away.recordLive(
      question,
      senderReturnAddress,
      this.returnAddressOf(question.targetSessionId) ?? "",
      this.isMovable(question),
    );
  }

  private isMovable: (question: PendingQuestion) => boolean = () => false;

  /** #4997: a live route whose peers may each come back on another broker, which it then moves to with them. */
  movableWhen(check: (question: PendingQuestion) => boolean): void {
    this.isMovable = check;
  }

  /** #4997: the kept asks between two sessions that may each come back on another broker, so they move with them. */
  movableDormant(): PendingQuestion[] {
    return this.away?.movable() ?? [];
  }

  forgetLive(questions: readonly PendingQuestion[]): void {
    for (const question of questions) this.away?.forgetLive(question);
  }

  /** #4996: what `work` writes to the away store is one transaction, not one commit per write. */
  batch<T>(work: () => T): T {
    return this.away === undefined ? work() : this.away.batch(work);
  }

  private awayAsks(): AwayAsks {
    if (this.away === undefined) {
      this.away = new AwayAsks();
      this.away.onHeldForReleasedAsker((owner, childName) => this.heldForReleasedAsker(owner, childName));
    }
    return this.away;
  }

  private heldForReleasedAsker: (ownerSessionId: string, childName: string) => void = () => {};

  /** #4992: told when a reply or failure is held for a released subagent, so its owner wakes it. */
  onHeldForReleasedAsker(listener: (ownerSessionId: string, childName: string) => void): void {
    this.heldForReleasedAsker = listener;
  }

  /** #4992: the released subagent proving itself by `returnAddress` is kept by its owner while it holds no session. */
  keepReleasedAsker(returnAddress: string | undefined, ownerSessionId: string, childName: string): void {
    if (returnAddress !== undefined) this.awayAsks().keepReleasedAsker(returnAddress, ownerSessionId, childName);
  }

  forgetReleasedAsker(returnAddress: string | undefined): void {
    this.away?.forgetReleasedAsker(returnAddress);
  }

  /** #4992: whether a reply or failure is held, durably, for the released subagent the owner keeps as `childName`. */
  hasHeldForReleasedAsker(childName: string, ownerSessionId: string): boolean {
    return this.away?.hasHeldForReleasedAsker(ownerSessionId, childName) ?? false;
  }

  /**
   * Keep questions whose peer is away until it is back. #4950: without `senderReturnAddress` (their recipient is the one
   * away), each keeps its asker's return address now, so its failure reaches it even if this broker goes first.
   */
  keepDormant(
    questions: readonly PendingQuestion[],
    senderReturnAddress?: string,
    /** #4997: the questions that may follow their peers to another broker, published to the shared state. */
    movable?: (question: PendingQuestion) => boolean,
  ): void {
    if (questions.length === 0) return;
    this.awayAsks().keep(
      questions,
      senderReturnAddress ?? ((question) => this.returnAddressOf(question.senderSessionId)),
      movable,
    );
  }

  /**
   * Keep questions whose recipient is away until it is back. Returns those refused because that recipient's away queue
   * is full; their askers are connected, and are told at once (#4996).
   */
  keepDormantForRecipient(
    questions: readonly PendingQuestion[],
    /** #4997: as `keepDormant`'s. */
    movable?: (question: PendingQuestion) => boolean,
  ): PendingQuestion[] {
    // #4950: each keeps its asker's return address too, so its failure reaches it even if this broker goes first.
    return this.awayAsks().keepForAwayRecipient(
      questions,
      (question) => this.returnAddressOf(question.senderSessionId),
      movable,
    );
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

  /** #4997: whether the question still waits here for an away peer. */
  isDormant(question: PendingQuestion): boolean {
    return this.away?.isKept(question) === true;
  }

  /** #4997: the kept question no longer waits here, as another store took it. Whether it was still kept. */
  takeDormant(question: PendingQuestion): boolean {
    return this.away?.forget(question) === true;
  }

  /** Whether `replierSessionId` answers the kept question `questionId`, whose asker is away (#4751). */
  hasDormantReply(questionId: string, replierSessionId: string, replierReturnAddress?: string): boolean {
    return this.awayAsks().question(questionId, replierSessionId, replierReturnAddress) !== undefined;
  }

  /** The kept question `questionId` that `replierSessionId` answers while its asker is away (#4751). */
  dormantReply(
    questionId: string,
    replierSessionId: string,
    replierReturnAddress?: string,
  ): (PendingQuestion & { readonly senderReturnAddress?: string }) | undefined {
    return this.awayAsks().question(questionId, replierSessionId, replierReturnAddress);
  }

  /** A session is back under its id: its kept questions route again once both of their peers are connected. */
  restoreDormant(
    sessionId: string,
    returnAddress: string | undefined,
    isConnected: (sessionId: string, returnAddress: string) => boolean,
  ): PendingQuestion[] {
    const restored = this.awayAsks().restore(sessionId, returnAddress, isConnected);
    for (const question of restored) this.record(question.senderSessionId, question.targetSessionId, question.messageId);
    return restored;
  }

  /**
   * Kept questions to a recipient that ended or can no longer answer. Their askers are away, so each gets a failed-ask
   * message held until it is back (#4751).
   */
  failDormantForTarget(
    target: SessionInfo,
    reason: string,
    idPrefix: string,
    targetReturnAddress?: string,
    /** #4997: leave the asks that move to the shared state, which fails them there, once. */
    skipMovable = false,
  ): void {
    const { live } = this.awayAsks().failForTarget(
      target,
      reason,
      idPrefix,
      this.failsThroughOwner,
      targetReturnAddress,
      this.askerConnected,
      skipMovable,
    );
    // #4950: a connected asker's question routes again, so the recipient's end fails it on that route as it does today.
    for (const question of live) this.record(question.senderSessionId, question.targetSessionId, question.messageId);
  }

  private askerConnected: (question: PendingQuestion, returnAddress: string) => boolean = () => false;

  /** #4950: whether a kept question's asker is connected, so its failure is delivered rather than held. */
  failToConnectedAskerWhen(check: (question: PendingQuestion, returnAddress: string) => boolean): void {
    this.askerConnected = check;
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

  /**
   * #5095: the asker saved `replierSessionId`'s reply to `questionId`, so the failures held for that ask (its recipient
   * ended while the reply waited to be saved) are not delivered: the ask has one outcome, its reply.
   */
  releaseHeldFailures(questionId: string, replierSessionId: string, askerReturnAddress: string | undefined): void {
    if (this.away === undefined) return;
    for (const held of this.away.held(askerReturnAddress))
      if (held.message.replyTo === questionId && held.message.replyError !== undefined && held.from.id === replierSessionId)
        this.away.release(held.message.id, askerReturnAddress);
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
    this.writeLive(question);
  }

  /** #4751: failed-ask messages for a released subagent whose recipient ended, by owner and child name. */
  private readonly heldForChildren = new Map<string, HeldAwayMessage[]>();

  holdForReleasedChild(childName: string, ownerSessionId: string, held: HeldAwayMessage): void {
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const list = this.heldForChildren.get(key) ?? [];
    if (list.some((existing) => existing.message.id === held.message.id)) return;
    this.heldForChildren.set(key, [...list, held]);
    const askerReturnAddress = this.returnAddressOf(held.askerSessionId);
    if (askerReturnAddress !== undefined && askerReturnAddress !== "") this.away?.holdLive(held, askerReturnAddress);
  }

  hasHeldForReleasedChild(childName: string, ownerSessionId: string): boolean {
    return (this.heldForChildren.get(JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]))?.length ?? 0) > 0;
  }

  takeHeldForReleasedChild(childName: string, ownerSessionId: string): HeldAwayMessage[] {
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const held = this.heldForChildren.get(key) ?? [];
    this.heldForChildren.delete(key);
    for (const message of held) this.away?.forgetLiveHeld(message.message.id);
    return held;
  }

  takeParkedAskers(childName: string, ownerSessionId: string): PendingQuestion[] {
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const questions = this.parkedAskers.get(key) ?? [];
    this.parkedAskers.delete(key);
    this.forgetLive(questions);
    return questions;
  }

  parkTarget(targetSessionId: string, childName: string, ownerSessionId: string): void {
    // #4992: the link outlives this broker, and covers the asks to the subagent whose asker is away.
    this.awayAsks().park(ownerSessionId, childName, targetSessionId);
    // #4829: a parked route keeps its durable row: it is still waiting for its released recipient.
    const questions = this.removeForTarget(targetSessionId);
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
    this.forgetLive(parked.questions);
    return parked.questions;
  }

  takeParkedForOwner(ownerSessionId: string): PendingQuestion[] {
    const result: PendingQuestion[] = [];
    for (const [key, parked] of this.parked) {
      if (parked.ownerSessionId !== ownerSessionId) continue;
      this.parked.delete(key);
      result.push(...parked.questions);
    }
    this.forgetLive(result);
    return result;
  }

  /**
   * #4992: the owner left, or dropped `childName`: the kept asks to its released subagents (an away asker's, or any
   * after a broker restart) fail, each with a message held for its asker. Returns them, to write a connected asker's.
   */
  failParkedKept(
    ownerSessionId: string,
    childName?: string,
  ): Array<HeldAwayMessage & { readonly askerReturnAddress: string }> {
    return this.awayAsks().failParked(
      ownerSessionId,
      childName,
      (name, targetSessionId) => `Session "${name || targetSessionId}" ended before replying`,
      "ended",
    );
  }

  /**
   * #5101: sessions that are routable but whose routes this broker has not restored yet (their registration is still
   * completing), each with the replies waiting on that restoration. A reply that no route authorizes yet waits here
   * instead of being refused, and is decided again once the routes are restored.
   */
  private readonly restoring = new Map<string, { readonly token: object; readonly waiters: Array<() => void> }>();

  /** #5101: `sessionId` is routable before its routes are restored; returns the token that ends this restoration. */
  beginRestoring(sessionId: string): object {
    const token = {};
    const previous = this.restoring.get(sessionId);
    this.restoring.set(sessionId, { token, waiters: previous?.waiters ?? [] });
    return token;
  }

  /** #5101: the restoration `token` began is over (done, or abandoned): what waited on it is decided again. */
  finishRestoring(sessionId: string, token: object): void {
    const restoring = this.restoring.get(sessionId);
    if (restoring?.token !== token) return;
    this.restoring.delete(sessionId);
    for (const decideAgain of restoring.waiters) decideAgain();
  }

  /**
   * #5101: when `sessionId`'s routes are still being restored, run `decideAgain` once they are (or the restoration is
   * abandoned) and return true; otherwise return false, and the caller decides now.
   */
  whenRestored(sessionId: string, decideAgain: () => void): boolean {
    const restoring = this.restoring.get(sessionId);
    if (restoring === undefined) return false;
    restoring.waiters.push(decideAgain);
    return true;
  }

  /**
   * #5252: asks written to their recipient whose write is not confirmed yet, by message id. Their route opens with the
   * confirmation, but the recipient can read the ask and answer it first: the broker can read that reply before the
   * confirmation reaches it.
   */
  private readonly unconfirmedAsks = new Map<string, { readonly route: PendingQuestion; readonly waiters: (() => void)[] }>();

  /**
   * #5252: an ask from `senderSessionId` is being written to `targetSessionId`; until the returned function runs, once
   * the write settled (after its route opened, or did not), a reply to it waits instead of being refused.
   */
  beginAskWrite(senderSessionId: string, targetSessionId: string, messageId: string): () => void {
    const pending = { route: { senderSessionId, targetSessionId, messageId }, waiters: [] as (() => void)[] };
    this.unconfirmedAsks.set(messageId, pending);
    return () => {
      if (this.unconfirmedAsks.get(messageId) === pending) this.unconfirmedAsks.delete(messageId);
      for (const decideAgain of pending.waiters.splice(0)) decideAgain();
    };
  }

  /**
   * #5252: when the ask `messageId` from `senderSessionId` to `replierSessionId` is still being written, run
   * `decideAgain` once that write settled and return true; otherwise return false, and the caller decides now.
   */
  whenAskWritten(senderSessionId: string, replierSessionId: string, messageId: string, decideAgain: () => void): boolean {
    const pending = this.unconfirmedAsks.get(messageId);
    if (
      pending === undefined ||
      pending.route.senderSessionId !== senderSessionId ||
      pending.route.targetSessionId !== replierSessionId
    )
      return false;
    pending.waiters.push(decideAgain);
    return true;
  }

  /**
   * #5999 durable wake queue: an ask that waited in a queue reached its recipient while its asker is away (closed, or
   * not back since a restart): its route waits for the asker, as the route of an ask whose asker left after it was
   * delivered does, so a reply is held for it until it is back.
   */
  keepForAwayAsker(messageId: string, senderSessionId: string, senderReturnAddress: string): void {
    const routes = this.questions.get(messageId) ?? [];
    const away = routes.filter((route) => route.senderSessionId === senderSessionId);
    if (away.length === 0) return;
    const remaining = routes.filter((route) => route.senderSessionId !== senderSessionId);
    if (remaining.length === 0) this.questions.delete(messageId);
    else this.questions.set(messageId, remaining);
    for (const route of away) this.replied.delete(PendingQuestionIndex.repliedKey(route));
    this.keepDormant(away, senderReturnAddress);
    this.markAwayAsker(senderSessionId, senderReturnAddress);
    this.forgetLive(away);
  }

  record(senderSessionId: string, targetSessionId: string, messageId: string): void {
    const routes = this.questions.get(messageId) ?? [];
    if (routes.some((route) => route.senderSessionId === senderSessionId && route.targetSessionId === targetSessionId)) return;
    const question = { senderSessionId, targetSessionId, messageId };
    routes.push(question);
    this.questions.set(messageId, routes);
    this.writeLive(question);
  }

  private answered: (question: PendingQuestion) => void = () => {};

  /** #4997: told of each ask answered on its route here. */
  onAnswered(listener: (question: PendingQuestion) => void): void {
    this.answered = listener;
  }

	/**
	 * Read-only: whether a reply from `replierSessionId` to the ask `messageId` of `senderSessionId` would wait now
	 * instead of being decided: the ask's write is not confirmed yet (#5252), or either session's routes are still being
	 * restored (#5101).
	 */
	replyWouldWait(senderSessionId: string, replierSessionId: string, messageId: string): boolean {
		const unconfirmed = this.unconfirmedAsks.get(messageId)?.route;
		if (unconfirmed?.senderSessionId === senderSessionId && unconfirmed.targetSessionId === replierSessionId) return true;
		return this.restoring.has(senderSessionId) || this.restoring.has(replierSessionId);
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
  /**
   * #5095: live routes whose reply is on its way to their connected asker: written, or held until the asker saves it.
   * A mark lasts only that long: the asker's save, a write that fails, the reply's receipt lapsing, or the route leaving
   * the live index clears it.
   */
  private readonly replied = new Set<string>();

  /**
   * #5095: asks whose recipient ended while their reply was on its way, with the failure each gets should that reply
   * never arrive. The failure is written durably now, so a broker crash before the asker saves the reply still fails
   * the ask once the asker is back.
   */
  private readonly endedWhileReplying = new Map<
    string,
    { readonly question: PendingQuestion; readonly held: HeldAwayMessage; readonly askerReturnAddress: string | undefined }
  >();

  private replyLost: (question: PendingQuestion, held: HeldAwayMessage, askerReturnAddress: string | undefined) => void =
    () => {};

  /** #5095: told when a reply never reached its asker after its recipient ended, so the broker fails the ask. */
  onReplyLost(
    listener: (question: PendingQuestion, held: HeldAwayMessage, askerReturnAddress: string | undefined) => void,
  ): void {
    this.replyLost = listener;
  }

  private static repliedKey(question: PendingQuestion): string {
    return JSON.stringify([question.messageId, question.senderSessionId, question.targetSessionId]);
  }

  private static replyKey(senderSessionId: string, targetSessionId: string, replyTo: string): string {
    return PendingQuestionIndex.repliedKey({ messageId: replyTo, senderSessionId: targetSessionId, targetSessionId: senderSessionId });
  }

  /** #5095: `senderSessionId`'s reply to `replyTo` is on its way to `targetSessionId`; returns whether it answers a route. */
  markReplied(senderSessionId: string, targetSessionId: string, replyTo: string): boolean {
    if (!this.matchesReply(senderSessionId, targetSessionId, replyTo)) return false;
    this.replied.add(PendingQuestionIndex.replyKey(senderSessionId, targetSessionId, replyTo));
    return true;
  }

  /**
   * #5095: the reply marked by {@link markReplied} did not reach its asker (its write failed, or its receipt lapsed
   * unsaved), so the ask still waits for one; one whose recipient ended meanwhile fails now.
   */
  unmarkReplied(senderSessionId: string, targetSessionId: string, replyTo: string): void {
    const key = PendingQuestionIndex.replyKey(senderSessionId, targetSessionId, replyTo);
    this.replied.delete(key);
    const ended = this.endedWhileReplying.get(key);
    if (ended === undefined) return;
    this.endedWhileReplying.delete(key);
    this.away?.forgetLiveHeld(ended.held.message.id);
    this.replyLost(ended.question, ended.held, ended.askerReturnAddress);
  }

  /**
   * The asker saved `senderSessionId`'s reply to `replyTo`: the ask is answered, so it is forgotten wherever it waits
   * (#5095: the live index, the away store while its recipient is away, or the failure held should its recipient end).
   */
  clearReply(senderSessionId: string, targetSessionId: string, replyTo: string): boolean {
    const key = PendingQuestionIndex.replyKey(senderSessionId, targetSessionId, replyTo);
    this.replied.delete(key);
    // #4765: a released subagent's ask can be kept for its away recipient while it is live again; answered, it is not.
    this.away?.forget({ messageId: replyTo, senderSessionId: targetSessionId, targetSessionId: senderSessionId });
    // #4997: every path settles the ask's shared copy too.
    this.answered({ messageId: replyTo, senderSessionId: targetSessionId, targetSessionId: senderSessionId });
    const ended = this.endedWhileReplying.get(key);
    if (ended !== undefined) {
      // #5095: the asker saved the reply of a recipient that has since ended: answered, its failure is not needed.
      this.endedWhileReplying.delete(key);
      this.away?.forgetLiveHeld(ended.held.message.id);
      return true;
    }
    const routes = this.questions.get(replyTo);
    const index = routes?.findIndex(
      (route) => route.targetSessionId === senderSessionId && route.senderSessionId === targetSessionId,
    ) ?? -1;
    if (!routes || index < 0) return false;
    this.forgetLive(routes.splice(index, 1));
    if (routes.length === 0) this.questions.delete(replyTo);
    return true;
  }

  pruneSender(senderSessionId: string): void {
    this.takeForSender(senderSessionId);
  }

  /**
   * `keepLiveRecords`: the caller writes what replaces each question's live record first, then forgets the ones nothing
   * keeps, so a crash in between loses no ask (a broker adopting both records keeps one).
   */
  takeForSender(senderSessionId: string, options: { readonly keepLiveRecords?: boolean } = {}): PendingQuestion[] {
    const pending: PendingQuestion[] = [];
    for (const [messageId, routes] of this.questions) {
      const remaining = routes.filter((route) => {
        if (route.senderSessionId !== senderSessionId) return true;
        // #5095: its reply is no longer on its way to a connected asker.
        this.replied.delete(PendingQuestionIndex.repliedKey(route));
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
    if (options.keepLiveRecords !== true) this.forgetLive(pending);
    return pending;
  }

  /**
   * `keepLiveRecords`: as for {@link takeForSender}, the caller forgets them once what replaces them is written.
   * `ended`: the recipient ended. #5095: an ask whose reply is on its way is not returned: it is answered unless that
   * reply never reaches its asker, when it fails then (see {@link unmarkReplied}).
   */
  takeForTarget(
    targetSessionId: string,
    options: { readonly keepLiveRecords?: boolean; readonly ended?: SessionInfo } = {},
  ): PendingQuestion[] {
    const pending = this.removeForTarget(targetSessionId, options.ended);
    if (options.keepLiveRecords !== true) this.forgetLive(pending);
    return pending;
  }

  /** #5095: `ended`: the recipient ended, so asks whose reply is on its way wait for that reply's outcome. */
  private removeForTarget(targetSessionId: string, ended?: SessionInfo): PendingQuestion[] {
    const pending: PendingQuestion[] = [];
    for (const [messageId, routes] of this.questions) {
      const remaining = routes.filter((route) => {
        if (route.targetSessionId !== targetSessionId) return true;
        const key = PendingQuestionIndex.repliedKey(route);
        if (this.replied.delete(key) && ended !== undefined) {
          this.awaitReplyOutcome(key, route, ended);
          return false;
        }
        pending.push(route);
        return false;
      });
      if (remaining.length === 0) this.questions.delete(messageId);
      else if (remaining.length !== routes.length) this.questions.set(messageId, remaining);
    }
    return pending;
  }

  /** #5095: the ended recipient's reply to `question` is on its way; its failure is written durably should it not arrive. */
  private awaitReplyOutcome(key: string, question: PendingQuestion, ended: SessionInfo): void {
    const reason = `Session "${ended.name ?? ended.id}" ended before replying`;
    const held: HeldAwayMessage = {
      askerSessionId: question.senderSessionId,
      from: ended,
      message: {
        id: `ended:${question.messageId}`,
        timestamp: Date.now(),
        replyTo: question.messageId,
        replyError: reason,
        content: { text: reason },
      },
    };
    const askerReturnAddress = this.returnAddressOf(question.senderSessionId);
    this.endedWhileReplying.set(key, { question, held, askerReturnAddress });
    // Written before the route's live record goes, so a crash in between leaves the ask one outcome to come.
    if (askerReturnAddress !== undefined && askerReturnAddress !== "") this.away?.holdLive(held, askerReturnAddress);
    this.forgetLive([question]);
  }
}
