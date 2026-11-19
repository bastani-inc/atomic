use super::*;

fn setup() -> (Arc<Actor>, HostSession, OwnerLease, TaskLease, RunnerLease) {
	let actor = Actor::new();
	let scope = OwnerScope::Session { session_id: "s".into() };
	let host = actor.bind(scope.clone());
	let owner = actor.open(&host, scope).unwrap();
	let task = actor.start(&owner, intent(), "op".into()).unwrap();
	let runner = actor.claim(&task).unwrap();
	(actor, host, owner, task, runner)
}
fn intent() -> AgentIntent {
	AgentIntent {
		kind: AgentTaskKind::Agent,
		agent: "fake".into(),
		task: " x ".into(),
		description: None,
		cwd: None,
		parent_task_id: None,
	}
}
fn outcome(id: &str) -> OutcomeReport {
	OutcomeReport {
		report_id: id.into(),
		result: TaskResult::Failed {
			code: "test".into(),
			message: "done".into(),
			output: None,
			exit_code: None,
		},
	}
}

// RFC #2884: yielding is observation-only; execution authority is single-use.
#[test]
fn stable_yield_identity_and_one_runner() {
	let (a, h, o, t, _) = setup();
	let reference = a.task_ref(&t).unwrap();
	let w = a.wait(&t, Some(&h), false).unwrap();
	let first = a.yield_wait(&w, YieldReason::Elapsed).unwrap();
	assert_eq!(first, a.yield_wait(&w, YieldReason::Explicit).unwrap());
	assert_eq!(reference, a.task_ref(&t).unwrap());
	assert_eq!(a.claim(&t).unwrap_err().code, "RunnerUnavailable");
	assert!(matches!(a.snapshot(&o).unwrap().tasks[0].execution, Execution::Running {}));
}
// RFC #2884: exact replay preserves identity; fresh duplicate intent does not.
#[test]
fn operation_replay_and_close_seal() {
	let (a, _, o, t, r) = setup();
	assert_eq!(t.cap, a.start(&o, intent(), "op".into()).unwrap().cap);
	let mut changed = intent();
	changed.task = "x".into();
	assert_eq!(a.start(&o, changed, "op".into()).unwrap_err().code, "OperationConflict");
	assert_ne!(t.cap, a.start(&o, intent(), "other".into()).unwrap().cap);
	a.begin_close(&o).unwrap();
	assert_eq!(a.start(&o, intent(), "late".into()).unwrap_err().code, "OwnerClosing");
	assert!(a.close_receipt(&o).unwrap().is_none());
	assert_eq!(a.outcome(&r, outcome("stop")).unwrap_err().code, "ReportConflict");
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	assert!(a.close_receipt(&o).unwrap().is_some());
}
// RFC #2884: accepted terminal facts and receipts are immutable.
#[test]
fn terminal_replay_and_cancel_precedence() {
	let (a, _, o, t, r) = setup();
	let report = outcome("done");
	let receipt = a.outcome(&r, report.clone()).unwrap();
	assert_eq!(receipt, a.outcome(&r, report).unwrap());
	assert_eq!(a.outcome(&r, outcome("different")).unwrap_err().code, "ReportConflict");
	assert_eq!(a.cancel(&t, CancelCause::User).unwrap().decision, "already-settled");
	assert_eq!(a.wait(&t, None, true).unwrap_err().code, "TaskTerminal");
	assert_eq!(a.start(&o, intent(), "op".into()).unwrap().cap, t.cap);
	let (a, _, _, t, r) = setup();
	a.cancel(&t, CancelCause::User).unwrap();
	assert_eq!(a.outcome(&r, outcome("late")).unwrap_err().code, "ReportConflict");
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	let result = TaskResult::Cancelled { cause: CancelCause::User, output: None };
	assert_eq!(
		a.cancel(&t, CancelCause::Shutdown).unwrap().execution,
		Execution::Settled { result }
	);
}
// RFC #2884: SDK observers cannot steal host designation or cancel execution.
#[test]
fn designation_and_observer_disposal() {
	let (a, h, o, t, r) = setup();
	let host = a.wait(&t, Some(&h), false).unwrap();
	let sdk = a.wait(&t, None, false).unwrap();
	a.yield_wait(&sdk, YieldReason::Elapsed).unwrap();
	assert_eq!(
		a.snapshot(&o).unwrap().tasks[0].observation,
		HostObservation::Foreground { wait_id: host.id() }
	);
	a.dispose_wait(&host).unwrap();
	assert_eq!(a.wait_outcome(&host).unwrap().unwrap().unwrap_err().code, "ObserverCancelled");
	assert_eq!(
		a.snapshot(&o).unwrap().tasks[0].observation,
		HostObservation::Background { reason: "observer-cancelled".into() }
	);
	let w = a.wait(&t, None, false).unwrap();
	a.outcome(&r, outcome("done")).unwrap();
	assert!(matches!(a.yield_wait(&w, YieldReason::Explicit).unwrap(), WaitOutcome::Settled { .. }));
}
// RFC #2884: actor-owned records, not JavaScript references, are Send + Sync.
#[test]
fn environment_scope_generation_and_send_sync() {
	fn assert_send_sync<T: Send + Sync>() {}
	assert_send_sync::<Actor>();
	assert_send_sync::<State>();
	let (a, h, o, t, r) = setup();
	let b = Actor::new();
	assert_eq!(b.start(&o, intent(), "op".into()).unwrap_err().code, "OwnerClosing");
	assert_eq!(b.outcome(&r, outcome("x")).unwrap_err().code, "StaleAttempt");
	assert_eq!(
		a.open(&h, OwnerScope::Session { session_id: "other".into() }).unwrap_err().code,
		"ScopeMismatch"
	);
	let mut stale = t.clone();
	stale.cap.generation += 1;
	assert_eq!(a.wait(&stale, None, false).unwrap_err().code, "UnknownTask");
	a.shutdown();
	assert_eq!(a.open(&h, h.scope.clone()).unwrap_err().code, "EnvironmentClosing");
}
// RFC #2884: snapshot and deltas are atomic and retained gaps reconcile explicitly.
#[test]
fn snapshot_journal_gap_and_decimal_u64() {
	let (a, _, o, t, _) = setup();
	a.state.lock().unwrap().sequence = 9_007_199_254_740_992;
	let (s, snapshot) = a.watch(&o, None).unwrap();
	let w = a.wait(&t, None, false).unwrap();
	a.yield_wait(&w, YieldReason::Elapsed).unwrap();
	let events = a.drain(&s).unwrap();
	assert!(!events.reset);
	assert!(!events.events.is_empty());
	assert!(
		events.events[0].cursor.sequence.parse_u64().unwrap()
			> snapshot.cursor.sequence.parse_u64().unwrap()
	);
	assert!(events.events[0].cursor.sequence.parse_u64().unwrap() > 9_007_199_254_740_991);
	let old = snapshot.cursor;
	for _ in 0..600 {
		let w = a.wait(&t, None, false).unwrap();
		a.yield_wait(&w, YieldReason::Explicit).unwrap();
	}
	assert!(a.drain(&s).unwrap().reset);
	let (sub, reset_snapshot) = a.watch(&o, Some(old)).unwrap();
	assert_eq!(reset_snapshot.cursor, a.snapshot(&o).unwrap().cursor);
	assert!(a.drain(&sub).unwrap().events.is_empty());
	a.dispose_subscription(&sub);
	a.dispose_subscription(&sub);
	assert_eq!(a.snapshot(&o).unwrap().state, "open");
}

