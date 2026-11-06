use super::*;
use retention::FINISHED_TASK_RETENTION;

fn owner() -> (Arc<Actor>, OwnerLease) {
	let actor = Actor::new();
	let scope = OwnerScope::Session { session_id: "retention".into() };
	let host = actor.bind(scope.clone());
	let owner = actor.open(&host, scope).unwrap();
	(actor, owner)
}
fn intent() -> AgentIntent {
	AgentIntent {
		kind: AgentTaskKind::Agent,
		agent: "fake".into(),
		task: "x".into(),
		description: None,
		cwd: None,
		parent_task_id: None,
	}
}
fn done() -> OutcomeReport {
	OutcomeReport {
		report_id: "done".into(),
		result: TaskResult::Failed {
			code: "test".into(),
			message: "done".into(),
			output: None,
			exit_code: None,
		},
	}
}
fn running(actor: &Actor, owner: &OwnerLease, operation: &str) -> (TaskLease, RunnerLease) {
	let task = actor.start(owner, intent(), operation.into()).unwrap();
	let runner = actor.claim(&task).unwrap();
	(task, runner)
}
fn finish(actor: &Actor, runner: &RunnerLease) {
	actor.outcome(runner, done()).unwrap();
	actor.acknowledge_cleanup(runner, Cleanup::Reaped {}).unwrap();
}
fn finished(actor: &Actor, owner: &OwnerLease, operation: &str) -> TaskLease {
	let (task, runner) = running(actor, owner, operation);
	finish(actor, &runner);
	task
}
fn retained_ids(actor: &Actor, owner: &OwnerLease) -> Vec<String> {
	actor.snapshot(owner).unwrap().tasks.into_iter().map(|task| task.reference.task_id).collect()
}
fn evicted_events(actor: &Actor) -> usize {
	let state = actor.state.lock().unwrap();
	state
		.journal
		.iter()
		.filter(|(_, _, event)| matches!(event.payload, TaskEvent::TaskEvicted { .. }))
		.count()
}
fn failure() -> Vec<ResourceFailure> {
	vec![ResourceFailure {
		resource: "process-group:1".into(),
		code: "CleanupUnconfirmed".into(),
		message: "not confirmed".into(),
	}]
}

#[test]
fn finished_tasks_beyond_the_retention_are_evicted_oldest_first_4385() {
	let (a, o) = owner();
	let tasks: Vec<_> = (0..FINISHED_TASK_RETENTION * 4)
		.map(|index| finished(&a, &o, &format!("op-{index}")))
		.collect();
	let ids = retained_ids(&a, &o);
	assert_eq!(ids.len(), FINISHED_TASK_RETENTION);
	let newest: Vec<_> = tasks[FINISHED_TASK_RETENTION * 3..]
		.iter()
		.map(|task| a.task_ref(task).unwrap().task_id)
		.collect();
	assert_eq!(ids, newest);
	assert_eq!(a.state.lock().unwrap().owners[0].tasks.iter().count(), FINISHED_TASK_RETENTION);
	assert_eq!(a.task_ref(&tasks[0]).unwrap_err().code, "TaskEvicted");
	assert_eq!(a.task_ref(&tasks[FINISHED_TASK_RETENTION * 3 - 1]).unwrap_err().code, "TaskEvicted");
	assert!(evicted_events(&a) > 0);
}

#[test]
fn eviction_follows_finish_order_not_admission_order_4385() {
	let (a, o) = owner();
	let (early, early_runner) = running(&a, &o, "early");
	let later: Vec<_> =
		(0..FINISHED_TASK_RETENTION).map(|index| finished(&a, &o, &format!("op-{index}"))).collect();
	finish(&a, &early_runner);
	assert!(a.task_ref(&early).is_ok(), "the task that finished last is the newest finished task");
	assert_eq!(a.task_ref(&later[0]).unwrap_err().code, "TaskEvicted");
	assert!(a.task_ref(&later[1]).is_ok());
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION);
}

#[test]
fn unfinished_tasks_are_never_evicted_4385() {
	let (a, o) = owner();
	let queued = a.start(&o, intent(), "queued".into()).unwrap();
	let (live, _live_runner) = running(&a, &o, "running");
	let (stopping, _stopping_runner) = running(&a, &o, "stopping");
	a.cancel(&stopping, CancelCause::User).unwrap();
	let (quarantined, quarantined_runner) = running(&a, &o, "quarantined");
	a.outcome(&quarantined_runner, done()).unwrap();
	a.acknowledge_cleanup(&quarantined_runner, Cleanup::Quarantined { resources: failure() })
		.unwrap();
	let (failed, failed_runner) = running(&a, &o, "failed");
	a.outcome(&failed_runner, done()).unwrap();
	a.acknowledge_cleanup(&failed_runner, Cleanup::Failed { resources: failure() }).unwrap();
	let (settled, settled_runner) = running(&a, &o, "settled");
	a.outcome(&settled_runner, done()).unwrap();
	for index in 0..FINISHED_TASK_RETENTION * 2 {
		finished(&a, &o, &format!("op-{index}"));
	}
	for task in [&queued, &live, &stopping, &quarantined, &failed, &settled] {
		assert!(a.task_ref(task).is_ok(), "an unfinished task was evicted");
	}
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION + 6);
	a.acknowledge_cleanup(&failed_runner, Cleanup::Reaped {}).unwrap();
	finished(&a, &o, "after");
	assert!(a.task_ref(&failed).is_ok(), "a reaped task is retained as the newest finished task");
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION + 5);
}

