use super::*;

#[napi(string_enum = "kebab-case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentTaskKind {
	Agent,
}

/// Caller-provided strings retain their exact JavaScript UTF-16 code units.
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentIntent {
	pub kind: AgentTaskKind,
	#[napi(ts_type = "string")]
	pub agent: JsString,
	#[napi(ts_type = "string")]
	pub task: JsString,
	#[napi(ts_type = "string")]
	pub description: Option<JsString>,
	#[napi(ts_type = "string")]
	pub cwd: Option<JsString>,
	#[napi(ts_type = "string")]
	pub parent_task_id: Option<JsString>,
}
#[napi(string_enum = "kebab-case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelCause {
	User,
	OwnerClose,
	ExecutionTimeout,
	OutputLimit,
	ParentHandoff,
	/// A resumable stop: the agent is paused, awaiting resume.
	Pause,
	/// A resumable quit: the agent is paused, awaiting resume.
	Quit,
	Shutdown,
}
#[napi(string_enum = "kebab-case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum YieldReason {
	Explicit,
	DefaultBackground,
	Elapsed,
	IntercomCoordination,
	InputNeeded,
}
impl YieldReason {
	pub(super) fn text(self) -> String {
		match self {
			Self::Explicit => "explicit",
			Self::DefaultBackground => "default-background",
			Self::Elapsed => "elapsed",
			Self::IntercomCoordination => "intercom-coordination",
			Self::InputNeeded => "input-needed",
		}
		.into()
	}
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeTaskRef {
	pub owner_id: String,
	pub task_id: String,
	pub attempt_id: String,
	pub generation: String,
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OmittedRange {
	#[napi(ts_type = "string")]
	pub start: JsString,
	#[napi(ts_type = "string")]
	pub end: JsString,
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputRef {
	#[napi(ts_type = "string")]
	pub owner_id: JsString,
	#[napi(ts_type = "string")]
	pub task_id: JsString,
	#[napi(ts_type = "string")]
	pub artifact_id: JsString,
	#[napi(ts_type = "string")]
	pub byte_count: JsString,
	pub omitted_ranges: Vec<OmittedRange>,
}
// Report numbers retain their representation: omitted differs from zero, -0 from +0,
// and an identical NaN payload replays. Share this across terminal and activity DTOs.
fn same_number(left: Option<f64>, right: Option<f64>) -> bool {
	left.map(f64::to_bits) == right.map(f64::to_bits)
}
/// Terminal numeric exit codes retain JavaScript number values without i32 narrowing.
#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
#[derive(Clone, Debug)]
pub enum TaskResult {
	Completed {
		output: OutputRef,
		exit_code: Option<f64>,
	},
	Failed {
		#[napi(ts_type = "string")]
		code: JsString,
		#[napi(ts_type = "string")]
		message: JsString,
		output: Option<OutputRef>,
		exit_code: Option<f64>,
	},
	Cancelled {
		cause: CancelCause,
		output: Option<OutputRef>,
	},
}
// Exact replay compares the retained numeric representation: -0 is not 0 and NaN replays.
impl PartialEq for TaskResult {
	fn eq(&self, other: &Self) -> bool {
		match (self, other) {
			(
				Self::Completed { output, exit_code },
				Self::Completed { output: other_output, exit_code: other_exit_code },
			) => output == other_output && same_number(*exit_code, *other_exit_code),
			(
				Self::Failed { code, message, output, exit_code },
				Self::Failed {
					code: other_code,
					message: other_message,
					output: other_output,
					exit_code: other_exit_code,
				},
			) => {
				code == other_code
					&& message == other_message
					&& output == other_output
					&& same_number(*exit_code, *other_exit_code)
			},
			(
				Self::Cancelled { cause, output },
				Self::Cancelled { cause: other_cause, output: other_output },
			) => cause == other_cause && output == other_output,
			_ => false,
		}
	}
}
impl Eq for TaskResult {}
impl TaskResult {
	fn output(&self) -> Option<OutputRef> {
		match self {
			Self::Completed { output, .. } => Some(output.clone()),
			Self::Failed { output, .. } | Self::Cancelled { output, .. } => output.clone(),
		}
	}
}
#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Execution {
	Queued {},
	Running {},
	Cancelling { cause: CancelCause },
	Settled { result: TaskResult },
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceFailure {
	#[napi(ts_type = "string")]
	pub resource: JsString,
	#[napi(ts_type = "string")]
	pub code: JsString,
	#[napi(ts_type = "string")]
	pub message: JsString,
}
#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cleanup {
	Active {},
	Draining {},
	Reaped {},
	Failed { resources: Vec<ResourceFailure> },
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PromptRoute {
	#[napi(ts_type = "string")]
	pub session_id: JsString,
	#[napi(ts_type = "string")]
	pub prompt_id: JsString,
	#[napi(ts_type = "string")]
	pub stage_attempt_id: Option<JsString>,
}
#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Attention {
	None {},
	InputNeeded {
		#[napi(ts_type = "string")]
		request_id: JsString,
		#[napi(ts_type = "string")]
		prompt: JsString,
		route: PromptRoute,
	},
	NoRecentActivity {
		#[napi(ts_type = "string")]
		last_activity_at: Option<JsString>,
	},
}
#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostObservation {
	Foreground { wait_id: String },
	Background { reason: String },
	None { reason: String },
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurrentAction {
	#[napi(ts_type = "string")]
	pub tool: JsString,
	#[napi(ts_type = "string")]
	pub text: JsString,
}
/// Optional metrics preserve exact JavaScript numbers, including NaN and signed zero.
#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct TaskMetrics {
	pub elapsed_ms: Option<f64>,
	pub tool_count: Option<f64>,
	pub token_count: Option<f64>,
}
impl PartialEq for TaskMetrics {
	fn eq(&self, other: &Self) -> bool {
		same_number(self.elapsed_ms, other.elapsed_ms)
			&& same_number(self.tool_count, other.tool_count)
			&& same_number(self.token_count, other.token_count)
	}
}
impl Eq for TaskMetrics {}
#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct TaskRecord {
	#[napi(js_name = "ref")]
	pub reference: NativeTaskRef,
	#[napi(ts_type = "string")]
	pub launch_operation_id: JsString,
	#[napi(ts_type = "string")]
	pub parent_task_id: Option<JsString>,
	pub launch_group_id: Option<String>,
	pub launch_ordinal: u32,
	pub kind: String,
	#[napi(ts_type = "string")]
	pub title: JsString,
	#[napi(ts_type = "string")]
	pub agent_name: Option<JsString>,
	#[napi(ts_type = "string")]
	pub model: Option<JsString>,
	#[napi(ts_type = "string")]
	pub thinking: Option<JsString>,
	pub execution: Execution,
	pub observation: HostObservation,
	/// True after a designated observation yields; retained after settlement and snapshot resets.
	pub was_background: Option<bool>,
	pub attention: Attention,
	pub cleanup: Cleanup,
	pub current_action: Option<CurrentAction>,
	pub metrics: Option<TaskMetrics>,
	pub output: OutputRef,
}
#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
#[derive(Clone, Debug)]
pub enum ActivityChange {
	Action {
		#[napi(ts_type = "string")]
		tool: JsString,
		#[napi(ts_type = "string")]
		text: JsString,
	},
	Model {
		#[napi(ts_type = "string")]
		model: Option<JsString>,
		#[napi(ts_type = "string")]
		thinking: Option<JsString>,
	},
	Metrics {
		elapsed_ms: Option<f64>,
		tool_count: Option<f64>,
		token_count: Option<f64>,
	},
	Output {
		#[napi(ts_type = "string")]
		offset: JsString,
		#[napi(ts_type = "string")]
		bytes_base64: JsString,
	},
	AttentionSet {
		attention: Attention,
	},
	AttentionClear {
		#[napi(ts_type = "string")]
		request_id: JsString,
	},
}
impl PartialEq for ActivityChange {
	fn eq(&self, other: &Self) -> bool {
		match (self, other) {
			(Self::Action { tool, text }, Self::Action { tool: other_tool, text: other_text }) => {
				tool == other_tool && text == other_text
			},
			(
				Self::Model { model, thinking },
				Self::Model { model: other_model, thinking: other_thinking },
			) => model == other_model && thinking == other_thinking,
			(
				Self::Metrics { elapsed_ms, tool_count, token_count },
				Self::Metrics {
					elapsed_ms: other_elapsed,
					tool_count: other_tool,
					token_count: other_token,
				},
			) => {
				same_number(*elapsed_ms, *other_elapsed)
					&& same_number(*tool_count, *other_tool)
					&& same_number(*token_count, *other_token)
			},
			(
				Self::Output { offset, bytes_base64 },
				Self::Output { offset: other_offset, bytes_base64: other_bytes },
			) => offset == other_offset && bytes_base64 == other_bytes,
			(Self::AttentionSet { attention }, Self::AttentionSet { attention: other }) => {
				attention == other
			},
			(Self::AttentionClear { request_id }, Self::AttentionClear { request_id: other }) => {
				request_id == other
			},
			_ => false,
		}
	}
}
impl Eq for ActivityChange {}
#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct ActivityReport {
	#[napi(ts_type = "string")]
	pub report_id: JsString,
	pub change: ActivityChange,
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutcomeReport {
	#[napi(ts_type = "string")]
	pub report_id: JsString,
	pub result: TaskResult,
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportReceipt {
	#[napi(ts_type = "string")]
	pub report_id: JsString,
	pub cursor: Cursor,
	pub disposition: String,
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementReceipt {
	pub task_id: String,
	pub cursor: Cursor,
	pub result: TaskResult,
	pub completion_id: String,
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CancelReceipt {
	pub task_id: String,
	pub decision: String,
	pub execution: Execution,
	pub cleanup: Cleanup,
}

pub(super) struct Task {
	pub cap: Cap,
	pub intent: AgentIntent,
	pub record: TaskRecord,
	pub claimed: bool,
	pub activities: VecDeque<([u8; 32], ReportReceipt)>,
	pub terminal: Option<(OutcomeReport, SettlementReceipt)>,
	// Every terminal path retains its authentic journal receipt, including cancellation.
	pub settlement: Option<SettlementReceipt>,
	pub cancel_cause: Option<CancelCause>,
	// Rejected late outcomes supply output evidence, never terminal authority.
	pub cancellation_output: Option<OutputRef>,
	pub command: Option<Arc<process::CommandTask>>,
}
impl Task {
	pub fn receipt(&self) -> CancelReceipt {
		CancelReceipt {
			task_id: self.record.reference.task_id.clone(),
			decision: if self.cancel_cause.is_some() {
				"cancellation-requested"
			} else {
				"already-settled"
			}
			.into(),
			execution: self.record.execution.clone(),
			cleanup: self.record.cleanup.clone(),
		}
	}
	pub fn cleanup_failure(&self) -> Option<TaskFailure> {
		match &self.record.cleanup {
			Cleanup::Failed { resources } => Some(TaskFailure {
				code: "CleanupFailed".into(),
				message: format!("{}: {resources:?}", self.record.reference.task_id),
			}),
			_ => None,
		}
	}
}
impl Actor {
	pub(super) fn start(
		&self,
		owner: &OwnerLease,
		intent: AgentIntent,
		operation: JsString,
	) -> Door<TaskLease> {
		let mut s = self.state.lock().unwrap();
		let oi = s.owner(self.id, &owner.cap, "OwnerClosing")?;
		if s.closing || s.owners[oi].state != "open" {
			return Err(fail("OwnerClosing"));
		}
		if let Some(t) = s.owners[oi].tasks.iter().find(|t| t.record.launch_operation_id == operation)
		{
			if t.command.is_some() {
				return Err(fail("OperationConflict"));
			}
			return if t.intent == intent {
				Ok(TaskLease { cap: t.cap.clone() })
			} else {
				Err(fail("OperationConflict"))
			};
		}
		if let Some(parent) = &intent.parent_task_id
			&& !s.owners[oi].tasks.iter().any(|t| {
				parent.equals_str(&t.record.reference.task_id)
					&& matches!(t.record.execution, Execution::Running {} | Execution::Queued {})
			}) {
			return Err(fail("OwnerClosing"));
		}
		let ordinal = s.owners[oi].tasks.len() as u32;
		let cap = Cap { task: Some(ordinal as usize), attempt: 1, ..owner.cap.clone() };
		let reference = cap.reference();
		let output = OutputRef {
			owner_id: reference.owner_id.clone().into(),
			task_id: reference.task_id.clone().into(),
			artifact_id: format!("output-{}", reference.task_id).into(),
			byte_count: "0".into(),
			omitted_ranges: vec![],
		};
		let title =
			intent.description.as_ref().filter(|d| !d.is_empty()).cloned().unwrap_or_else(|| {
				intent.task.first_nonblank_line().unwrap_or_else(|| intent.agent.clone())
			});
		let record = TaskRecord {
			reference: reference.clone(),
			launch_operation_id: operation,
			parent_task_id: intent.parent_task_id.clone(),
			launch_group_id: None,
			launch_ordinal: ordinal,
			kind: "agent".into(),
			title,
			agent_name: Some(intent.agent.clone()),
			model: None,
			thinking: None,
			execution: Execution::Queued {},
			observation: HostObservation::Background { reason: "not-observed".into() },
			was_background: None,
			attention: Attention::None {},
			cleanup: Cleanup::Active {},
			current_action: None,
			metrics: None,
			output,
		};
		s.owners[oi].tasks.push(Task {
			cap: cap.clone(),
			intent,
			record: record.clone(),
			claimed: false,
			activities: VecDeque::new(),
			terminal: None,
			settlement: None,
			cancel_cause: None,
			cancellation_output: None,
			command: None,
		});
		s.emit(oi, Some(reference.task_id), TaskEvent::TaskAdmitted { task: record });
		Ok(TaskLease { cap })
	}
	pub(super) fn claim(&self, task: &TaskLease) -> Door<RunnerLease> {
		let mut s = self.state.lock().unwrap();
		let (oi, ti) = s.task(self.id, &task.cap, "RunnerUnavailable")?;
		if s.closing || s.owners[oi].state != "open" {
			return Err(fail("OwnerClosing"));
		}
		let t = &mut s.owners[oi].tasks[ti];
		if t.claimed || !matches!(t.record.execution, Execution::Queued {}) {
			return Err(fail("RunnerUnavailable"));
		}
		t.claimed = true;
		t.record.execution = Execution::Running {};
		let reference = t.record.reference.clone();
		s.emit(oi, Some(reference.task_id.clone()), TaskEvent::TaskStarted { reference });
		Ok(RunnerLease { cap: task.cap.clone() })
	}
	pub(super) fn task_ref(&self, task: &TaskLease) -> Door<NativeTaskRef> {
		let s = self.state.lock().unwrap();
		let (oi, ti) = s.task(self.id, &task.cap, "UnknownTask")?;
		Ok(s.owners[oi].tasks[ti].record.reference.clone())
	}
	pub(super) fn task_settlement(&self, task: &TaskLease) -> Door<SettlementReceipt> {
		let s = self.state.lock().unwrap();
		let (oi, ti) = s.task(self.id, &task.cap, "UnknownTask")?;
		s.owners[oi].tasks[ti].settlement.clone().ok_or_else(|| fail("TaskNotSettled"))
	}
	pub(super) fn activity(
		&self,
		runner: &RunnerLease,
		report: ActivityReport,
	) -> Door<ReportReceipt> {
		let mut s = self.state.lock().unwrap();
		let (oi, ti) = s.runner(self.id, &runner.cap)?;
		let t = &s.owners[oi].tasks[ti];
		let digest = activity_hash(&report);
		if let Some((old, receipt)) =
			t.activities.iter().find(|(_, receipt)| receipt.report_id == report.report_id)
		{
			return if old == &digest {
				Ok(ReportReceipt { disposition: "duplicate".into(), ..receipt.clone() })
			} else {
				Err(fail("ReportConflict"))
			};
		}
		if t.terminal.as_ref().is_some_and(|(old, _)| old.report_id == report.report_id) {
			return Err(fail("ReportConflict"));
		}
		if matches!(t.record.execution, Execution::Settled { .. }) {
			return Err(fail("TaskTerminal"));
		}
		if s.closing || s.owners[oi].state != "open" || t.cancel_cause.is_some() {
			return Err(fail("OwnerClosing"));
		}
		let t = &mut s.owners[oi].tasks[ti];
		match &report.change {
			ActivityChange::Action { tool, text } => {
				t.record.current_action =
					Some(CurrentAction { tool: tool.clone(), text: text.clone() });
				if matches!(t.record.attention, Attention::NoRecentActivity { .. }) {
					t.record.attention = Attention::None {};
				}
			},
			ActivityChange::Model { model, thinking } => {
				t.record.model = model.clone();
				t.record.thinking = thinking.clone();
			},
			ActivityChange::Metrics { elapsed_ms, tool_count, token_count } => {
				let m = t.record.metrics.get_or_insert_default();
				if elapsed_ms.is_some() {
					m.elapsed_ms = *elapsed_ms;
				}
				if tool_count.is_some() {
					m.tool_count = *tool_count;
				}
				if token_count.is_some() {
					m.token_count = *token_count;
				}
			},
			ActivityChange::AttentionSet { attention } => t.record.attention = attention.clone(),
			ActivityChange::AttentionClear { request_id } => {
				if matches!(&t.record.attention,Attention::InputNeeded {request_id:active,..} if active==request_id)
				{
					t.record.attention = Attention::None {};
				}
			},
			ActivityChange::Output { .. } => {},
		}
		let reference = t.record.reference.clone();
		let cursor = s.emit(
			oi,
			Some(reference.task_id.clone()),
			TaskEvent::TaskActivity { reference, activity: report.clone() },
		);
		let receipt = ReportReceipt {
			report_id: report.report_id.clone(),
			cursor,
			disposition: "accepted".into(),
		};
		let activities = &mut s.owners[oi].tasks[ti].activities;
		if activities.len() == TASK_REPORT_IDENTITY_WINDOW {
			activities.pop_front();
		}
		activities.push_back((digest, receipt.clone()));
		Ok(receipt)
	}
	pub(super) fn outcome(
		&self,
		runner: &RunnerLease,
		report: OutcomeReport,
	) -> Door<SettlementReceipt> {
		self.outcome_with_id(runner, Some(report.report_id), report.result)
	}
	pub(super) fn runner_outcome(
		&self,
		runner: &RunnerLease,
		result: TaskResult,
	) -> Door<SettlementReceipt> {
		self.outcome_with_id(runner, None, result)
	}
	fn outcome_with_id(
		&self,
		runner: &RunnerLease,
		report_id: Option<JsString>,
		result: TaskResult,
	) -> Door<SettlementReceipt> {
		let mut s = self.state.lock().unwrap();
		let (oi, ti) = s.runner(self.id, &runner.cap)?;
		let t = &s.owners[oi].tasks[ti];
		let report_id = report_id.unwrap_or_else(|| {
			if let Some((old, _)) = &t.terminal {
				// Reuse the immutable identity: a different result must still conflict.
				return old.report_id.clone();
			}
			// Under this lock, n retained activity IDs cannot occupy n+1 distinct candidates.
			// Selection emits no facts, reserves no caller IDs and keeps no extra history.
			(0..=t.activities.len())
				.map(|index| {
					JsString::from(if index == 0 {
						"runner-outcome".to_owned()
					} else {
						format!("runner-outcome-{index}")
					})
				})
				.find(|id| t.activities.iter().all(|(_, receipt)| &receipt.report_id != id))
				.expect("one more candidate than retained activity identities")
		});
		let report = OutcomeReport { report_id, result };
		if let Some((old, receipt)) = &t.terminal {
			return if old == &report { Ok(receipt.clone()) } else { Err(fail("ReportConflict")) };
		}
		if t.activities.iter().any(|(_, receipt)| receipt.report_id == report.report_id) {
			return Err(fail("ReportConflict"));
		}
		if matches!(t.record.execution, Execution::Settled { .. }) {
			return Err(fail("ReportConflict"));
		}
		if t.cancel_cause.is_some() {
			if let Some(output) = report.result.output() {
				s.owners[oi].tasks[ti].cancellation_output = Some(output);
			}
			return Err(fail("ReportConflict"));
		}
		let receipt = s.settle(oi, ti, report.result.clone());
		s.owners[oi].tasks[ti].terminal = Some((report, receipt.clone()));
		drop(s);
		self.changed.notify_waiters();
		Ok(receipt)
	}
	// Trusted fake-runner support only: reaped acknowledges its entire lifetime ended.
	pub(super) fn acknowledge_cleanup(
		&self,
		runner: &RunnerLease,
		cleanup: Cleanup,
	) -> Door<Cleanup> {
		let mut s = self.state.lock().unwrap();
		let (oi, ti) = s.runner(self.id, &runner.cap)?;
		let t = &s.owners[oi].tasks[ti];
		if t.record.cleanup == cleanup {
			return Ok(cleanup);
		}
		if matches!(t.record.cleanup, Cleanup::Reaped {})
			|| matches!(cleanup, Cleanup::Active {})
			|| (matches!(t.record.cleanup, Cleanup::Failed { .. })
				&& matches!(cleanup, Cleanup::Draining {}))
			|| (matches!(cleanup, Cleanup::Reaped {})
				&& !matches!(
					t.record.execution,
					Execution::Settled { .. } | Execution::Cancelling { .. }
				)) {
			return Err(fail("ReportConflict"));
		}
		if matches!(cleanup, Cleanup::Reaped {})
			&& let Execution::Cancelling { cause } = t.record.execution
		{
			let output = s.owners[oi].tasks[ti].cancellation_output.take();
			let result =
				if cause == CancelCause::OutputLimit && s.owners[oi].tasks[ti].command.is_some() {
					TaskResult::Failed {
						code: "OutputLimitExceeded".into(),
						message: "Background command killed: output limit exceeded (5 GiB)".into(),
						output,
						exit_code: None,
					}
				} else {
					TaskResult::Cancelled { cause, output }
				};
			s.settle(oi, ti, result);
		}
		s.set_cleanup(oi, ti, cleanup.clone());
		drop(s);
		self.changed.notify_waiters();
		Ok(cleanup)
	}
	pub(super) fn cancel(&self, task: &TaskLease, cause: CancelCause) -> Door<CancelReceipt> {
		let mut s = self.state.lock().unwrap();
		let (oi, ti) = s.task(self.id, &task.cap, "UnknownTask")?;
		s.cancel(oi, ti, cause);
		let result = s.owners[oi].tasks[ti]
			.cleanup_failure()
			.map_or_else(|| Ok(s.owners[oi].tasks[ti].receipt()), Err);
		drop(s);
		self.changed.notify_waiters();
		result
	}
}
impl State {
	pub fn cancel(&mut self, oi: usize, ti: usize, cause: CancelCause) {
		let t = &mut self.owners[oi].tasks[ti];
		if t.cancel_cause.is_some() || matches!(t.record.execution, Execution::Settled { .. }) {
			return;
		}
		t.cancel_cause = Some(cause);
		t.record.execution = Execution::Cancelling { cause };
		let reference = t.record.reference.clone();
		let claimed = t.claimed;
		self.emit(
			oi,
			Some(reference.task_id.clone()),
			TaskEvent::TaskCancelling { reference: reference.clone(), cause },
		);
		if !matches!(self.owners[oi].tasks[ti].record.cleanup, Cleanup::Failed { .. }) {
			self.set_cleanup(oi, ti, Cleanup::Draining {});
		}
		if !claimed {
			self.settle(oi, ti, TaskResult::Cancelled { cause, output: None });
			self.set_cleanup(oi, ti, Cleanup::Reaped {});
		}
	}
	pub fn set_cleanup(&mut self, oi: usize, ti: usize, cleanup: Cleanup) {
		let t = &mut self.owners[oi].tasks[ti];
		if t.record.cleanup == cleanup {
			return;
		}
		t.record.cleanup = cleanup.clone();
		let reference = t.record.reference.clone();
		self.emit(
			oi,
			Some(reference.task_id.clone()),
			TaskEvent::CleanupChanged { reference, cleanup },
		);
		self.finish_close(oi);
	}
	pub fn settle(&mut self, oi: usize, ti: usize, result: TaskResult) -> SettlementReceipt {
		let t = &mut self.owners[oi].tasks[ti];
		t.record.execution = Execution::Settled { result: result.clone() };
		if let Some(output) = result.output() {
			t.record.output = output;
		}
		t.record.attention = Attention::None {};
		let reference = t.record.reference.clone();
		let cap = t.cap.clone();
		let observation = HostObservation::None { reason: "task-settled".into() };
		t.record.observation = observation.clone();
		self.emit(
			oi,
			Some(reference.task_id.clone()),
			TaskEvent::HostObservationChanged { reference: reference.clone(), observation },
		);
		let completion_id = format!("completion-{}", reference.task_id);
		let cursor = self.emit(
			oi,
			Some(reference.task_id.clone()),
			TaskEvent::TaskSettled {
				reference: reference.clone(),
				result: result.clone(),
				completion_id: completion_id.clone(),
			},
		);
		for record in self.waits.values().filter_map(std::sync::Weak::upgrade) {
			let mut wait = record.lock().unwrap();
			if wait.cap == cap {
				wait.finish(Ok(WaitOutcome::Settled {
					task_id: reference.task_id.clone(),
					result: result.clone(),
				}));
			}
		}
		self.finish_close(oi);
		let receipt = SettlementReceipt { task_id: reference.task_id, cursor, result, completion_id };
		self.owners[oi].tasks[ti].settlement = Some(receipt.clone());
		receipt
	}
}