// RFC #2884: report identity includes raw text, zero metrics and exact HIL request identity.
#[test]
fn activity_replay_metrics_and_attention() {
	let (a, _, o, _, r) = setup();
	assert_eq!(a.snapshot(&o).unwrap().tasks[0].metrics, None);
	let report = ActivityReport {
		report_id: "metrics".into(),
		change: ActivityChange::Metrics {
			elapsed_ms: Some(0.0),
			tool_count: None,
			token_count: None,
		},
	};
	let accepted = a.activity(&r, report.clone()).unwrap();
	let duplicate = a.activity(&r, report).unwrap();
	assert_eq!(accepted.cursor, duplicate.cursor);
	assert_eq!(duplicate.disposition, "duplicate");
	assert_eq!(
		a.snapshot(&o).unwrap().tasks[0].metrics,
		Some(TaskMetrics { elapsed_ms: Some(0.0), tool_count: None, token_count: None })
	);
	let attention = Attention::InputNeeded {
		request_id: "q8".into(),
		prompt: "".into(),
		route: PromptRoute { session_id: "s".into(), prompt_id: "q8".into(), stage_attempt_id: None },
	};
	a.activity(
		&r,
		ActivityReport {
			report_id: "hil".into(),
			change: ActivityChange::AttentionSet { attention: attention.clone() },
		},
	)
	.unwrap();
	a.activity(
		&r,
		ActivityReport {
			report_id: "stale-clear".into(),
			change: ActivityChange::AttentionClear { request_id: "q7".into() },
		},
	)
	.unwrap();
	assert_eq!(a.snapshot(&o).unwrap().tasks[0].attention, attention);
	a.activity(
		&r,
		ActivityReport {
			report_id: "clear".into(),
			change: ActivityChange::AttentionClear { request_id: "q8".into() },
		},
	)
	.unwrap();
	assert_eq!(a.snapshot(&o).unwrap().tasks[0].attention, Attention::None {});
	assert_eq!(
		a.activity(
			&r,
			ActivityReport {
				report_id: "hil".into(),
				change: ActivityChange::AttentionClear { request_id: "q8".into() }
			}
		)
		.unwrap_err()
		.code,
		"ReportConflict"
	);
	a.outcome(&r, outcome("done")).unwrap();
	assert_eq!(
		a.activity(
			&r,
			ActivityReport {
				report_id: "late".into(),
				change: ActivityChange::Action { tool: "bash".into(), text: " raw ".into() }
			}
		)
		.unwrap_err()
		.code,
		"TaskTerminal"
	);
}