#[test]
fn evicted_leases_and_ids_refuse_with_task_evicted_4385() {
	let (a, o) = owner();
	let (first, first_runner) = running(&a, &o, "first");
	finish(&a, &first_runner);
	let first_id = a.task_ref(&first).unwrap().task_id;
	for index in 0..FINISHED_TASK_RETENTION {
		finished(&a, &o, &format!("op-{index}"));
	}
	let h = a.bind(OwnerScope::Session { session_id: "retention".into() });
	for code in [
		a.task_ref(&first).unwrap_err().code,
		a.task_settlement(&first).unwrap_err().code,
		a.cancel(&first, CancelCause::User).unwrap_err().code,
		a.wait(&first, None, false).unwrap_err().code,
		a.wait(&first, Some(&h), true).unwrap_err().code,
		a.output_page(&first, OutputRange { start: "0".into(), maximum_bytes: 1 })
			.err()
			.unwrap()
			.code,
		a.stdin_lease(&first).err().unwrap().code,
		a.state.lock().unwrap().lookup(0, &first_id.as_str().into()).unwrap_err().code,
	] {
		assert_eq!(code, "TaskEvicted");
	}
	assert_eq!(a.claim(&first).unwrap_err().code, "RunnerUnavailable");
	assert_eq!(a.outcome(&first_runner, done()).unwrap_err().code, "StaleAttempt");
	let state = a.state.lock().unwrap();
	let next = state.owners[0].tasks.next_ordinal();
	let environment = a.id;
	for unknown in [
		format!("task-{environment}-0-{next}"),
		format!("task-{environment}-0-00"),
		format!("task-{environment}-0-+0"),
		format!("task-{environment}-1-0"),
		format!("task-{}-0-0", environment + 1),
		"task-0".into(),
	] {
		assert_eq!(
			state.lookup(0, &unknown.as_str().into()).unwrap_err().code,
			"UnknownTask",
			"{unknown}"
		);
	}
	let retained = format!("task-{environment}-0-{}", next - 1);
	assert!(state.lookup(0, &retained.as_str().into()).is_ok());
	drop(state);
	let never_admitted = TaskLease { cap: Cap { task: Some(next), ..first.cap.clone() } };
	let other_generation =
		TaskLease { cap: Cap { generation: first.cap.generation + 1, ..first.cap.clone() } };
	assert_eq!(a.task_ref(&never_admitted).unwrap_err().code, "UnknownTask");
	assert_eq!(a.task_ref(&other_generation).unwrap_err().code, "UnknownTask");
}

#[test]
fn a_task_is_evicted_once_its_watchers_acknowledged_exactly_its_finish_4385() {
	let (a, o) = owner();
	let (lease, _) = a.watch(&o, None).unwrap();
	let first = finished(&a, &o, "first");
	a.drain(&lease).unwrap();
	for index in 0..FINISHED_TASK_RETENTION {
		finished(&a, &o, &format!("op-{index}"));
	}
	assert!(
		a.task_ref(&first).is_ok(),
		"the drain that delivered its finish is not yet acknowledged"
	);
	a.drain(&lease).unwrap();
	assert_eq!(a.task_ref(&first).unwrap_err().code, "TaskEvicted");
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION);
}

#[test]
fn a_settled_wait_stays_observable_after_its_task_is_evicted_4385() {
	let (a, o) = owner();
	let (task, runner) = running(&a, &o, "waited");
	let wait = a.wait(&task, None, false).unwrap();
	finish(&a, &runner);
	for index in 0..FINISHED_TASK_RETENTION {
		finished(&a, &o, &format!("op-{index}"));
	}
	assert_eq!(a.task_ref(&task).unwrap_err().code, "TaskEvicted");
	let settled = a.wait_outcome(&wait).unwrap().unwrap().unwrap();
	assert!(matches!(settled, WaitOutcome::Settled { .. }));
	assert_eq!(a.yield_wait(&wait, YieldReason::Explicit).unwrap(), settled);
	a.dispose_wait(&wait).unwrap();
	let forged = WaitLease { index: wait.index + 1, ..wait.clone() };
	assert_eq!(a.wait_outcome(&forged).unwrap_err().code, "UnknownWait");
}