// RFC #2884: wait replay belongs to the live capability, not an ever-growing actor history.
#[test]
fn released_wait_records_are_reclaimed() {
	let (a, _, _, t, _) = setup();
	let retained = a.wait(&t, None, false).unwrap();
	let expected = a.yield_wait(&retained, YieldReason::Explicit).unwrap();
	for _ in 0..1000 {
		let w = a.wait(&t, None, false).unwrap();
		a.yield_wait(&w, YieldReason::Elapsed).unwrap();
	}
	assert!(a.state.lock().unwrap().waits.len() <= 2);
	assert_eq!(a.yield_wait(&retained, YieldReason::Elapsed).unwrap(), expected);
}

// RFC #2884: terminal settlement already accepted wins registration and yield.
#[test]
fn settled_before_wait_and_live_scope_rebinding() {
	let (a, h, o, t, r) = setup();
	assert_eq!(a.open(&h, h.scope.clone()).unwrap().cap, o.cap);
	a.outcome(&r, outcome("done")).unwrap();
	let w = a.wait(&t, Some(&h), false).unwrap();
	assert!(matches!(
		a.yield_wait(&w, YieldReason::DefaultBackground).unwrap(),
		WaitOutcome::Settled { .. }
	));
	a.begin_close(&o).unwrap();
	assert_eq!(a.open(&h, h.scope.clone()).unwrap_err().code, "ScopeMismatch");
	assert_eq!(a.watch(&o, None).unwrap_err().code, "OwnerClosed");
}

// RFC #2884: a natural result is not proof that the fake runner lifetime ended.
#[test]
fn natural_settlement_does_not_reap_runner_or_close_owner() {
	let (a, _, o, t, r) = setup();
	let report = outcome("natural");
	let receipt = a.outcome(&r, report.clone()).unwrap();
	assert!(!matches!(a.snapshot(&o).unwrap().tasks[0].cleanup, Cleanup::Reaped {}));
	a.begin_close(&o).unwrap();
	assert!(a.close_receipt(&o).unwrap().is_none());
	assert_eq!(a.snapshot(&o).unwrap().state, "closing");
	assert_eq!(a.outcome(&r, report).unwrap(), receipt);
	assert_eq!(
		a.cancel(&t, CancelCause::User).unwrap().execution,
		Execution::Settled { result: receipt.result }
	);
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	let closed = a.close_receipt(&o).unwrap().unwrap();
	assert_eq!(closed.tasks[0].cleanup, Cleanup::Reaped {});
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	a.begin_close(&o).unwrap();
	assert_eq!(a.close_receipt(&o).unwrap().unwrap(), closed);
}

// RFC #2884: cancellation rejects late success and settles only on confirmed stop.
#[test]
fn cancellation_rejects_late_success_until_runner_acknowledges_stop() {
	let (a, _, o, t, r) = setup();
	let w = a.wait(&t, None, false).unwrap();
	let mut output = a.snapshot(&o).unwrap().tasks[0].output.clone();
	output.byte_count = "42".into();
	let late = OutcomeReport {
		report_id: "late-success".into(),
		result: TaskResult::Completed { output: output.clone(), exit_code: Some(0.0) },
	};
	let requested = a.cancel(&t, CancelCause::User).unwrap();
	assert_eq!(requested.cleanup, Cleanup::Draining {});
	assert_eq!(a.outcome(&r, late.clone()).unwrap_err().code, "ReportConflict");
	assert_eq!(a.cancel(&t, CancelCause::Shutdown).unwrap(), requested);
	assert!(a.wait_outcome(&w).unwrap().is_none());
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	let expected = TaskResult::Cancelled { cause: CancelCause::User, output: Some(output) };
	assert_eq!(
		a.wait_outcome(&w).unwrap().unwrap().unwrap(),
		WaitOutcome::Settled { task_id: a.task_ref(&t).unwrap().task_id, result: expected.clone() }
	);
	let stopped = a.cancel(&t, CancelCause::Shutdown).unwrap();
	assert_eq!(stopped.execution, Execution::Settled { result: expected });
	assert_eq!(stopped.cleanup, Cleanup::Reaped {});
	assert_eq!(a.outcome(&r, late).unwrap_err().code, "ReportConflict");
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	assert_eq!(a.cancel(&t, CancelCause::OwnerClose).unwrap(), stopped);
}

// RFC #2884: failed cleanup retains resources and closing state until every runner reaps.
#[test]
fn cleanup_failure_retry_and_ordered_close_receipts() {
	let (a, _, o, t, r) = setup();
	let second = a.start(&o, intent(), "second".into()).unwrap();
	let other_runner = a.claim(&second).unwrap();
	let queued = a.start(&o, intent(), "queued".into()).unwrap();
	let report = outcome("natural");
	let settled = a.outcome(&r, report.clone()).unwrap();
	a.begin_close(&o).unwrap();
	let failure = Cleanup::Failed {
		resources: vec![ResourceFailure {
			resource: "fake-runner-lifetime".into(),
			code: "CleanupFailed".into(),
			message: "not stopped".into(),
		}],
	};
	a.acknowledge_cleanup(&r, failure.clone()).unwrap();
	assert_eq!(a.close_receipt(&o).unwrap_err().code, "CleanupFailed");
	assert_eq!(a.cancel(&t, CancelCause::User).unwrap_err().code, "CleanupFailed");
	a.begin_close(&o).unwrap();
	let snapshot = a.snapshot(&o).unwrap();
	assert_eq!(snapshot.state, "closing");
	assert_eq!(snapshot.tasks[0].cleanup, failure);
	assert_eq!(snapshot.tasks[2].cleanup, Cleanup::Reaped {});
	assert_eq!(a.claim(&queued).unwrap_err().code, "OwnerClosing");
	assert_eq!(a.outcome(&r, report.clone()).unwrap(), settled);
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	assert!(a.close_receipt(&o).unwrap().is_none());
	a.acknowledge_cleanup(&other_runner, Cleanup::Reaped {}).unwrap();
	let closed = a.close_receipt(&o).unwrap().unwrap();
	assert_eq!(
		closed.tasks.iter().map(|t| t.task_id.clone()).collect::<Vec<_>>(),
		vec![
			a.task_ref(&t).unwrap().task_id,
			a.task_ref(&second).unwrap().task_id,
			a.task_ref(&queued).unwrap().task_id
		]
	);
	assert!(closed.tasks.iter().all(|t| t.cleanup == Cleanup::Reaped {}));
	assert_eq!(a.outcome(&r, report).unwrap(), settled);
	assert_eq!(a.acknowledge_cleanup(&r, failure).unwrap_err().code, "ReportConflict");
	a.begin_close(&o).unwrap();
	assert_eq!(a.close_receipt(&o).unwrap().unwrap(), closed);
}

// RFC #2884: cancellation cannot erase diagnostics or grant stale runners cleanup authority.
#[test]
fn failed_cleanup_survives_cancellation_and_reaped_cannot_regress() {
	let (a, _, o, t, r) = setup();
	assert_eq!(a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap_err().code, "ReportConflict");
	let failure = Cleanup::Failed {
		resources: vec![ResourceFailure {
			resource: "fake-runner".into(),
			code: "CleanupFailed".into(),
			message: "pending".into(),
		}],
	};
	a.acknowledge_cleanup(&r, failure.clone()).unwrap();
	a.begin_close(&o).unwrap();
	assert_eq!(a.snapshot(&o).unwrap().tasks[0].cleanup, failure);
	assert_eq!(a.close_receipt(&o).unwrap_err().code, "CleanupFailed");
	assert_eq!(a.acknowledge_cleanup(&r, Cleanup::Draining {}).unwrap_err().code, "ReportConflict");
	let mut stale = r.clone();
	stale.cap.attempt += 1;
	assert_eq!(a.acknowledge_cleanup(&stale, Cleanup::Reaped {}).unwrap_err().code, "StaleAttempt");
	assert_eq!(
		Actor::new().acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap_err().code,
		"StaleAttempt"
	);
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	let receipt = a.close_receipt(&o).unwrap().unwrap();
	assert_eq!(a.acknowledge_cleanup(&r, failure).unwrap_err().code, "ReportConflict");
	assert_eq!(a.cancel(&t, CancelCause::User).unwrap(), receipt.tasks[0]);
}

// A runner that cannot confirm cleanup after a stop must still end the task: it never stays "stopping".
#[test]
fn cancellation_with_failed_cleanup_settles_and_keeps_the_failure() {
	let (a, _, o, t, r) = setup();
	let w = a.wait(&t, None, false).unwrap();
	a.cancel(&t, CancelCause::Pause).unwrap();
	let failure = Cleanup::Failed {
		resources: vec![ResourceFailure {
			resource: "fake-runner".into(),
			code: "CleanupFailed".into(),
			message: "not stopped".into(),
		}],
	};
	a.acknowledge_cleanup(&r, failure.clone()).unwrap();
	// An agent's stop keeps its cause, so a paused agent stays resumable.
	let expected = TaskResult::Cancelled { cause: CancelCause::Pause, output: None };
	assert_eq!(
		a.wait_outcome(&w).unwrap().unwrap().unwrap(),
		WaitOutcome::Settled { task_id: a.task_ref(&t).unwrap().task_id, result: expected.clone() }
	);
	let task = a.snapshot(&o).unwrap().tasks[0].clone();
	assert_eq!(task.execution, Execution::Settled { result: expected });
	assert_eq!(task.cleanup, failure);
	// A later confirmation still records the reap.
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	assert_eq!(a.snapshot(&o).unwrap().tasks[0].cleanup, Cleanup::Reaped {});
}