#[test]
fn an_operation_replayed_after_eviction_admits_a_fresh_task_4385() {
	let (a, o) = owner();
	let first = finished(&a, &o, "replayed");
	assert_eq!(a.start(&o, intent(), "replayed".into()).unwrap().cap, first.cap);
	for index in 0..FINISHED_TASK_RETENTION {
		finished(&a, &o, &format!("op-{index}"));
	}
	let replay = a.start(&o, intent(), "replayed".into()).unwrap();
	assert_ne!(replay.cap, first.cap);
	assert!(a.task_ref(&replay).is_ok());
}

#[test]
fn watchers_keep_finished_tasks_until_they_processed_them_4385() {
	let (a, o) = owner();
	let (lease, _) = a.watch(&o, None).unwrap();
	for index in 0..FINISHED_TASK_RETENTION + 10 {
		finished(&a, &o, &format!("op-{index}"));
	}
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION + 10, "nothing drained yet");
	a.drain(&lease).unwrap();
	assert_eq!(
		retained_ids(&a, &o).len(),
		FINISHED_TASK_RETENTION + 10,
		"the first drain delivered the finishes; processing is confirmed by the next one"
	);
	a.drain(&lease).unwrap();
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION);
	let delivered = a.drain(&lease).unwrap();
	let evicted: Vec<_> = delivered
		.events
		.iter()
		.filter(|event| matches!(event.payload, TaskEvent::TaskEvicted { .. }))
		.collect();
	assert_eq!(evicted.len(), 10);
	let (second, _) = a.watch(&o, None).unwrap();
	finished(&a, &o, "while-watched");
	a.drain(&lease).unwrap();
	a.drain(&lease).unwrap();
	assert_eq!(
		retained_ids(&a, &o).len(),
		FINISHED_TASK_RETENTION + 1,
		"the slowest watcher holds eviction"
	);
	a.dispose_subscription(&second);
	assert_eq!(
		retained_ids(&a, &o).len(),
		FINISHED_TASK_RETENTION,
		"disposing the slow watcher trims"
	);
}

/// Retained tasks a drain leaves a watcher with that held `before` of them: a reset's snapshot, or its evictions.
fn retained_after(drained: SubscriptionDrain, before: usize) -> usize {
	match drained.snapshot {
		Some(snapshot) => snapshot.tasks.len(),
		None => {
			before
				- drained
					.events
					.iter()
					.filter(|event| matches!(event.payload, TaskEvent::TaskEvicted { .. }))
					.count()
		},
	}
}

#[test]
fn a_closed_owner_keeps_every_settlement_until_its_host_trims_it_4385() {
	let (a, o) = owner();
	let (lease, _) = a.watch(&o, None).unwrap();
	let (lagging, _) = a.watch(&o, None).unwrap();
	let queued: Vec<_> = (0..FINISHED_TASK_RETENTION * 2)
		.map(|index| a.start(&o, intent(), format!("op-{index}").into()).unwrap())
		.collect();
	a.begin_close(&o).unwrap();
	let receipt = a.close_receipt(&o).unwrap().expect("unclaimed tasks reap at once");
	assert_eq!(receipt.tasks.len(), queued.len(), "the close keeps every settlement it made");
	let delivered = a.drain(&lease).unwrap();
	assert!(delivered.reset, "the large close recovers through a final snapshot");
	let snapshot = delivered.snapshot.unwrap();
	assert_eq!(snapshot.state, "closed");
	assert_eq!(snapshot.tasks.len(), queued.len(), "the watcher sees every settled task");
	assert_eq!(retained_after(a.drain(&lease).unwrap(), queued.len()), queued.len());
	assert_eq!(
		retained_ids(&a, &o).len(),
		queued.len(),
		"the lagging watcher has not drained the close"
	);
	a.trim_closed(&o).unwrap();
	assert_eq!(
		retained_ids(&a, &o).len(),
		FINISHED_TASK_RETENTION,
		"the host's trim waits for no watcher"
	);
	assert_eq!(
		retained_after(a.drain(&lease).unwrap(), queued.len()),
		FINISHED_TASK_RETENTION,
		"the watcher receives the trim before it stops"
	);
	assert!(
		queued[..FINISHED_TASK_RETENTION].iter().all(|task| a.task_ref(task).is_err()),
		"the oldest finished tasks were evicted"
	);
	a.dispose_subscription(&lease);
	a.dispose_subscription(&lagging);
	assert_eq!(a.close_receipt(&o).unwrap().unwrap().tasks.len(), FINISHED_TASK_RETENTION);
}