// #4338: quarantined cleanup follows a settled result, keeps the owner closing, and ends reaped or failed.
#[test]
fn quarantined_cleanup_holds_close_until_it_resolves_4338() {
	let (a, _, o, t, r) = setup();
	let quarantine = Cleanup::Quarantined {
		resources: vec![ResourceFailure {
			resource: "process-group:1".into(),
			code: "CleanupUnconfirmed".into(),
			message: "Output reader drain was not confirmed".into(),
		}],
	};
	let failure = Cleanup::Failed {
		resources: vec![ResourceFailure {
			resource: "process-group:1".into(),
			code: "CleanupFailed".into(),
			message: "Output reader drain was not confirmed".into(),
		}],
	};
	assert_eq!(a.acknowledge_cleanup(&r, quarantine.clone()).unwrap_err().code, "ReportConflict");
	let settled = a.outcome(&r, outcome("natural")).unwrap();
	a.acknowledge_cleanup(&r, quarantine.clone()).unwrap();
	assert_eq!(a.acknowledge_cleanup(&r, quarantine.clone()).unwrap(), quarantine);
	assert_eq!(a.acknowledge_cleanup(&r, Cleanup::Draining {}).unwrap_err().code, "ReportConflict");
	let other = Cleanup::Quarantined { resources: vec![] };
	assert_eq!(a.acknowledge_cleanup(&r, other).unwrap_err().code, "ReportConflict");
	a.begin_close(&o).unwrap();
	assert!(a.close_receipt(&o).unwrap().is_none(), "quarantine must keep the owner closing");
	let receipt = a.cancel(&t, CancelCause::User).unwrap();
	assert_eq!(receipt.cleanup, quarantine);
	assert_eq!(receipt.execution, Execution::Settled { result: settled.result.clone() });
	a.acknowledge_cleanup(&r, failure.clone()).unwrap();
	assert_eq!(a.close_receipt(&o).unwrap_err().code, "CleanupFailed");
	assert_eq!(a.acknowledge_cleanup(&r, quarantine.clone()).unwrap_err().code, "ReportConflict");
	assert_eq!(
		a.snapshot(&o).unwrap().tasks[0].execution,
		Execution::Settled { result: settled.result }
	);
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	assert!(a.close_receipt(&o).unwrap().is_some());
	assert_eq!(a.acknowledge_cleanup(&r, quarantine).unwrap_err().code, "ReportConflict");
}

// #4338: a stop whose cleanup is quarantined ends as a stop at once, like a failed one, then confirms later.
#[test]
fn cancellation_with_quarantined_cleanup_settles_then_reaps_4338() {
	let (a, _, o, t, r) = setup();
	a.cancel(&t, CancelCause::Pause).unwrap();
	let quarantine = Cleanup::Quarantined {
		resources: vec![ResourceFailure {
			resource: "fake-runner".into(),
			code: "CleanupUnconfirmed".into(),
			message: "not yet stopped".into(),
		}],
	};
	a.acknowledge_cleanup(&r, quarantine.clone()).unwrap();
	let task = a.snapshot(&o).unwrap().tasks[0].clone();
	assert_eq!(
		task.execution,
		Execution::Settled {
			result: TaskResult::Cancelled { cause: CancelCause::Pause, output: None }
		}
	);
	assert_eq!(task.cleanup, quarantine);
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	assert_eq!(a.snapshot(&o).unwrap().tasks[0].cleanup, Cleanup::Reaped {});
}

// RFC #2884: shutdown fences an unresolved close rather than waiting forever for dead JS.
#[test]
fn environment_shutdown_releases_pending_close_without_false_reaping() {
	let (a, _, o, _, _) = setup();
	a.begin_close(&o).unwrap();
	assert!(a.close_receipt(&o).unwrap().is_none());
	a.shutdown();
	assert_eq!(a.close_receipt(&o).unwrap_err().code, "EnvironmentClosing");
	let snapshot = a.snapshot(&o).unwrap();
	assert_eq!(snapshot.state, "closing");
	assert_eq!(snapshot.tasks[0].cleanup, Cleanup::Draining {});
}

// RFC #2884: oversized final facts leave a dirty cursor recoverable without a later event.
#[test]
fn oversized_final_event_recovers_through_polled_drain_snapshot() {
	let (a, _, o, _, r) = setup();
	let (sub, initial) = a.watch(&o, None).unwrap();
	let report = OutcomeReport {
		report_id: "oversized-final".into(),
		result: TaskResult::Failed {
			code: "fake".into(),
			message: "raw final ".repeat(10_000).into(),
			output: None,
			exit_code: None,
		},
	};
	let settled = a.outcome(&r, report.clone()).unwrap();
	assert!(a.state.lock().unwrap().journal.is_empty());
	// There is no authentic NativeEvent to wake JS with. The host's bounded poll drains.
	let drain = a.drain(&sub).unwrap();
	assert!(drain.reset);
	assert!(drain.events.is_empty());
	assert!(!drain.failed);
	assert_ne!(drain.cursor, initial.cursor);
	assert_eq!(drain.cursor, settled.cursor);
	assert_eq!(
		drain.snapshot.unwrap().tasks[0].execution,
		Execution::Settled { result: report.result.clone() }
	);
	let idle = a.drain(&sub).unwrap();
	assert!(!idle.reset);
	assert!(idle.events.is_empty());
	assert_eq!(idle.cursor, drain.cursor);
	assert_eq!(a.outcome(&r, report).unwrap(), settled);
}