#[test]
fn a_closed_owner_trims_once_its_watchers_are_gone_4385() {
	let (a, o) = owner();
	let (lease, _) = a.watch(&o, None).unwrap();
	for index in 0..FINISHED_TASK_RETENTION * 2 {
		a.start(&o, intent(), format!("op-{index}").into()).unwrap();
	}
	a.begin_close(&o).unwrap();
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION * 2);
	a.dispose_subscription(&lease);
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION);
}

#[test]
fn trimming_an_owner_that_is_not_closed_keeps_its_records_4385() {
	let (a, o) = owner();
	let (lease, _) = a.watch(&o, None).unwrap();
	for index in 0..FINISHED_TASK_RETENTION + 4 {
		finished(&a, &o, &format!("op-{index}"));
	}
	a.trim_closed(&o).unwrap();
	assert_eq!(
		retained_ids(&a, &o).len(),
		FINISHED_TASK_RETENTION + 4,
		"an open owner waits for its watcher"
	);
	a.dispose_subscription(&lease);
}

#[test]
fn canonical_ordinals_parse_only_their_own_prefix() {
	let ordinal = |text: &str| JsString::from(text).canonical_ordinal("task-1-0-");
	assert_eq!(ordinal("task-1-0-0"), Some(0));
	assert_eq!(ordinal("task-1-0-42"), Some(42));
	for rejected in
		["task-1-0-", "task-1-0-042", "task-1-0-+4", "task-1-0--4", "task-1-0-4 ", "task-1-1-4", "4"]
	{
		assert_eq!(ordinal(rejected), None, "{rejected}");
	}
}

#[test]
fn a_held_finished_task_outlives_the_retention_until_released_4385() {
	let (a, o) = owner();
	let held = finished(&a, &o, "held");
	a.retain_record(&held).unwrap();
	let later: Vec<_> =
		(0..FINISHED_TASK_RETENTION).map(|index| finished(&a, &o, &format!("op-{index}"))).collect();
	assert!(a.task_ref(&held).is_ok(), "a held task is skipped, not evicted");
	assert_eq!(
		a.task_ref(&later[0]).unwrap_err().code,
		"TaskEvicted",
		"the oldest unheld task goes instead"
	);
	a.release_record(&held).unwrap();
	assert!(a.task_ref(&held).is_ok(), "releasing within the retention evicts nothing");
	finished(&a, &o, "after-release");
	assert_eq!(a.task_ref(&held).unwrap_err().code, "TaskEvicted");
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION);
}

#[test]
fn held_tasks_beyond_the_retention_are_evicted_as_they_are_released_4385() {
	let (a, o) = owner();
	let tasks: Vec<_> = (0..FINISHED_TASK_RETENTION + 5)
		.map(|index| {
			let (task, runner) = running(&a, &o, &format!("op-{index}"));
			a.retain_record(&task).unwrap();
			finish(&a, &runner);
			task
		})
		.collect();
	assert_eq!(
		retained_ids(&a, &o).len(),
		FINISHED_TASK_RETENTION + 5,
		"held tasks are never evicted"
	);
	for task in &tasks {
		a.release_record(task).unwrap();
	}
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION);
	for task in &tasks[..5] {
		assert_eq!(a.task_ref(task).unwrap_err().code, "TaskEvicted", "the oldest go first");
	}
	assert!(a.task_ref(&tasks[5]).is_ok());
}

#[test]
fn a_closing_owner_no_longer_honors_holds_4385() {
	let (a, o) = owner();
	for index in 0..FINISHED_TASK_RETENTION + 5 {
		let (task, runner) = running(&a, &o, &format!("op-{index}"));
		a.retain_record(&task).unwrap();
		finish(&a, &runner);
	}
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION + 5);
	a.begin_close(&o).unwrap();
	assert_eq!(retained_ids(&a, &o).len(), FINISHED_TASK_RETENTION);
}

#[test]
fn holds_refuse_unknown_tasks_and_ignore_evicted_ones_4385() {
	let (a, o) = owner();
	let first = finished(&a, &o, "first");
	for index in 0..FINISHED_TASK_RETENTION {
		finished(&a, &o, &format!("op-{index}"));
	}
	assert_eq!(a.retain_record(&first).unwrap_err().code, "TaskEvicted");
	assert_eq!(a.release_record(&first), Ok(()));
	let next = a.state.lock().unwrap().owners[0].tasks.next_ordinal();
	let never_admitted = TaskLease { cap: Cap { task: Some(next), ..first.cap.clone() } };
	assert_eq!(a.retain_record(&never_admitted).unwrap_err().code, "UnknownTask");
	assert_eq!(a.release_record(&never_admitted).unwrap_err().code, "UnknownTask");
	let foreign =
		TaskLease { cap: Cap { environment: first.cap.environment + 1, ..first.cap.clone() } };
	assert_eq!(a.release_record(&foreign).unwrap_err().code, "UnknownTask");
}