// RFC #2884: output activity is raw data; journal eviction must not alter exact report replay.
#[test]
fn raw_output_activity_and_replay_survive_bounded_journal_eviction() {
	let (a, _, o, _, r) = setup();
	let (sub, _) = a.watch(&o, None).unwrap();
	let report = ActivityReport {
		report_id: "output".into(),
		change: ActivityChange::Output {
			offset: "9007199254740993".into(),
			bytes_base64: "AP8NCg==".into(),
		},
	};
	let first = a.activity(&r, report.clone()).unwrap();
	let event = a.drain(&sub).unwrap().events.pop().unwrap();
	assert!(matches!(event.payload, TaskEvent::TaskActivity { activity, .. } if activity == report));
	for index in 0..200 {
		a.activity(
			&r,
			ActivityReport {
				report_id: index.to_string().into(),
				change: ActivityChange::Output {
					offset: index.to_string().into(),
					bytes_base64: "AAAA".repeat(1024).into(),
				},
			},
		)
		.unwrap();
		assert!(a.state.lock().unwrap().journal_bytes <= 64 * 1024);
	}
	assert!(a.drain(&sub).unwrap().reset);
	let replay = a.activity(&r, report.clone()).unwrap();
	assert_eq!(replay.cursor, first.cursor);
	assert_eq!(replay.disposition, "duplicate");
	let conflict = ActivityReport {
		change: ActivityChange::Output { offset: "9007199254740993".into(), bytes_base64: "".into() },
		..report
	};
	assert_eq!(a.activity(&r, conflict).unwrap_err().code, "ReportConflict");
}

// RFC #2884: native queue errors reconcile once, even when no later task fact arrives.
#[test]
fn callback_queue_full_and_exception_reset_then_closing_releases_subscription() {
	let (a, _, o, _, _) = setup();
	let (sub, initial) = a.watch(&o, None).unwrap();
	let pending = AtomicBool::new(true);
	assert!(subscription_call_status(&a, &sub, &pending, Status::QueueFull));
	assert!(!pending.load(Ordering::Acquire));
	let recovered = a.drain(&sub).unwrap();
	assert!(recovered.failed && recovered.reset);
	assert_eq!(recovered.snapshot.unwrap(), initial);
	assert!(!a.drain(&sub).unwrap().failed);
	// The TSFN's caught exception path records the same failed subscription.
	a.subscription_failed(&sub);
	assert!(a.drain(&sub).unwrap().failed);
	assert!(!subscription_call_status(&a, &sub, &pending, Status::Closing));
	assert_eq!(a.drain(&sub).unwrap_err().code, "OwnerClosed");
	assert!(a.state.lock().unwrap().subscriptions.is_empty());
	assert_eq!(a.snapshot(&o).unwrap().state, "open");
	a.dispose_subscription(&sub);
}

// RFC #2884: preserve the numeric budget, including fractional ms and >u32.
#[test]
fn timer_duration_preserves_default_wide_and_fractional_budgets() {
	use super::waits::timer_delay;
	assert_eq!(timer_delay(30000.0, Duration::ZERO), Duration::from_secs(30));
	assert_eq!(timer_delay(0.0, Duration::ZERO), Duration::ZERO);
	assert_eq!(timer_delay(0.5, Duration::ZERO), Duration::from_micros(500));
	let wide = 4294967296.0;
	assert_eq!(timer_delay(wide, Duration::ZERO), Duration::from_secs(86400));
	assert_eq!(timer_delay(wide, Duration::from_millis(4294937296)), Duration::from_secs(30));
	assert_eq!(timer_delay(wide, Duration::from_millis(4294967296)), Duration::ZERO);
	// A scheduling horizon does not truncate the total budget or overflow Instant.
	assert_eq!(timer_delay(f64::MAX, Duration::from_secs(86400)), Duration::from_secs(86400));
}

// RFC #2884: accepted NaN must not unwind scheduling or spin on a zero delay.
#[test]
fn timer_duration_handles_nan_without_changing_other_numeric_budgets() {
	use super::waits::timer_delay;
	for elapsed in [Duration::ZERO, Duration::from_secs(86400), Duration::MAX] {
		for budget in [f64::NAN, -f64::NAN, f64::INFINITY, f64::MAX] {
			assert_eq!(timer_delay(budget, elapsed), Duration::from_secs(86400));
		}
		for budget in [f64::NEG_INFINITY, -f64::MAX, -1.0, -0.0, 0.0, f64::from_bits(1)] {
			assert_eq!(timer_delay(budget, elapsed), Duration::ZERO);
		}
	}
	assert_eq!(timer_delay(0.5, Duration::from_micros(100)), Duration::from_micros(400));
}

// RFC #2884: every optional metric preserves numeric identity, alone and in combination.
#[test]
fn exact_metric_report_replay_and_snapshots() {
	let values = [
		None,
		Some(f64::NAN),
		Some(-0.0),
		Some(0.0),
		Some(0.5),
		Some(-0.5),
		Some(f64::MAX),
		Some(-f64::MAX),
		Some(f64::from_bits(1)),
		Some(-f64::from_bits(1)),
		Some(9007199254740994.0),
		Some(f64::INFINITY),
		Some(f64::NEG_INFINITY),
		Some(4294967296.0),
		Some(f64::from_bits(f64::NAN.to_bits() + 1)),
	];
	let (a, _, o, _, r) = setup();
	let mut expected = TaskMetrics::default();
	let mut index = 0;
	for elapsed_ms in values {
		for tool_count in values {
			for token_count in values {
				let fields = [elapsed_ms, tool_count, token_count];
				let report = ActivityReport {
					report_id: format!(" metric {index} \n").into(),
					change: ActivityChange::Metrics { elapsed_ms, tool_count, token_count },
				};
				index += 1;
				let accepted = a.activity(&r, report.clone()).unwrap();
				let mut duplicate = accepted.clone();
				duplicate.disposition = "duplicate".into();
				assert_eq!(a.activity(&r, report.clone()).unwrap(), duplicate);
				for field in 0..3 {
					for replacement in values {
						if fields[field].map(f64::to_bits) == replacement.map(f64::to_bits) {
							continue;
						}
						let mut changed = fields;
						changed[field] = replacement;
						let change = ActivityChange::Metrics {
							elapsed_ms: changed[0],
							tool_count: changed[1],
							token_count: changed[2],
						};
						assert_eq!(
							a.activity(&r, ActivityReport { report_id: report.report_id.clone(), change })
								.unwrap_err()
								.code,
							"ReportConflict"
						);
					}
				}
				if elapsed_ms.is_some() {
					expected.elapsed_ms = elapsed_ms;
				}
				if tool_count.is_some() {
					expected.tool_count = tool_count;
				}
				if token_count.is_some() {
					expected.token_count = token_count;
				}
				let snapshot = a.snapshot(&o).unwrap();
				assert_eq!(snapshot.cursor, accepted.cursor, "replay and refusal do not append events");
				let metrics = snapshot.tasks[0].metrics.as_ref().unwrap();
				assert_eq!(metrics.elapsed_ms.map(f64::to_bits), expected.elapsed_ms.map(f64::to_bits));
				assert_eq!(metrics.tool_count.map(f64::to_bits), expected.tool_count.map(f64::to_bits));
				assert_eq!(
					metrics.token_count.map(f64::to_bits),
					expected.token_count.map(f64::to_bits)
				);
				assert_eq!(metrics, &expected);
			}
		}
	}
}

// RFC #2884, authorized retention amendment: only the latest 256 accepted activity IDs replay.
#[test]
fn report_identity_window_evicts_in_actor_order_without_retaining_payloads() {
	let (a, _, o, t, r) = setup();
	let other = a.start(&o, intent(), "other".into()).unwrap();
	let other_runner = a.claim(&other).unwrap();
	let report = |index: usize| ActivityReport {
		report_id: index.to_string().into(),
		change: ActivityChange::Action { tool: "raw".into(), text: index.to_string().into() },
	};
	let first = a.activity(&r, report(0)).unwrap();
	for index in 1..256 {
		a.activity(&r, report(index)).unwrap();
	}
	let cursor = a.snapshot(&o).unwrap().cursor;
	for index in 0..256 {
		assert_eq!(a.activity(&r, report(index)).unwrap().disposition, "duplicate");
		let conflict = ActivityReport {
			change: ActivityChange::Output { offset: "".into(), bytes_base64: "".into() },
			..report(index)
		};
		assert_eq!(a.activity(&r, conflict).unwrap_err().code, "ReportConflict");
	}
	assert_eq!(a.snapshot(&o).unwrap().cursor, cursor);
	assert_eq!(a.activity(&other_runner, report(0)).unwrap().disposition, "accepted");
	a.activity(&r, report(256)).unwrap();
	let replay = a.activity(&r, report(0)).unwrap();
	assert_eq!(replay.disposition, "accepted");
	assert_ne!(replay.cursor, first.cursor);
	assert_eq!(a.snapshot(&o).unwrap().tasks[0].current_action.as_ref().unwrap().text, "0".into());
	assert_eq!(a.activity(&r, report(1)).unwrap().disposition, "accepted");
	assert_eq!(a.activity(&other_runner, report(0)).unwrap().disposition, "duplicate");
	assert_eq!(a.start(&o, intent(), "op".into()).unwrap().cap, t.cap);
	let terminal = a.outcome(&r, outcome("terminal")).unwrap();
	for index in 1..600 {
		a.activity(&other_runner, report(index)).unwrap();
	}
	assert_eq!(a.outcome(&r, outcome("terminal")).unwrap(), terminal);
	assert_eq!(a.outcome(&r, outcome("late")).unwrap_err().code, "ReportConflict");
	assert_eq!(a.activity(&r, report(2)).unwrap_err().code, "TaskTerminal");
	let state = a.state.lock().unwrap();
	assert!(state.owners[0].tasks.iter().all(|task| task.activities.len() <= 256));
	assert!(state.journal_bytes <= 64 * 1024);
	drop(state);
	a.begin_close(&o).unwrap();
	assert_eq!(a.activity(&other_runner, report(0)).unwrap_err().code, "OwnerClosing");
	assert_eq!(a.activity(&other_runner, report(599)).unwrap().disposition, "duplicate");
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	a.acknowledge_cleanup(&other_runner, Cleanup::Reaped {}).unwrap();
	assert!(a.close_receipt(&o).unwrap().is_some());
	assert_eq!(a.outcome(&r, outcome("terminal")).unwrap(), terminal);
}

// RFC #2884: journal eviction must release full report payloads, not merely their events.
#[test]
fn report_identity_storage_does_not_keep_activity_payloads() {
	let (a, _, _, _, r) = setup();
	let payload = "unique-retention-payload".repeat(4096);
	a.activity(
		&r,
		ActivityReport {
			report_id: "payload".into(),
			change: ActivityChange::Output {
				offset: "0".into(),
				bytes_base64: payload.clone().into(),
			},
		},
	)
	.unwrap();
	let state = a.state.lock().unwrap();
	assert!(!format!("{:?}", state.owners[0].tasks[0].activities).contains(&payload));
	assert!(state.journal.is_empty());
}

// RFC #2884: n retained caller IDs cannot block n+1 host terminal candidates.
#[test]
fn runner_terminal_identity_collision_and_replay() {
	for count in [0, 1, TASK_REPORT_IDENTITY_WINDOW] {
		let (a, _, o, t, r) = setup();
		let id = |index| {
			if index == 0 { "runner-outcome".to_owned() } else { format!("runner-outcome-{index}") }
		};
		for index in 0..count {
			a.activity(
				&r,
				ActivityReport {
					report_id: id(index).into(),
					change: ActivityChange::Action { tool: "".into(), text: " raw ".into() },
				},
			)
			.unwrap();
			assert_eq!(a.outcome(&r, outcome(&id(index))).unwrap_err().code, "ReportConflict");
		}
		let before = a.snapshot(&o).unwrap().cursor.sequence.parse_u64().unwrap();
		let report = outcome(&id(count));
		let receipt = a.runner_outcome(&r, report.result.clone()).unwrap();
		assert_eq!(receipt.cursor.sequence.parse_u64().unwrap() - before, 2);
		assert_eq!(a.outcome(&r, report.clone()).unwrap(), receipt);
		assert_eq!(a.runner_outcome(&r, report.result.clone()).unwrap(), receipt);
		let conflict = TaskResult::Cancelled { cause: CancelCause::User, output: None };
		assert_eq!(a.runner_outcome(&r, conflict).unwrap_err().code, "ReportConflict");
		assert_eq!(a.cancel(&t, CancelCause::User).unwrap().decision, "already-settled");
		a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
		a.begin_close(&o).unwrap();
		assert!(a.close_receipt(&o).unwrap().is_some());
		assert_eq!(a.runner_outcome(&r, report.result).unwrap(), receipt);
	}
}

// RFC #2884: internal identity selection must not retry past cancellation or stale authority.
#[test]
fn runner_terminal_identity_preserves_cancellation_fence() {
	let (a, _, o, t, r) = setup();
	a.activity(
		&r,
		ActivityReport {
			report_id: "runner-outcome".into(),
			change: ActivityChange::Action { tool: "".into(), text: "".into() },
		},
	)
	.unwrap();
	a.cancel(&t, CancelCause::User).unwrap();
	let before = a.snapshot(&o).unwrap().cursor;
	let late = outcome("unused").result;
	assert_eq!(a.runner_outcome(&r, late.clone()).unwrap_err().code, "ReportConflict");
	assert_eq!(a.snapshot(&o).unwrap().cursor, before);
	a.acknowledge_cleanup(&r, Cleanup::Reaped {}).unwrap();
	assert_eq!(a.runner_outcome(&r, late.clone()).unwrap_err().code, "ReportConflict");
	assert_eq!(
		a.snapshot(&o).unwrap().tasks[0].execution,
		Execution::Settled {
			result: TaskResult::Cancelled { cause: CancelCause::User, output: None }
		}
	);
	let mut stale = r.clone();
	stale.cap.attempt += 1;
	assert_eq!(a.runner_outcome(&stale, late).unwrap_err().code, "StaleAttempt");
}
