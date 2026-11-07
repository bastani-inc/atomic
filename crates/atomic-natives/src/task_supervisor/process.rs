//! Owned pipe/PTY commands with process-tree containment and bounded output retention (RFC #2884).
#![allow(dead_code)]
use super::*;
use std::sync::Condvar;
use std::time::Instant;
use std::{
	collections::VecDeque,
	fs::{File, OpenOptions},
	io::{self, Read, Seek, SeekFrom, Write},
	path::PathBuf,
};
mod input;
pub use input::*;
mod resource;
mod spool;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_command;
#[cfg(windows)]
mod windows_pty;
#[cfg(unix)]
use resource::ProcessResource;
type ProcessReader = Box<dyn Read + Send>;
type ProcessWriter = Box<dyn Write + Send>;
#[cfg(unix)]
type SpawnedProcess =
	(ProcessResource, Option<ProcessWriter>, ProcessReader, ProcessReader, Option<String>);

#[napi(string_enum = "kebab-case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandTaskKind {
	Command,
}

#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommandTerminal {
	Pipe {},
	Pty { columns: u16, rows: u16 },
}

/// Execute this program directly, appending command as one final argument.
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandShell {
	#[napi(ts_type = "string")]
	pub program: JsString,
	#[napi(ts_type = "string[]")]
	pub args: Vec<JsString>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct CommandIntent {
	pub kind: CommandTaskKind,
	#[napi(ts_type = "string")]
	pub command: JsString,
	#[napi(ts_type = "string")]
	pub description: Option<JsString>,
	#[napi(ts_type = "string")]
	pub cwd: Option<JsString>,
	#[napi(ts_type = "Record<string,string>")]
	pub env: Option<std::collections::HashMap<String, JsString>>,
	pub shell: Option<CommandShell>,
	/// Defaults to true; false makes env the complete child environment.
	pub inherit_env: Option<bool>,
	pub terminal: CommandTerminal,
	pub execution_timeout_ms: Option<f64>,
	#[napi(ts_type = "string")]
	pub parent_task_id: Option<JsString>,
}
impl PartialEq for CommandIntent {
	fn eq(&self, other: &Self) -> bool {
		self.kind == other.kind
			&& self.command == other.command
			&& self.description == other.description
			&& self.cwd == other.cwd
			&& self.env == other.env
			&& self.shell == other.shell
			&& self.inherit_env == other.inherit_env
			&& self.terminal == other.terminal
			&& self.parent_task_id == other.parent_task_id
			&& self.execution_timeout_ms.map(f64::to_bits)
				== other.execution_timeout_ms.map(f64::to_bits)
	}
}

const PROCESS_TERM_GRACE: Duration = Duration::from_millis(250);
const PROCESS_DRAIN_GRACE: Duration = Duration::from_secs(2);
const PROCESS_POLL: Duration = Duration::from_millis(5);
pub(super) const PROCESS_SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
/// How long quarantined cleanup still has once its owner closes or its task is stopped, before it fails as unconfirmed.
const PROCESS_QUARANTINE_GRACE: Duration = Duration::from_secs(15);
/// Quarantine without a deadline waits for a process outside the group, so it checks less often.
const PROCESS_QUARANTINE_POLL: Duration = Duration::from_millis(100);

#[napi(string_enum = "kebab-case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandOutputSink {
	FileSpool,
	Drained,
}
/// Trusted native adapter configuration, never model input or CommandIntent fields.
#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CommandResourceOptions {
	pub sink: Option<CommandOutputSink>,
	pub disk_cap_bytes: Option<f64>,
	pub live_preview_bytes: Option<u32>,
	pub foreground_spill_bytes: Option<u32>,
	pub background: Option<bool>,
	/// Internal host/test seam for distinguishing a real TERM wait from teardown latency (integer 1..=60000 ms).
	/// Ignored on Windows, whose Job containment terminates immediately rather than sending TERM.
	pub termination_grace_ms: Option<f64>,
}

pub(super) struct CommandTask {
	intent: CommandIntent,
	options: CommandResourceOptions,
	pub(super) background: AtomicBool,
	output: Mutex<OutputStore>,
	input: Mutex<InputQueue>,
	resize: Mutex<Option<(u16, u16)>>,
	setup: Mutex<Option<Door<()>>>,
	setup_changed: Condvar,
	worker: Mutex<Option<std::thread::JoinHandle<()>>>,
	finished: AtomicBool,
	#[cfg(unix)]
	retained: Mutex<Option<FailedProcess>>,
	#[cfg(unix)]
	process_group: std::sync::atomic::AtomicI32,
	#[cfg(all(test, unix))]
	kill_error: std::sync::atomic::AtomicI32,
	/// Signal the group by number, as macOS and Linux before 6.9 do, even where a pidfd could.
	#[cfg(all(test, target_os = "linux"))]
	group_by_number: bool,
	#[cfg(all(test, unix))]
	signals: Mutex<Vec<(libc::pid_t, libc::c_int)>>,
	#[cfg(all(test, unix))]
	quarantine_grace: Duration,
	/// Keep the exited leader unreaped, as a host too starved to observe its exit within the drain window would.
	#[cfg(all(test, unix))]
	reap_delayed: AtomicBool,
	/// Another group now holds this command's group number: nonzero answers group probes as alive (-1) or with that
	/// errno, and records signals without sending them.
	#[cfg(all(test, unix))]
	reused_group: std::sync::atomic::AtomicI32,
	#[cfg(all(test, unix))]
	loop_iterations: std::sync::atomic::AtomicUsize,
}
impl CommandTask {
	#[cfg(unix)]
	fn termination_grace(&self) -> Duration {
		self
			.options
			.termination_grace_ms
			.map_or(PROCESS_TERM_GRACE, |ms| Duration::from_secs_f64(ms / 1000.0))
	}
	#[cfg(unix)]
	fn quarantine_grace(&self) -> Duration {
		#[cfg(test)]
		return self.quarantine_grace;
		#[cfg(not(test))]
		PROCESS_QUARANTINE_GRACE
	}
	#[cfg(unix)]
	fn try_reap(&self, child: &mut ProcessResource) -> io::Result<Option<std::process::ExitStatus>> {
		#[cfg(test)]
		if self.reap_delayed.load(Ordering::Acquire) {
			return Ok(None);
		}
		child.try_wait()
	}
	#[cfg(unix)]
	fn probe_group(&self, group: &ProcessGroup) -> io::Result<bool> {
		#[cfg(test)]
		match self.reused_group.load(Ordering::Acquire) {
			0 => {},
			-1 => return Ok(false),
			errno => return Err(io::Error::from_raw_os_error(errno)),
		}
		group.gone()
	}
	fn file_spool(&self) -> bool {
		matches!(self.intent.terminal, CommandTerminal::Pipe {})
			&& self.options.sink != Some(CommandOutputSink::Drained)
	}
	/// Frees the in-memory copies of a done command's output once its owner has closed (#4215), so nothing of it stays
	/// in memory for as long as the process lives. What its spool holds still reads back. Output only memory held reads
	/// as omitted from then on: all of a terminal (PTY) command's that never spilled, and the end of a spool that
	/// overflowed its cap or failed to write. Nothing reads a closed owner's output. Called with the actor's state lock
	/// held, so a poisoned output lock is taken as it is: freeing buffers is safe whatever a panicking reader left.
	pub(super) fn release_output_memory(&self) {
		self.output.lock().unwrap_or_else(std::sync::PoisonError::into_inner).release_memory();
	}
	#[cfg(unix)]
	fn retain_failed(
		&self,
		reference: NativeTaskRef,
		mut child: ProcessResource,
		readers: (ProcessReader, ProcessReader),
		message: String,
	) {
		// Nonblocking reap only; a live or unqueryable child remains owned.
		let _ = child.try_wait();
		*self.retained.lock().unwrap() = Some(FailedProcess { reference, child, message, readers });
	}
	#[cfg(unix)]
	fn signal_group(&self, group: &ProcessGroup, signal: libc::c_int) -> io::Result<()> {
		#[cfg(test)]
		self.signals.lock().unwrap().push((group.pid, signal));
		#[cfg(test)]
		if self.reused_group.load(Ordering::Acquire) != 0 {
			return Ok(());
		}
		#[cfg(test)]
		if signal == libc::SIGKILL && self.kill_error.load(Ordering::Acquire) != 0 {
			return Err(io::Error::from_raw_os_error(self.kill_error.load(Ordering::Acquire)));
		}
		let Err(error) = group.send(signal) else {
			return Ok(());
		};
		// Darwin reports EPERM when a group contains only zombies. Defer that refusal
		// only once the leader has exited: while we still own its unreaped zombie, or
		// after we reaped it. Cleanup must subsequently reap it and independently
		// confirm the group is gone; this does not treat a signal refusal as evidence
		// of successful cleanup.
		#[cfg(target_os = "macos")]
		if error.raw_os_error() == Some(libc::EPERM)
			&& (group.reaped || child_exited_without_reaping(group.pid)?)
		{
			return Ok(());
		}
		if error.raw_os_error() == Some(libc::ESRCH) { Ok(()) } else { Err(error) }
	}
	pub(super) fn join_until(&self, deadline: Instant) -> bool {
		loop {
			let mut worker = self.worker.lock().unwrap();
			if worker.as_ref().is_some_and(std::thread::JoinHandle::is_finished) {
				return worker.take().unwrap().join().is_ok();
			}
			if worker.is_none() && self.finished.load(Ordering::Acquire) {
				return true;
			}
			drop(worker);
			if Instant::now() >= deadline {
				return false;
			}
			std::thread::sleep(PROCESS_POLL);
		}
	}
	fn setup_result(&self, result: Door<()>) {
		*self.setup.lock().unwrap() = Some(result);
		self.setup_changed.notify_all();
	}
	fn await_setup(&self) -> Door<()> {
		let mut setup = self.setup.lock().unwrap();
		while setup.is_none() {
			setup = self.setup_changed.wait(setup).unwrap();
		}
		setup.clone().unwrap()
	}
}

impl Actor {
	pub(super) fn start_command(
		self: &Arc<Self>,
		owner: &OwnerLease,
		intent: CommandIntent,
		operation: JsString,
	) -> Door<TaskLease> {
		self.start_command_configured(owner, intent, operation, CommandResourceOptions::default())
	}
	pub(super) fn start_command_configured(
		self: &Arc<Self>,
		owner: &OwnerLease,
		intent: CommandIntent,
		operation: JsString,
		options: CommandResourceOptions,
	) -> Door<TaskLease> {
		if options
			.termination_grace_ms
			.is_some_and(|ms| !ms.is_finite() || ms.fract() != 0.0 || !(1.0..=60_000.0).contains(&ms))
		{
			return Err(TaskFailure {
				code: "SpawnFailed".into(),
				message: "terminationGraceMs must be an integer between 1 and 60000 ms".into(),
			});
		}
		poll_failed_processes();
		spool::sweep_orphaned_spools_once();
		let mut state = self.state.lock().unwrap();
		let oi = state.owner(self.id, &owner.cap, "OwnerClosing")?;
		if state.closing || state.owners[oi].state != "open" {
			return Err(fail("OwnerClosing"));
		}
		if let Some(task) =
			state.owners[oi].tasks.iter().find(|task| task.record.launch_operation_id == operation)
		{
			let Some(command) = task
				.command
				.as_ref()
				.filter(|command| command.intent == intent && command.options == options)
			else {
				return Err(fail("OperationConflict"));
			};
			let command = command.clone();
			let lease = TaskLease { cap: task.cap.clone() };
			drop(state);
			command.await_setup()?;
			return Ok(lease);
		}
		// Unsupported platforms refuse before executing any part of the command.
		#[cfg(not(any(unix, windows)))]
		if !matches!(intent.terminal, CommandTerminal::Pipe {}) {
			return Err(fail("ContainmentUnavailable"));
		}
		if let Some(parent) = &intent.parent_task_id
			&& !state.owners[oi].tasks.iter().any(|task| {
				parent.equals_str(&task.record.reference.task_id)
					&& matches!(task.record.execution, Execution::Running {} | Execution::Queued {})
			}) {
			return Err(fail("OwnerClosing"));
		}
		let ti = state.owners[oi].tasks.next_ordinal();
		let cap = Cap { task: Some(ti), attempt: 1, ..owner.cap.clone() };
		let reference = cap.reference();
		let output = OutputRef {
			owner_id: reference.owner_id.clone().into(),
			task_id: reference.task_id.clone().into(),
			artifact_id: format!("output-{}", reference.task_id).into(),
			byte_count: "0".into(),
			omitted_ranges: vec![],
		};
		let command = Arc::new(CommandTask {
			intent: intent.clone(),
			options: options.clone(),
			background: AtomicBool::new(options.background.unwrap_or(false)),
			input: Mutex::new(InputQueue::default()),
			resize: Mutex::new(None),
			output: Mutex::new(OutputStore::new(
				std::env::temp_dir().join(format!(
					"atomic-command-{}-{}",
					std::process::id(),
					reference.task_id
				)),
				options.live_preview_bytes.map_or(COMMAND_LIVE_BYTES, |value| value as usize),
				options.foreground_spill_bytes.map_or(FOREGROUND_SPILL_BYTES, |value| value as usize),
				options.disk_cap_bytes.map_or(TASK_DISK_BYTES, |value| value as u64),
			)),
			setup: Mutex::new(None),
			setup_changed: Condvar::new(),
			worker: Mutex::new(None),
			finished: AtomicBool::new(false),
			#[cfg(unix)]
			retained: Mutex::new(None),
			#[cfg(unix)]
			process_group: std::sync::atomic::AtomicI32::new(0),
			#[cfg(all(test, unix))]
			kill_error: std::sync::atomic::AtomicI32::new(0),
			#[cfg(all(test, target_os = "linux"))]
			group_by_number: TEST_GROUP_BY_NUMBER.get(),
			#[cfg(all(test, unix))]
			signals: Mutex::new(Vec::new()),
			#[cfg(all(test, unix))]
			quarantine_grace: TEST_QUARANTINE_GRACE.get(),
			#[cfg(all(test, unix))]
			reap_delayed: AtomicBool::new(false),
			#[cfg(all(test, unix))]
			reused_group: std::sync::atomic::AtomicI32::new(0),
			#[cfg(all(test, unix))]
			loop_iterations: std::sync::atomic::AtomicUsize::new(0),
		});
		let record = TaskRecord {
			reference: reference.clone(),
			launch_operation_id: operation,
			parent_task_id: intent.parent_task_id.clone(),
			launch_group_id: None,
			launch_ordinal: ti as u32,
			kind: "command".into(),
			title: intent
				.description
				.as_ref()
				.filter(|text| !text.is_empty())
				.cloned()
				.unwrap_or_else(|| {
					intent.command.first_nonblank_line().unwrap_or_else(|| intent.command.clone())
				}),
			agent_name: None,
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
		state.owners[oi].tasks.push(Task {
			cap: cap.clone(),
			// The additive S1 storage slot is unused for commands; command replay compares the exact owned intent above.
			intent: AgentIntent {
				kind: AgentTaskKind::Agent,
				agent: "".into(),
				task: "".into(),
				description: None,
				cwd: None,
				parent_task_id: None,
			},
			record: record.clone(),
			claimed: true,
			activities: VecDeque::new(),
			terminal: None,
			settlement: None,
			cancel_cause: None,
			cancellation_output: None,
			held: false,
			command: Some(command.clone()),
		});
		state.emit(oi, Some(reference.task_id), TaskEvent::TaskAdmitted { task: record });
		drop(state);
		let actor = self.clone();
		let resource = command.clone();
		let runner = RunnerLease { cap: cap.clone() };
		let spawn = std::thread::Builder::new().name("task-command".into()).spawn(move || {
			actor.run_command(&runner, &resource);
			resource.output.lock().unwrap().settle();
			resource.finished.store(true, Ordering::Release);
		});
		match spawn {
			Ok(worker) => *command.worker.lock().unwrap() = Some(worker),
			Err(error) => self.command_spawn_failed(
				&RunnerLease { cap: cap.clone() },
				&command,
				error.to_string(),
			),
		}
		command.await_setup()?;
		Ok(TaskLease { cap })
	}
	fn command_spawn_failed(&self, runner: &RunnerLease, command: &CommandTask, message: String) {
		let _ = self.runner_outcome(
			runner,
			TaskResult::Failed {
				code: "SpawnFailed".into(),
				message: message.clone().into(),
				output: None,
				exit_code: None,
			},
		);
		let _ = self.acknowledge_cleanup(runner, Cleanup::Reaped {});
		command.setup_result(Err(TaskFailure { code: "SpawnFailed".into(), message }));
		command.finished.store(true, Ordering::Release);
	}
	#[cfg(windows)]
	fn run_command(&self, runner: &RunnerLease, command: &Arc<CommandTask>) {
		self.run_command_windows(runner, command);
	}
	#[cfg(not(any(unix, windows)))]
	fn run_command(&self, runner: &RunnerLease, command: &CommandTask) {
		let _ = self.runner_outcome(
			runner,
			TaskResult::Failed {
				code: "ContainmentUnavailable".into(),
				message: "Supervised backend unavailable".into(),
				output: None,
				exit_code: None,
			},
		);
		let _ = self.acknowledge_cleanup(runner, Cleanup::Reaped {});
		command.setup_result(Err(fail("ContainmentUnavailable")));
	}
	#[cfg(unix)]
	fn run_command(&self, runner: &RunnerLease, command: &CommandTask) {
		use std::os::unix::process::CommandExt;
		use std::process::{Command, Stdio};
		let spawned = (|| -> io::Result<SpawnedProcess> {
			match command.intent.terminal {
				CommandTerminal::Pty { columns, rows } => {
					let (pty, reader, writer) =
						crate::pty::supervised_pty(&command.intent, columns, rows)?;
					Ok((ProcessResource::Pty(pty), Some(writer), reader, Box::new(io::empty()), None))
				},
				CommandTerminal::Pipe {} => {
					let mut spawn = if let Some(shell) = &command.intent.shell {
						let mut spawn = Command::new(shell.program.process_text());
						spawn.args(shell.args.iter().map(JsString::process_text));
						spawn
					} else {
						let mut spawn = Command::new("/bin/sh");
						spawn.arg("-c");
						spawn
					};
					spawn
						.arg(command.intent.command.process_text())
						.process_group(0)
						.stdin(Stdio::piped())
						.stdout(Stdio::piped())
						.stderr(Stdio::piped());
					if command.file_spool() {
						let mut store = command.output.lock().unwrap();
						store.background();
						if store.unavailable {
							return Err(io::Error::other(format!(
								"Output spool unavailable: {}",
								store.spool_error.as_deref().unwrap_or("write failed")
							)));
						}
					}
					if let Some(cwd) = &command.intent.cwd {
						spawn.current_dir(cwd.process_text());
					}
					if command.intent.inherit_env == Some(false) {
						spawn.env_clear();
					}
					if let Some(env) = &command.intent.env {
						spawn.envs(env.iter().map(|(key, value)| (key, value.process_text())));
					}
					let mut child = spawn.spawn().map_err(explain_spawn_error)?;
					let stdin = child.stdin.take().unwrap();
					let stdout = child.stdout.take();
					let stderr = child.stderr.take();
					let error = make_nonblocking(&stdin)
						.and_then(|()| stdout.as_ref().map_or(Ok(()), make_nonblocking))
						.and_then(|()| stderr.as_ref().map_or(Ok(()), make_nonblocking))
						.err()
						.map(|error| error.to_string());
					Ok((
						ProcessResource::Pipe(child),
						Some(Box::new(stdin)),
						stdout.map_or_else(
							|| Box::new(io::empty()) as ProcessReader,
							|reader| Box::new(reader),
						),
						stderr.map_or_else(
							|| Box::new(io::empty()) as ProcessReader,
							|reader| Box::new(reader),
						),
						error,
					))
				},
			}
		})();
		let (mut child, mut stdin, mut stdout, mut stderr, setup_failure) = match spawned {
			Ok(resource) => resource,
			Err(error) => {
				self.command_spawn_failed(runner, command, error.to_string());
				return;
			},
		};
		let pid = child.id() as libc::pid_t;
		command.process_group.store(pid, Ordering::Release);
		// Opened while the leader is unreaped, so its PID still names this command's group.
		let mut group = ProcessGroup::new(pid);
		#[cfg(all(test, target_os = "linux"))]
		if command.group_by_number {
			group.pidfd = None;
		}
		{
			let mut state = self.state.lock().unwrap();
			let (oi, ti) = state.runner(self.id, &runner.cap).unwrap();
			if matches!(state.owners[oi].tasks[ti].record.execution, Execution::Queued {}) {
				state.owners[oi].tasks[ti].record.execution = Execution::Running {};
				let reference = runner.cap.reference();
				state.emit(oi, Some(reference.task_id.clone()), TaskEvent::TaskStarted { reference });
			}
		}
		if setup_failure.is_none() {
			command.setup_result(Ok(()));
		}
		let started = Instant::now();
		let mut stopping: Option<Instant> = None;
		let mut killed = false;
		let mut status = None;
		let mut stdout_eof = false;
		let mut stderr_eof = false;
		let mut read_failure = setup_failure.clone();
		let mut cleanup_failure = None;
		// Set once the result settled ahead of unconfirmed cleanup; output after it is drained, not kept.
		let mut quarantined = false;
		// Quarantine has no deadline until the owner closes or the task is stopped (#4338).
		let mut expires: Option<Instant> = None;
		let mut group_gone = false;
		loop {
			#[cfg(test)]
			command.loop_iterations.fetch_add(1, Ordering::AcqRel);
			if setup_failure.is_none() {
				command.input.lock().unwrap().drain(&mut stdin);
			}
			if let Some((columns, rows)) = command.resize.lock().unwrap().take()
				&& let ProcessResource::Pty(pty) = &child
			{
				let _ = pty.master.resize(portable_pty::PtySize {
					rows,
					cols: columns,
					pixel_width: 0,
					pixel_height: 0,
				});
			}
			// A failed O_NONBLOCK setup must never enter a potentially blocking read.
			if setup_failure.is_none() {
				let keep = !quarantined;
				for result in [
					read_pipe(&mut stdout, command, &mut stdout_eof, keep),
					read_pipe(&mut stderr, command, &mut stderr_eof, keep),
				] {
					if let Err(error) = result {
						read_failure = Some(error.to_string());
					}
				}
			}
			let background = command.background.load(Ordering::Acquire);
			if background {
				command.output.lock().unwrap().background();
				if command.file_spool() && command.output.lock().unwrap().overflow {
					let _ =
						self.cancel(&TaskLease { cap: runner.cap.clone() }, CancelCause::OutputLimit);
				}
			}
			let (cancelling, closing) = {
				let state = self.state.lock().unwrap();
				let owner = &state.owners[runner.cap.owner];
				(
					owner.tasks[runner.cap.task.unwrap()].cancel_cause.is_some(),
					state.closing || owner.state != "open",
				)
			};
			if stopping.is_none()
				&& !cancelling
				&& command
					.intent
					.execution_timeout_ms
					.is_some_and(|budget| started.elapsed().as_secs_f64() * 1000.0 >= budget)
			{
				let _ =
					self.cancel(&TaskLease { cap: runner.cap.clone() }, CancelCause::ExecutionTimeout);
				continue;
			}
			let exited = if status.is_some() { Ok(true) } else { child_exited_without_reaping(pid) };
			let exited = match exited {
				Ok(exited) => exited,
				Err(error) => {
					// Lost wait authority: do not send any delayed PID/group signal.
					cleanup_failure = Some(error.to_string());
					break;
				},
			};
			if stopping.is_none() && (cancelling || exited || read_failure.is_some()) {
				let _ = self.acknowledge_cleanup(runner, Cleanup::Draining {});
				let cause = self.state.lock().unwrap().owners[runner.cap.owner].tasks
					[runner.cap.task.unwrap()]
				.cancel_cause;
				let signal = if cause == Some(CancelCause::OutputLimit) {
					killed = true;
					libc::SIGKILL
				} else {
					libc::SIGTERM
				};
				if let Err(error) = command.signal_group(&group, signal) {
					cleanup_failure = Some(error.to_string());
				}
				stopping = Some(Instant::now());
			}
			if let Some(stop) = stopping {
				// A refused output-limit KILL ends cleanup at once, as a refused escalation does below.
				if killed && cleanup_failure.is_some() {
					break;
				}
				// The first signal went out above while the leader was unreaped. Reap it as soon as
				// it exits: its zombie would keep the group alive, so a group that is already empty
				// could not be told apart from one with members left until the grace ran out (#4268).
				if status.is_none() {
					match command.try_reap(&mut child) {
						Ok(value) => status = value,
						Err(error) => {
							cleanup_failure = Some(error.to_string());
							break;
						},
					}
					group.reaped = status.is_some();
				}
				// Probe the group once the leader is reaped, independently of EOF. A group found gone stays gone: no
				// process can join an empty group, so a later "alive" could only be another group given its number,
				// which an open-ended quarantine must never probe or signal (#4338).
				if status.is_some() && !group_gone {
					group_gone = match command.probe_group(&group) {
						Ok(gone) => gone,
						Err(error) => {
							// Darwin also returns EPERM for zombie-only groups after the
							// leader is reaped. Other parents may still be reaping members.
							// Retry only this read-only probe within the existing bound:
							// ESRCH is still required, and persistent refusal stays a failure.
							#[cfg(target_os = "macos")]
							if error.raw_os_error() == Some(libc::EPERM)
								&& stop.elapsed() < command.termination_grace() + PROCESS_DRAIN_GRACE
							{
								std::thread::sleep(PROCESS_POLL);
								continue;
							}
							cleanup_failure = Some(error.to_string());
							break;
						},
					};
				}
				let gone = group_gone;
				if gone && ((stdout_eof && stderr_eof) || setup_failure.is_some()) {
					// Confirmed gone: an earlier refused TERM left nothing behind to clean up.
					cleanup_failure = None;
					break;
				}
				if !killed && !gone && stop.elapsed() >= command.termination_grace() {
					// Members outlived the grace, or the leader is still running. Either the leader is
					// unreaped, or the probe just above found the group alive: see ProcessGroup for why
					// that keeps this KILL on this command's group. A successful escalation can resolve
					// an earlier TERM refusal; group disappearance must still be confirmed.
					cleanup_failure =
						command.signal_group(&group, libc::SIGKILL).err().map(|error| error.to_string());
					killed = true;
					if cleanup_failure.is_some() {
						break;
					}
				}
				if !quarantined && stop.elapsed() >= command.termination_grace() + PROCESS_DRAIN_GRACE {
					if setup_failure.is_some() || (status.is_none() && !cancelling) {
						cleanup_failure = Some(unconfirmed_cleanup(gone));
						break;
					}
					// The outcome is known, so the result settles now: only cleanup is late (#4338).
					let result = command_result(runner, command, status, read_failure.clone(), None);
					command.output.lock().unwrap().settle();
					let _ = self.runner_outcome(runner, result);
					let _ = self.acknowledge_cleanup(
						runner,
						Cleanup::Quarantined {
							resources: vec![ResourceFailure {
								resource: format!("process-group:{pid}").into(),
								code: "CleanupUnconfirmed".into(),
								message: unconfirmed_cleanup(gone).into(),
							}],
						},
					);
					quarantined = true;
				}
				if quarantined && expires.is_none() && (closing || cancelling) {
					expires = Some(Instant::now() + command.quarantine_grace());
				}
				if expires.is_some_and(|deadline| Instant::now() >= deadline) {
					cleanup_failure = Some(unconfirmed_cleanup(gone));
					break;
				}
			}
			std::thread::sleep(if quarantined && expires.is_none() {
				PROCESS_QUARANTINE_POLL
			} else {
				PROCESS_POLL
			});
		}
		command.input.lock().unwrap().close();
		if let Some(message) = cleanup_failure {
			command.retain_failed(runner.cap.reference(), child, (stdout, stderr), message.clone());
			if !quarantined {
				let _ = self.runner_outcome(
					runner,
					TaskResult::Failed {
						code: "CleanupFailed".into(),
						message: message.clone().into(),
						output: None,
						exit_code: None,
					},
				);
			}
			let _ = self.acknowledge_cleanup(
				runner,
				Cleanup::Failed {
					resources: vec![ResourceFailure {
						resource: format!("process-group:{pid}").into(),
						code: "CleanupFailed".into(),
						message: message.clone().into(),
					}],
				},
			);
			if setup_failure.is_some() {
				command.setup_result(Err(TaskFailure { code: "CleanupFailed".into(), message }));
			}
			return;
		}
		if !quarantined {
			let status = status.expect("group confirmed only after direct child reaped");
			let result =
				command_result(runner, command, Some(status), read_failure, setup_failure.as_deref());
			let _ = self.runner_outcome(runner, result);
		}
		let _ = self.acknowledge_cleanup(runner, Cleanup::Reaped {});
		if let Some(message) = setup_failure {
			command.setup_result(Err(TaskFailure { code: "SpawnFailed".into(), message }));
		}
	}
}

/// What a command whose leader exited (or that is stopping) settles with: its output, exit status and any read failure.
#[cfg(unix)]
fn command_result(
	runner: &RunnerLease,
	command: &CommandTask,
	status: Option<std::process::ExitStatus>,
	read_failure: Option<String>,
	setup_failure: Option<&str>,
) -> TaskResult {
	let store = command.output.lock().unwrap();
	let reference = runner.cap.reference();
	let output = OutputRef {
		owner_id: reference.owner_id.into(),
		task_id: reference.task_id.clone().into(),
		artifact_id: format!("output-{}", reference.task_id).into(),
		byte_count: store.byte_count.to_string().into(),
		omitted_ranges: store
			.omitted_ranges()
			.into_iter()
			.map(|range| OmittedRange { start: range.start.into(), end: range.end.into() })
			.collect(),
	};
	drop(store);
	let exit_code = status.and_then(|status| status.code()).map(f64::from);
	if let Some(message) = read_failure {
		TaskResult::Failed {
			code: if setup_failure.is_some() { "SpawnFailed" } else { "OutputUnavailable" }.into(),
			message: message.into(),
			output: Some(output),
			exit_code,
		}
	} else {
		TaskResult::Completed { output, exit_code }
	}
}

#[cfg(unix)]
fn unconfirmed_cleanup(group_gone: bool) -> String {
	if group_gone {
		"Output reader drain was not confirmed".into()
	} else {
		"Process-group exit was not confirmed".into()
	}
}

#[cfg(unix)]
struct FailedProcess {
	reference: NativeTaskRef,
	child: ProcessResource,
	readers: (ProcessReader, ProcessReader),
	message: String,
}
#[cfg(unix)]
impl FailedProcess {
	fn reaped(&mut self) -> bool {
		matches!(self.child.try_wait(), Ok(Some(_)))
			&& process_group_gone(self.child.id() as libc::pid_t).unwrap_or(false)
	}
}
// A failed resource outlives an environment, without an indefinitely blocked
// waiter thread. Later native admission/shutdown opportunistically reaps it.
#[cfg(unix)]
static FAILED_PROCESSES: Mutex<Vec<FailedProcess>> = Mutex::new(Vec::new());
#[cfg(unix)]
pub(super) fn poll_failed_processes() {
	FAILED_PROCESSES.lock().unwrap().retain_mut(|resource| !resource.reaped());
}
#[cfg(windows)]
pub(super) fn poll_failed_processes() {
	windows::poll_failed_windows();
}
#[cfg(not(any(unix, windows)))]
pub(super) fn poll_failed_processes() {}
#[cfg(unix)]
impl Drop for CommandTask {
	fn drop(&mut self) {
		if let Some(mut resource) = self.retained.get_mut().unwrap().take()
			&& !resource.reaped()
		{
			FAILED_PROCESSES.lock().unwrap().push(resource);
		}
	}
}
#[cfg(unix)]
fn process_group_gone(pid: libc::pid_t) -> io::Result<bool> {
	// Read-only after reaping: a reused group can at worst delay/fail cleanup;
	// no cancellation replay ever obtains signal authority over that identity.
	if unsafe { libc::kill(-pid, 0) } == 0 {
		return Ok(false);
	}
	let error = io::Error::last_os_error();
	if error.raw_os_error() == Some(libc::ESRCH) { Ok(true) } else { Err(error) }
}
/// One command's process group, signalled and probed by the identity of its leader.
///
/// Until the leader is reaped, its zombie holds the group ID, so `kill(-pid)` can reach no other group.
/// Settlement reaps the leader as soon as it exits, after the first group signal (TERM, or KILL for an
/// output-limit stop), so that a group with nobody left shows as gone (ESRCH) at once instead of after
/// the TERM grace (#4268). From then on only the group's members hold the ID, and POSIX forbids reusing a
/// process group ID while the group exists. A group signal after the reap (the KILL for members that
/// outlived the grace) is therefore sent only straight after a probe found the group alive. Once a probe after
/// the reap finds the group gone, it is never probed or signalled again: no process can join an empty group, so a
/// later "alive" could only be another group given the same number, and a quarantine (#4338) may keep the command's
/// loop running long after its group emptied.
///
/// That leaves one window, inside the grace: the group's last member is reaped, the kernel hands the freed ID to a
/// new process, and that process makes itself a group leader, all between two probes (one [`PROCESS_POLL`]), and its
/// group is still alive when the grace ends. It would then be probed as alive and receive the KILL. Linux and macOS
/// hand out PIDs cyclically, so this needs the allocator to come all the way round to this ID within that poll. On
/// Linux 6.9 and later the window does not exist: signals and probes go through a pidfd of the leader with
/// `PIDFD_SIGNAL_PROCESS_GROUP`, which addresses the group by the kernel's own object for it, never by its number,
/// so a reused number cannot be reached.
#[cfg(unix)]
struct ProcessGroup {
	/// The leader's PID, which is also the group's ID.
	pid: libc::pid_t,
	/// The leader has been reaped, so a refusal can no longer come from its zombie (see `signal_group`).
	reaped: bool,
	#[cfg(target_os = "linux")]
	pidfd: Option<std::os::fd::OwnedFd>,
}
#[cfg(unix)]
impl ProcessGroup {
	/// Must run while the leader is unreaped, so that `pid` still names this command's group.
	fn new(pid: libc::pid_t) -> Self {
		Self {
			pid,
			reaped: false,
			#[cfg(target_os = "linux")]
			pidfd: group_pidfd(pid),
		}
	}
	/// Signals every member, with kill(2)'s result for a group: Ok if any member accepted it.
	fn send(&self, signal: libc::c_int) -> io::Result<()> {
		#[cfg(target_os = "linux")]
		if let Some(pidfd) = &self.pidfd {
			return signal_group_pidfd(pidfd, signal);
		}
		if unsafe { libc::kill(-self.pid, signal) } == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}
	/// True once no process is left in the group, zombies included.
	fn gone(&self) -> io::Result<bool> {
		match self.send(0) {
			Ok(()) => Ok(false),
			Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(true),
			Err(error) => Err(error),
		}
	}
}
/// A pidfd of the leader that can signal its whole group, or None where it cannot: before Linux 6.9, which
/// rejects `PIDFD_SIGNAL_PROCESS_GROUP`, or under a seccomp filter that refuses either call. The group is
/// then signalled through `kill(-pid)`.
#[cfg(target_os = "linux")]
fn group_pidfd(pid: libc::pid_t) -> Option<std::os::fd::OwnedFd> {
	use std::os::fd::FromRawFd;
	// pidfd_open always sets close-on-exec, so no other child inherits the descriptor.
	let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::c_long, 0 as libc::c_long) };
	if fd < 0 {
		return None;
	}
	let pidfd = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as std::os::fd::RawFd) };
	// The unreaped leader keeps its group alive, so this fails only where the kernel cannot do it.
	signal_group_pidfd(&pidfd, 0).is_ok().then_some(pidfd)
}
#[cfg(target_os = "linux")]
fn signal_group_pidfd(pidfd: &std::os::fd::OwnedFd, signal: libc::c_int) -> io::Result<()> {
	use std::os::fd::AsRawFd;
	let sent = unsafe {
		libc::syscall(
			libc::SYS_pidfd_send_signal,
			pidfd.as_raw_fd() as libc::c_long,
			signal as libc::c_long,
			std::ptr::null::<libc::siginfo_t>(),
			libc::PIDFD_SIGNAL_PROCESS_GROUP as libc::c_long,
		)
	};
	if sent == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}
/// macOS `posix_spawn` refuses to hand a child any descriptor at or above
/// `OPEN_MAX`, even though the process may still open descriptors past it.
#[cfg(target_os = "macos")]
const MACOS_SPAWN_FD_LIMIT: i32 = 10_240;
/// Three stdio pipes, two ends each.
#[cfg(unix)]
const PIPE_STDIO_FDS: i32 = 6;
#[cfg(unix)]
fn open_max_spawn_error(error: &io::Error, lowest_free_fd: i32, limit: i32) -> Option<io::Error> {
	if error.raw_os_error() != Some(libc::EBADF) || lowest_free_fd + PIPE_STDIO_FDS <= limit {
		return None;
	}
	Some(io::Error::new(
		error.kind(),
		format!(
			"{error}: the child's stdio would need file descriptors at or above {limit} (OPEN_MAX), \
			 which macOS cannot pass to a child process; the lowest free descriptor in this process is \
			 {lowest_free_fd}. Restart Atomic to release open descriptors."
		),
	))
}
#[cfg(unix)]
fn explain_spawn_error(error: io::Error) -> io::Error {
	#[cfg(target_os = "macos")]
	if error.raw_os_error() == Some(libc::EBADF)
		&& let Ok(probe) = File::open("/dev/null")
	{
		use std::os::fd::AsRawFd;
		if let Some(explained) = open_max_spawn_error(&error, probe.as_raw_fd(), MACOS_SPAWN_FD_LIMIT)
		{
			return explained;
		}
	}
	error
}
#[cfg(unix)]
fn make_nonblocking(fd: &impl std::os::fd::AsRawFd) -> io::Result<()> {
	let fd = fd.as_raw_fd();
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
}
fn drain_pipe(reader: &mut impl Read, command: &CommandTask, eof: &mut bool) -> io::Result<()> {
	read_pipe(reader, command, eof, true)
}
/// Reads what the pipe holds; with `keep` false the bytes are discarded, as output after a settled result is.
fn read_pipe(
	reader: &mut impl Read,
	command: &CommandTask,
	eof: &mut bool,
	keep: bool,
) -> io::Result<()> {
	if *eof {
		return Ok(());
	}
	let mut buffer = [0; 8192];
	for _ in 0..8 {
		match reader.read(&mut buffer) {
			Ok(0) => {
				*eof = true;
				break;
			},
			Ok(count) if keep => command.output.lock().unwrap().append(&buffer[..count]),
			Ok(_) => {},
			#[cfg(unix)]
			Err(error)
				if error.raw_os_error() == Some(libc::EIO)
					&& matches!(command.intent.terminal, CommandTerminal::Pty { .. }) =>
			{
				*eof = true;
				break;
			},
			Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
			Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
			Err(error) => return Err(error),
		}
	}
	Ok(())
}
#[cfg(unix)]
fn child_exited_without_reaping(pid: libc::pid_t) -> io::Result<bool> {
	let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
	let result = unsafe {
		libc::waitid(
			libc::P_PID,
			pid as libc::id_t,
			&mut info,
			libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
		)
	};
	if result < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(unsafe { info.si_pid() } != 0
		&& matches!(info.si_code, libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED))
}

const COMMAND_LIVE_BYTES: usize = 1_048_576;
const FOREGROUND_SPILL_BYTES: usize = 8_388_608;
const TASK_DISK_BYTES: u64 = 5_368_709_120;
const DETAIL_TAIL_BYTES: usize = 8_192;

#[napi(object)]
#[derive(Debug, PartialEq, Eq)]
pub struct OutputOffsets {
	pub start: String,
	pub end: String,
}
impl OutputOffsets {
	fn new(start: u64, end: u64) -> Self {
		Self { start: start.to_string(), end: end.to_string() }
	}
}
#[napi(object)]
pub struct OutputChunk {
	pub offsets: OutputOffsets,
	pub bytes: napi::bindgen_prelude::Buffer,
}
#[napi(object)]
pub struct OutputPage {
	pub requested: OutputOffsets,
	pub chunks: Vec<OutputChunk>,
	pub omitted_ranges: Vec<OutputOffsets>,
	pub next_offset: Option<String>,
}

// Collision recovery must not block startup indefinitely, even with hostile candidates.
const SPOOL_CREATE_ATTEMPTS: u32 = 32;

fn spool_candidate_at(base: &std::path::Path, timestamp: u128) -> io::Result<PathBuf> {
	let mut random = [0u8; 16];
	getrandom::fill(&mut random)
		.map_err(|error| io::Error::other(format!("spool randomness unavailable: {error}")))?;
	Ok(base.with_extension(format!("{timestamp}-{:032x}", u128::from_be_bytes(random))))
}

fn spool_candidate(base: &std::path::Path, _attempt: u32) -> io::Result<PathBuf> {
	let timestamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_err(|error| io::Error::other(format!("spool timestamp unavailable: {error}")))?
		.as_nanos();
	spool_candidate_at(base, timestamp)
}

#[cfg(test)]
type SpoolCandidate = fn(&std::path::Path, u32) -> io::Result<PathBuf>;
#[cfg(test)]
thread_local! {
	static TEST_SPOOL_CANDIDATE: std::cell::Cell<SpoolCandidate> = const { std::cell::Cell::new(spool_candidate) };
}
#[cfg(all(test, target_os = "linux"))]
thread_local! {
	static TEST_GROUP_BY_NUMBER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
#[cfg(all(test, unix))]
thread_local! {
	static TEST_QUARANTINE_GRACE: std::cell::Cell<Duration> = const { std::cell::Cell::new(PROCESS_QUARANTINE_GRACE) };
}

/// Raw bytes retain original offsets; consumers carry incomplete UTF-8 while decoding.
struct OutputStore {
	path: PathBuf,
	live_limit: usize,
	spill_threshold: usize,
	disk_cap: u64,
	byte_count: u64,
	head: Vec<u8>,
	tail: VecDeque<u8>,
	foreground: Vec<u8>,
	spilled: bool,
	file: Option<File>,
	released: bool,
	disk_len: u64,
	overflow: bool,
	unavailable: bool,
	spool_error: Option<String>,
	#[cfg(test)]
	candidate: SpoolCandidate,
}
impl Drop for OutputStore {
	fn drop(&mut self) {
		if self.file.take().is_some() || self.released {
			let _ = std::fs::remove_file(&self.path);
		}
	}
}
impl OutputStore {
	/// The retained prefix and rolling tail have at most one gap. No disk reads
	/// or output-sized allocations are needed to describe it at settlement.
	fn omitted_ranges(&self) -> Vec<OutputOffsets> {
		let prefix_end = self.disk_len.max(self.head.len() as u64).max(self.foreground.len() as u64);
		let tail_start = self.byte_count - self.tail.len() as u64;
		if prefix_end < tail_start {
			vec![OutputOffsets::new(prefix_end, tail_start)]
		} else {
			vec![]
		}
	}
	fn new(path: PathBuf, live_limit: usize, spill_threshold: usize, disk_cap: u64) -> Self {
		Self {
			path,
			live_limit,
			spill_threshold,
			disk_cap,
			byte_count: 0,
			head: Vec::new(),
			tail: VecDeque::new(),
			foreground: Vec::new(),
			spilled: false,
			file: None,
			released: false,
			disk_len: 0,
			unavailable: false,
			spool_error: None,
			overflow: false,
			#[cfg(test)]
			candidate: TEST_SPOOL_CANDIDATE.get(),
		}
	}
	fn append(&mut self, bytes: &[u8]) {
		let head_room = (self.live_limit / 2).saturating_sub(self.head.len());
		self.head.extend_from_slice(&bytes[..head_room.min(bytes.len())]);
		let tail_limit = self.live_limit - self.live_limit / 2;
		if bytes.len() >= tail_limit {
			self.tail.clear();
			self.tail.extend(&bytes[bytes.len() - tail_limit..]);
		} else {
			let evict = (self.tail.len() + bytes.len()).saturating_sub(tail_limit);
			self.tail.drain(..evict);
			self.tail.extend(bytes);
		}
		self.byte_count += bytes.len() as u64;
		if self.spilled {
			self.write_disk(bytes);
			return;
		}
		let keep = (self.spill_threshold - self.foreground.len()).min(bytes.len());
		self.foreground.extend_from_slice(&bytes[..keep]);
		if self.foreground.len() == self.spill_threshold {
			self.background();
			self.write_disk(&bytes[keep..]);
		}
	}
	/// Idempotent transition: synchronous bounded writes, no retry queue.
	fn background(&mut self) {
		if self.spilled {
			return;
		}
		self.spilled = true;
		let base = self.path.clone();
		for attempt in 0..SPOOL_CREATE_ATTEMPTS {
			#[cfg(test)]
			let candidate = self.candidate;
			#[cfg(not(test))]
			let candidate = spool_candidate;
			let allocation = candidate(&base, attempt).and_then(|path| {
				self.path = path;
				OpenOptions::new().read(true).write(true).create_new(true).open(&self.path)
			});
			match allocation {
				Ok(file) => {
					self.file = Some(file);
					break;
				},
				Err(error)
					if error.kind() == io::ErrorKind::AlreadyExists
						&& attempt + 1 < SPOOL_CREATE_ATTEMPTS => {},
				Err(error) => {
					self.spool_error = Some(error.to_string());
					self.unavailable = true;
					break;
				},
			}
		}
		let prefix = std::mem::take(&mut self.foreground);
		self.write_disk(&prefix);
	}
	fn write_disk(&mut self, bytes: &[u8]) {
		if self.unavailable {
			return;
		}
		let Some(file) = self.file.as_mut() else {
			return;
		};
		let overflow = bytes.len() as u64 > self.disk_cap - self.disk_len;
		let count = (self.disk_cap - self.disk_len).min(bytes.len() as u64) as usize;
		let mut remaining = &bytes[..count];
		if file.seek(SeekFrom::Start(self.disk_len)).is_err() {
			self.unavailable = true;
			return;
		}
		while !remaining.is_empty() {
			match file.write(remaining) {
				Ok(0) => {
					self.unavailable = true;
					break;
				},
				Ok(n) => {
					self.disk_len += n as u64;
					remaining = &remaining[n..];
				},
				Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => {
					self.unavailable = true;
					break;
				},
			}
		}
		self.overflow |= overflow && !self.unavailable;
	}
	/// Settled output keeps its bytes on disk but not an open descriptor (#3313).
	/// An empty spool holds nothing worth keeping, so it is removed.
	fn release_file(&mut self) {
		if self.file.take().is_none() {
			return;
		}
		self.released = true;
		if self.disk_len == 0 {
			let _ = std::fs::remove_file(&self.path);
		}
	}
	/// Whether the spool holds every byte the command wrote, so the in-memory copies only duplicate it.
	fn spooled_whole(&self) -> bool {
		self.spilled
			&& (self.released || self.file.is_some())
			&& !self.unavailable
			&& !self.overflow
			&& self.disk_len == self.byte_count
	}
	/// Frees the in-memory copies of the output (head, tail and foreground) and their allocations (#4215). Reads then
	/// come from the spool alone: the same bytes when it holds them all, and otherwise an omitted range for what only
	/// memory held.
	fn release_memory(&mut self) {
		self.head = Vec::new();
		self.tail = VecDeque::new();
		self.foreground = Vec::new();
	}
	/// What a settled command keeps of its output in memory: nothing, once its spool holds all of it (#4215).
	fn settle(&mut self) {
		self.release_file();
		if self.spooled_whole() {
			self.release_memory();
		}
	}
	fn read_disk(&mut self, start: u64, bytes: &mut [u8]) -> Option<io::Result<()>> {
		let read_at = |file: &mut File, bytes: &mut [u8]| {
			file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(bytes))
		};
		match self.file.as_mut() {
			Some(file) => Some(read_at(file, bytes)),
			None if self.released => {
				Some(File::open(&self.path).and_then(|mut file| read_at(&mut file, bytes)))
			},
			None => None,
		}
	}
	/// Snapshot owned segments; gaps are explicit, never concatenated ambiguously.
	fn page(&mut self, start: u64, maximum: u64) -> OutputPage {
		let maximum = maximum.min(COMMAND_LIVE_BYTES as u64);
		let end = start.saturating_add(maximum).min(self.byte_count).max(start);
		let mut segments: Vec<(u64, Vec<u8>)> = Vec::new();
		let disk_end = end.min(self.disk_len);
		if start < disk_end {
			let mut bytes = vec![0; (disk_end - start) as usize];
			match self.read_disk(start, &mut bytes) {
				Some(Ok(())) => segments.push((start, bytes)),
				Some(Err(_)) => self.unavailable = true,
				None => {},
			}
		}
		for (offset, bytes) in [(0, self.foreground.as_slice()), (0, self.head.as_slice())] {
			let lo = start.max(offset);
			let hi = end.min(offset + bytes.len() as u64);
			if lo < hi {
				segments.push((lo, bytes[(lo - offset) as usize..(hi - offset) as usize].to_vec()));
			}
		}
		let tail_start = self.byte_count - self.tail.len() as u64;
		let lo = start.max(tail_start);
		let hi = end.min(self.byte_count);
		if lo < hi {
			segments.push((
				lo,
				self
					.tail
					.iter()
					.skip((lo - tail_start) as usize)
					.take((hi - lo) as usize)
					.copied()
					.collect(),
			));
		}
		segments.sort_by_key(|(offset, _)| *offset);
		let mut page = OutputPage {
			requested: OutputOffsets::new(start, start.saturating_add(maximum)),
			chunks: Vec::new(),
			omitted_ranges: Vec::new(),
			next_offset: (end < self.byte_count).then(|| end.to_string()),
		};
		let mut cursor = start;
		for (offset, bytes) in segments {
			let segment_end = offset + bytes.len() as u64;
			if segment_end <= cursor {
				continue;
			}
			if offset > cursor {
				page.omitted_ranges.push(OutputOffsets::new(cursor, offset));
			}
			let lo = cursor.max(offset);
			page.chunks.push(OutputChunk {
				offsets: OutputOffsets::new(lo, segment_end),
				bytes: bytes[(lo - offset) as usize..].to_vec().into(),
			});
			cursor = segment_end;
		}
		if cursor < end {
			page.omitted_ranges.push(OutputOffsets::new(cursor, end));
		}
		page
	}
}

#[derive(Default)]
struct Utf8Carry {
	pending: Vec<u8>,
}
impl Utf8Carry {
	fn decode(&mut self, bytes: &[u8], eof: bool) -> String {
		let mut input = std::mem::take(&mut self.pending);
		input.extend_from_slice(bytes);
		let mut rest = input.as_slice();
		let mut text = String::new();
		loop {
			match std::str::from_utf8(rest) {
				Ok(valid) => {
					text.push_str(valid);
					break;
				},
				Err(error) => {
					text.push_str(
						std::str::from_utf8(&rest[..error.valid_up_to()]).expect("validated prefix"),
					);
					rest = &rest[error.valid_up_to()..];
					match error.error_len() {
						Some(n) => {
							text.push('\u{fffd}');
							rest = &rest[n..];
						},
						None => {
							if eof {
								text.push('\u{fffd}');
							} else {
								self.pending.extend_from_slice(rest);
							}
							break;
						},
					}
				},
			}
		}
		text
	}
}
#[cfg(test)]
mod tests {
	use super::*;
	struct SpoolCandidateGuard(SpoolCandidate);
	impl SpoolCandidateGuard {
		fn new(candidate: SpoolCandidate) -> Self {
			Self(TEST_SPOOL_CANDIDATE.replace(candidate))
		}
	}
	impl Drop for SpoolCandidateGuard {
		fn drop(&mut self) {
			TEST_SPOOL_CANDIDATE.set(self.0);
		}
	}
	fn sequential_candidate(base: &std::path::Path, attempt: u32) -> io::Result<PathBuf> {
		Ok(if attempt == 0 { base.to_path_buf() } else { base.with_extension(attempt.to_string()) })
	}
	#[cfg(unix)]
	#[test]
	fn command_spool_entropy_failure_refuses_before_execution() {
		let _candidates = SpoolCandidateGuard::new(|_, attempt| {
			assert_eq!(attempt, 0, "entropy failures must not retry");
			Err(io::Error::other("spool randomness unavailable: injected entropy failure"))
		});
		let (actor, owner) = command_owner();
		let marker = std::env::temp_dir().join(format!(
			"atomic-entropy-{}-{}",
			std::process::id(),
			Cap { task: Some(0), attempt: 1, ..owner.cap.clone() }.reference().task_id
		));
		assert!(!marker.exists());
		let result = actor.start_command(
			&owner,
			pipe_intent(&format!("printf executed > '{}'", marker.display())),
			"entropy".into(),
		);
		actor.shutdown();
		assert_eq!(result.err().map(|error| error.code), Some("SpawnFailed".into()));
		let state = actor.state.lock().unwrap();
		let task = &state.owners[0].tasks[0];
		assert!(
			matches!(&task.record.execution, Execution::Settled { result: TaskResult::Failed { code, .. } } if code == &JsString::from("SpawnFailed"))
		);
		assert!(matches!(task.record.cleanup, Cleanup::Reaped {}));
		let mut store = task.command.as_ref().unwrap().output.lock().unwrap();
		assert_eq!(
			store.spool_error.as_deref(),
			Some("spool randomness unavailable: injected entropy failure")
		);
		store.candidate = |_, _| panic!("failed allocation retried");
		store.background();
		store.append(b"later");
		assert!(!marker.exists(), "entropy failure executed command");
	}
	fn command_owner() -> (Arc<Actor>, OwnerLease) {
		let actor = Actor::new();
		let scope = OwnerScope::Session { session_id: "pipe-test".into() };
		let host = actor.bind(scope.clone());
		let owner = actor.open(&host, scope).unwrap();
		(actor, owner)
	}
	fn pipe_intent(command: &str) -> CommandIntent {
		CommandIntent {
			kind: CommandTaskKind::Command,
			command: command.into(),
			description: None,
			cwd: None,
			env: None,
			terminal: CommandTerminal::Pipe {},
			shell: None,
			inherit_env: None,
			execution_timeout_ms: None,
			parent_task_id: None,
		}
	}
	#[test]
	fn spool_names_are_distinct_with_frozen_time() {
		let base = std::env::temp_dir().join("atomic-command-frozen");
		let first = spool_candidate_at(&base, 123456789).unwrap();
		let second = spool_candidate_at(&base, 123456789).unwrap();
		assert_ne!(first, second);
		for path in [first, second] {
			let name = path.file_name().unwrap().to_str().unwrap();
			assert!(name.starts_with("atomic-command-frozen.123456789-"));
			let suffix = name.rsplit('-').next().unwrap();
			assert_eq!(suffix.len(), 32);
			assert!(suffix.bytes().all(|byte| byte.is_ascii_hexdigit()));
		}
	}
	// #3105: retained output from a recycled PID must not prevent command startup.
	#[cfg(unix)]
	#[test]
	fn command_starts_with_retained_spool_from_previous_process() {
		let (actor, owner) = command_owner();
		let reference = Cap { task: Some(0), attempt: 1, ..owner.cap.clone() }.reference();
		let path = std::env::temp_dir().join(format!(
			"atomic-command-{}-{}",
			std::process::id(),
			reference.task_id
		));
		let retained: Vec<_> = (0..SPOOL_CREATE_ATTEMPTS)
			.map(|attempt| sequential_candidate(&path, attempt).unwrap())
			.collect();
		for path in &retained {
			std::fs::write(path, b"previous process output").unwrap();
		}
		let result = actor.start_command(&owner, pipe_intent("printf fresh"), "collision".into());
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		assert!(command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE));
		actor.shutdown();
		for path in retained {
			assert_eq!(std::fs::read(&path).unwrap(), b"previous process output");
			std::fs::remove_file(path).unwrap();
		}
		assert!(result.is_ok(), "{result:?}");
		let allocated = command.output.lock().unwrap().path.clone();
		assert_ne!(allocated, path);
		assert_eq!(std::fs::read(&allocated).unwrap(), b"fresh");
		std::fs::remove_file(allocated).unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn command_spool_collision_uses_final_permitted_candidate() {
		let _candidates = SpoolCandidateGuard::new(sequential_candidate);
		let (actor, owner) = command_owner();
		let reference = Cap { task: Some(0), attempt: 1, ..owner.cap.clone() }.reference();
		let base = std::env::temp_dir().join(format!(
			"atomic-command-{}-{}",
			std::process::id(),
			reference.task_id
		));
		let candidates: Vec<_> = (0..SPOOL_CREATE_ATTEMPTS - 1)
			.map(
				|suffix| {
					if suffix == 0 { base.clone() } else { base.with_extension(suffix.to_string()) }
				},
			)
			.collect();
		for path in &candidates {
			std::fs::write(path, b"retained output").unwrap();
		}
		let final_path = base.with_extension((SPOOL_CREATE_ATTEMPTS - 1).to_string());
		assert!(!final_path.exists());
		let result = actor.start_command(&owner, pipe_intent("printf fresh"), "boundary".into());
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		assert!(command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE));
		actor.shutdown();
		for path in &candidates {
			assert_eq!(std::fs::read(path).unwrap(), b"retained output");
			std::fs::remove_file(path).unwrap();
		}
		assert!(result.is_ok(), "{result:?}");
		assert_eq!(std::fs::read(&final_path).unwrap(), b"fresh");
		std::fs::remove_file(final_path).unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn command_spool_collision_exhaustion_refuses_before_execution() {
		let _candidates = SpoolCandidateGuard::new(sequential_candidate);
		let (actor, owner) = command_owner();
		let reference = Cap { task: Some(0), attempt: 1, ..owner.cap.clone() }.reference();
		let base = std::env::temp_dir().join(format!(
			"atomic-command-{}-{}",
			std::process::id(),
			reference.task_id
		));
		let candidates: Vec<_> = (0..SPOOL_CREATE_ATTEMPTS)
			.map(
				|suffix| {
					if suffix == 0 { base.clone() } else { base.with_extension(suffix.to_string()) }
				},
			)
			.collect();
		for path in &candidates {
			std::fs::write(path, b"retained output").unwrap();
		}
		let next = base.with_extension(SPOOL_CREATE_ATTEMPTS.to_string());
		let side_effect = base.with_extension("executed");
		assert!(!next.exists());
		assert!(!side_effect.exists());
		let result = actor.start_command(
			&owner,
			pipe_intent(&format!("printf executed > '{}'", side_effect.display())),
			"exhaustion".into(),
		);
		actor.shutdown();
		let state = actor.state.lock().unwrap();
		let task = &state.owners[0].tasks[0];
		let refused = matches!(&task.record.execution,
			Execution::Settled { result: TaskResult::Failed { code, .. } } if code == &JsString::from("SpawnFailed"));
		let reaped = matches!(task.record.cleanup, Cleanup::Reaped {});
		let mut store = task.command.as_ref().unwrap().output.lock().unwrap();
		for path in &candidates {
			assert_eq!(std::fs::read(path).unwrap(), b"retained output");
			std::fs::remove_file(path).unwrap();
		}
		// Even after the occupied names become free, exhaustion is terminal.
		store.background();
		store.append(b"later");
		let retried = candidates.iter().any(|path| path.exists());
		let exceeded = next.exists();
		let executed = side_effect.exists();
		let _ = std::fs::remove_file(next);
		let _ = std::fs::remove_file(side_effect);
		assert_eq!(result.err().map(|error| error.code), Some("SpawnFailed".into()));
		assert!(refused && reaped, "spawn refusal must settle and reap");
		assert!(!executed, "exhausted spool allocation executed the command");
		assert!(!exceeded, "allocation exceeded the candidate budget");
		assert!(!retried, "exhausted allocation retried after names became free");
	}

	// #2905: inherited stdout/stderr must not bypass the shared disk budget.
	#[cfg(unix)]
	#[test]
	fn file_spool_caps_concurrent_descendant_writes_before_stop() {
		let (actor, owner) = command_owner();
		let task = actor
			.start_command_configured(
				&owner,
				pipe_intent(
					"(printf abcdefghijklmnop >&2) & printf ABCDEFGHIJKLMNOP; wait; exec sleep 30",
				),
				"cap".into(),
				CommandResourceOptions { disk_cap_bytes: Some(5.0), ..Default::default() },
			)
			.unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		let deadline = Instant::now() + PROCESS_SHUTDOWN_GRACE;
		while command.output.lock().unwrap().byte_count < 32 {
			assert!(Instant::now() < deadline, "concurrent output barrier");
			std::thread::sleep(PROCESS_POLL);
		}
		let store = command.output.lock().unwrap();
		assert_eq!(std::fs::metadata(&store.path).unwrap().len(), 5);
		assert_eq!(store.byte_count, 32);
		drop(store);
		let wait = actor.wait(&task, None, false).unwrap();
		actor.yield_wait(&wait, YieldReason::Elapsed).unwrap();
		assert!(command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE));
		assert_eq!(std::fs::metadata(&command.output.lock().unwrap().path).unwrap().len(), 5);
		let receipt = actor.cancel(&task, CancelCause::User).unwrap();
		assert!(
			matches!(receipt.execution, Execution::Settled { result: TaskResult::Failed { ref code, .. } } if code == &JsString::from("OutputLimitExceeded"))
		);
		assert!(matches!(receipt.cleanup, Cleanup::Reaped {}));
	}

	// #2884: unsupported terminal modes must never execute as a different backend.
	#[cfg(not(any(unix, windows)))]
	#[test]
	fn unsupported_pty_refuses_before_execution() {
		let (actor, owner) = command_owner();
		let path = std::env::temp_dir().join(format!(
			"atomic-pty-refusal-{}-{}",
			std::process::id(),
			actor.id
		));
		let mut intent = pipe_intent(&format!("printf executed > '{}'", path.display()));
		intent.terminal = CommandTerminal::Pty { columns: 80, rows: 24 };
		let result = actor.start_command(&owner, intent, "pty".into());
		actor.shutdown();
		let executed = path.exists();
		let _ = std::fs::remove_file(path);
		assert_eq!(result.err().map(|e| e.code), Some("ContainmentUnavailable".into()));
		assert!(!executed, "refused PTY executed shell side effects");
	}
	#[cfg(unix)]
	fn wait_for_file(path: &std::path::Path) -> String {
		let deadline = Instant::now() + Duration::from_secs(5);
		loop {
			if let Ok(text) = std::fs::read_to_string(path)
				&& text.ends_with('\n')
			{
				return text;
			}
			assert!(Instant::now() < deadline, "fixture did not become ready: {}", path.display());
			std::thread::sleep(PROCESS_POLL);
		}
	}
	// #2884: normal environment shutdown must finish native cleanup, not just seal admission.
	#[cfg(unix)]
	#[test]
	fn shutdown_waits_for_native_child_cleanup() {
		let (actor, owner) = command_owner();
		let path =
			std::env::temp_dir().join(format!("atomic-shutdown-{}-{}", std::process::id(), actor.id));
		actor
			.start_command(
				&owner,
				pipe_intent(&format!("echo $$ > '{}'; exec sleep 30", path.display())),
				"shutdown".into(),
			)
			.unwrap();
		let pid: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
		std::fs::remove_file(path).unwrap();
		actor.shutdown();
		let still_exists = unsafe { libc::kill(pid, 0) } == 0;
		assert!(!still_exists, "native child {pid} survived normal shutdown");
		assert!(matches!(actor.snapshot(&owner).unwrap().tasks[0].cleanup, Cleanup::Reaped {}));
	}
	// Darwin's group probe can return EPERM while another parent still owns a zombie.
	#[cfg(target_os = "macos")]
	#[test]
	fn externally_terminated_group_waits_for_unreaped_member() {
		assert_external_termination_cleanup(true);
	}
	#[cfg(unix)]
	#[test]
	fn stopped_command_group_is_not_treated_as_exited_3869() {
		let (actor, owner) = command_owner();
		let path =
			std::env::temp_dir().join(format!("atomic-stopped-{}-{}", std::process::id(), actor.id));
		actor
			.start_command(
				&owner,
				pipe_intent(&format!("echo $$ > '{}'; exec sleep 30", path.display())),
				"stopped".into(),
			)
			.unwrap();
		let pid: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
		std::fs::remove_file(path).unwrap();
		assert_eq!(unsafe { libc::kill(-pid, libc::SIGSTOP) }, 0);
		std::thread::sleep(PROCESS_TERM_GRACE * 2);
		let task = &actor.snapshot(&owner).unwrap().tasks[0];
		assert!(matches!(task.execution, Execution::Running {}), "{:?}", task.execution);
		assert!(matches!(task.cleanup, Cleanup::Active {}));
		assert_eq!(unsafe { libc::kill(-pid, 0) }, 0, "a stopped group is still alive");
		unsafe { libc::kill(-pid, libc::SIGCONT) };
		actor.shutdown();
	}
	#[cfg(unix)]
	#[test]
	fn started_command_exposes_its_process_group_for_identity_only() {
		let (actor, owner) = command_owner();
		let path =
			std::env::temp_dir().join(format!("atomic-group-{}-{}", std::process::id(), actor.id));
		let lease = actor
			.start_command(
				&owner,
				pipe_intent(&format!("echo $$ > '{}'; exec sleep 30", path.display())),
				"group".into(),
			)
			.unwrap();
		let pid: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
		std::fs::remove_file(path).unwrap();
		assert_eq!(actor.process_group(&lease).unwrap(), Some(pid));
		assert_eq!(unsafe { libc::getpgid(pid) }, pid);
		actor.shutdown();
		assert_eq!(actor.process_group(&lease).unwrap(), Some(pid), "the identity outlives cleanup");
	}
	#[cfg(target_os = "macos")]
	#[test]
	fn externally_terminated_group_keeps_persistent_probe_refusal_as_failure() {
		assert_external_termination_cleanup(false);
	}
	#[cfg(target_os = "macos")]
	fn assert_external_termination_cleanup(reap_within_grace: bool) {
		use std::os::unix::process::CommandExt;
		use std::process::{Command, Stdio};
		let (actor, owner) = command_owner();
		let path = std::env::temp_dir().join(format!(
			"atomic-external-term-{}-{}",
			std::process::id(),
			actor.id
		));
		actor
			.start_command_configured(
				&owner,
				pipe_intent(&format!("echo $$ > '{}'; exec sleep 30", path.display())),
				"external-term".into(),
				CommandResourceOptions { background: Some(true), ..Default::default() },
			)
			.unwrap();
		let pid: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
		std::fs::remove_file(path).unwrap();
		// Keep a group member waitable here to deterministically model a descendant
		// awaiting reaping by another parent after an external killpg(SIGTERM).
		let mut member = Command::new("/bin/sleep")
			.arg("30")
			.process_group(pid)
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.unwrap();
		let started = Instant::now();
		assert_eq!(unsafe { libc::kill(-pid, libc::SIGTERM) }, 0);
		actor.begin_close(&owner).unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		// Wait for the supervisor to reap its leader, without taking its wait authority.
		loop {
			if let Err(error) = child_exited_without_reaping(pid) {
				assert_eq!(error.raw_os_error(), Some(libc::ECHILD));
				break;
			}
			assert!(started.elapsed() < PROCESS_SHUTDOWN_GRACE, "leader was not reaped");
			std::thread::sleep(PROCESS_POLL);
		}
		// Hold the zombie through several post-reap probes, or through the entire
		// drain bound. It cannot disappear until this test explicitly waits for it.
		let observation =
			if reap_within_grace { Duration::from_millis(100) } else { PROCESS_SHUTDOWN_GRACE };
		let finished = command.join_until(Instant::now() + observation);
		let before_reap = actor.snapshot(&owner).unwrap();
		let probe = unsafe { libc::kill(-pid, 0) };
		let probe_error = io::Error::last_os_error().raw_os_error();
		let member_exited = child_exited_without_reaping(member.id() as libc::pid_t).unwrap();
		member.wait().unwrap();
		assert!(command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE));
		let receipt = actor.close_receipt(&owner);
		actor.shutdown();
		assert_eq!(probe, -1);
		assert_eq!(probe_error, Some(libc::EPERM));
		assert!(member_exited, "fixture must be an unreaped zombie, not a live process");
		assert!(!command.output.lock().unwrap().path.exists(), "empty settled spool stayed on disk");
		if reap_within_grace {
			assert!(!finished, "cleanup settled before the zombie was reaped: {before_reap:?}");
			assert!(matches!(before_reap.tasks[0].cleanup, Cleanup::Draining {}));
			assert!(receipt.unwrap().is_some());
			assert!(matches!(actor.snapshot(&owner).unwrap().tasks[0].cleanup, Cleanup::Reaped {}));
		} else {
			assert!(finished, "persistent refusal must settle within the shutdown bound");
			assert!(started.elapsed() >= PROCESS_TERM_GRACE + PROCESS_DRAIN_GRACE);
			let error = receipt.unwrap_err();
			assert_eq!(error.code, "CleanupFailed");
			assert!(error.message.contains("Operation not permitted (os error 1)"), "{error:?}");
			assert!(matches!(before_reap.tasks[0].cleanup, Cleanup::Failed { .. }));
		}
		assert_eq!(unsafe { libc::kill(-pid, 0) }, -1);
		assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
		// Only zombies were left once the leader was reaped, so nothing was alive to KILL (#4268).
		assert_eq!(*command.signals.lock().unwrap(), vec![(pid, libc::SIGTERM)]);
	}

	// #2884: EOF and the shell's exit are not proof that a closed-stdio descendant exited.
	#[cfg(unix)]
	#[test]
	fn failed_group_kill_cannot_report_reaped() {
		let (actor, owner) = command_owner();
		let path = std::env::temp_dir().join(format!(
			"atomic-kill-failure-{}-{}",
			std::process::id(),
			actor.id
		));
		let task = actor.start_command(&owner, pipe_intent(&format!(
			"/bin/sh -c 'trap \"\" TERM; echo $$ > \"$1\"; exec sleep 30' sh '{}' </dev/null >/dev/null 2>&1 & wait", path.display()
		)), "kill-failure".into()).unwrap();
		let pid: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
		std::fs::remove_file(path).unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		// Inject the OS refusal, not fake process state or cleanup acknowledgements.
		command.kill_error.store(libc::EPERM, Ordering::Release);
		actor.begin_close(&owner).unwrap();
		assert!(command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE));
		let receipt = actor.close_receipt(&owner);
		let alive = unsafe { libc::kill(pid, 0) } == 0;
		unsafe {
			libc::kill(pid, libc::SIGKILL);
		}
		assert!(alive, "fixture must survive the injected failed kill");
		assert_eq!(receipt.unwrap_err().code, "CleanupFailed");
		assert_eq!(actor.snapshot(&owner).unwrap().state, "closing");
		assert_eq!(actor.cancel(&task, CancelCause::User).unwrap_err().code, "CleanupFailed");
	}
	// A stopped command whose process cleanup cannot be confirmed ends within the cleanup bound
	// as "cleanup unconfirmed", instead of staying "stopping" forever.
	#[cfg(unix)]
	#[test]
	fn stopped_command_with_unconfirmed_cleanup_settles_within_its_bound() {
		let (actor, owner) = command_owner();
		let path = std::env::temp_dir().join(format!(
			"atomic-unconfirmed-stop-{}-{}",
			std::process::id(),
			actor.id
		));
		let task = actor
			.start_command(
				&owner,
				pipe_intent(&format!("trap '' TERM; echo $$ > '{}'; exec sleep 30", path.display())),
				"unconfirmed-stop".into(),
			)
			.unwrap();
		let pid: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
		std::fs::remove_file(path).unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		// Inject the OS refusal, not fake process state or cleanup acknowledgements.
		command.kill_error.store(libc::EPERM, Ordering::Release);
		let started = Instant::now();
		let requested = actor.cancel(&task, CancelCause::User).unwrap();
		let finished = command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE);
		let task = actor.snapshot(&owner).unwrap().tasks[0].clone();
		unsafe {
			libc::kill(pid, libc::SIGKILL);
		}
		actor.shutdown();
		assert_eq!(requested.execution, Execution::Cancelling { cause: CancelCause::User });
		assert!(finished, "cleanup must give up within its bound");
		assert!(started.elapsed() < PROCESS_SHUTDOWN_GRACE);
		match &task.execution {
			Execution::Settled { result: TaskResult::Failed { code, message, .. } } => {
				assert_eq!(code, &JsString::from("CleanupUnconfirmed"));
				let message = message.process_text();
				assert!(message.contains("Stop requested (user)"), "{message}");
				assert!(message.contains("cleanup unconfirmed"), "{message}");
			},
			other => panic!("a stop whose cleanup failed stayed {other:?}"),
		}
		assert!(matches!(task.cleanup, Cleanup::Failed { .. }), "{:?}", task.cleanup);
		assert_eq!(task.observation, HostObservation::None { reason: "task-settled".into() });
	}
	// RFC #2884: observation timeout does not terminate the owned process group.
	#[cfg(unix)]
	#[test]
	fn unix_pipe_yields_then_owner_close_reaps() {
		assert_process_tree_cleanup(false);
	}
	// #2884: the shell exiting first cannot release group authority over closed-stdio children.
	#[cfg(unix)]
	#[test]
	fn unix_pipe_shell_exits_before_closed_stdio_descendant() {
		assert_process_tree_cleanup(true);
	}
	#[cfg(unix)]
	fn assert_process_tree_cleanup(shell_exits_first: bool) {
		let (actor, owner) = command_owner();
		let path =
			std::env::temp_dir().join(format!("atomic-tree-{}-{}", std::process::id(), actor.id));
		std::fs::create_dir(&path).unwrap();
		let intent = pipe_intent(&format!(
			"echo $$ > '{0}/parent'; /bin/sh -c 'trap \"\" TERM; echo $$ > \"$1\"; exec sleep 30' sh '{0}/descendant' </dev/null >/dev/null 2>&1 & while [ ! -f '{0}/exit' ]; do sleep 0.01; done; exit 0",
			path.display()
		));
		let task = actor.start_command(&owner, intent.clone(), "once".into()).unwrap();
		assert_eq!(actor.start_command(&owner, intent, "once".into()).unwrap().cap, task.cap);
		let parent: libc::pid_t = wait_for_file(&path.join("parent")).trim().parse().unwrap();
		let descendant: libc::pid_t = wait_for_file(&path.join("descendant")).trim().parse().unwrap();
		let wait = actor.wait(&task, None, false).unwrap();
		actor.yield_wait(&wait, YieldReason::Elapsed).unwrap();
		assert_eq!(unsafe { libc::kill(parent, 0) }, 0);
		assert_eq!(unsafe { libc::kill(descendant, 0) }, 0);
		assert!(matches!(actor.snapshot(&owner).unwrap().tasks[0].execution, Execution::Running {}));
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		if shell_exits_first {
			std::fs::write(path.join("exit"), b"exit").unwrap();
		} else {
			actor.begin_close(&owner).unwrap();
		}
		assert!(command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE));
		let snapshot = actor.snapshot(&owner).unwrap();
		assert!(matches!(snapshot.tasks[0].cleanup, Cleanup::Reaped {}), "{snapshot:?}");
		for pid in [parent, descendant] {
			assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "process {pid} survived successful cleanup");
			assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
		}
		assert_eq!(
			*command.signals.lock().unwrap(),
			vec![(parent, libc::SIGTERM), (parent, libc::SIGKILL)]
		);
		// After handles are released, replay never issues another signal, regardless of PID reuse.
		let first = actor.cancel(&task, CancelCause::User).unwrap();
		assert_eq!(actor.cancel(&task, CancelCause::ExecutionTimeout).unwrap(), first);
		actor.begin_close(&owner).unwrap();
		assert!(actor.close_receipt(&owner).unwrap().is_some());
		actor.shutdown();
		assert_eq!(command.signals.lock().unwrap().len(), 2);
		std::fs::remove_dir_all(path).unwrap();
	}
	/// Each terminal with each way this platform signals a group: on Linux both through a pidfd (where the
	/// kernel supports it) and by number, the path macOS and Linux before 6.9 take.
	#[cfg(unix)]
	fn group_cases() -> Vec<(CommandTerminal, bool)> {
		let by_number: &[bool] = if cfg!(target_os = "linux") { &[false, true] } else { &[true] };
		[CommandTerminal::Pipe {}, CommandTerminal::Pty { columns: 80, rows: 24 }]
			.into_iter()
			.flat_map(|terminal| by_number.iter().map(move |&by_number| (terminal.clone(), by_number)))
			.collect()
	}
	/// Runs one command to settlement; returns how long it took, its record, its group signals and its group.
	#[cfg(unix)]
	fn settle(
		command: &str,
		terminal: &CommandTerminal,
		#[cfg_attr(not(target_os = "linux"), allow(unused_variables))] by_number: bool,
	) -> (Duration, TaskRecord, Vec<(libc::pid_t, libc::c_int)>, libc::pid_t) {
		let (actor, owner) = command_owner();
		let intent = CommandIntent { terminal: terminal.clone(), ..pipe_intent(command) };
		let started = Instant::now();
		#[cfg(target_os = "linux")]
		TEST_GROUP_BY_NUMBER.set(by_number);
		let launched = actor.start_command(&owner, intent, "settle".into());
		#[cfg(target_os = "linux")]
		TEST_GROUP_BY_NUMBER.set(false);
		launched.unwrap();
		let task = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		assert!(task.join_until(started + PROCESS_SHUTDOWN_GRACE), "{terminal:?} did not settle");
		let elapsed = started.elapsed();
		let record = actor.snapshot(&owner).unwrap().tasks[0].clone();
		actor.shutdown();
		let signals = task.signals.lock().unwrap().clone();
		(elapsed, record, signals, task.process_group.load(Ordering::Acquire))
	}
	#[cfg(unix)]
	fn assert_completed(record: &TaskRecord, case: &str) {
		let exit_code = match &record.execution {
			Execution::Settled { result: TaskResult::Completed { exit_code, .. } } => *exit_code,
			other => panic!("{case}: {other:?}"),
		};
		assert_eq!(exit_code, Some(0.0), "{case}");
		assert!(matches!(record.cleanup, Cleanup::Reaped {}), "{case}: {:?}", record.cleanup);
	}
	#[cfg(unix)]
	fn assert_gone(pid: libc::pid_t, case: &str) {
		assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{case}: process {pid} survived cleanup");
		assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
	}
	/// A shell that leaves one member behind in its group, closed off from its output, and exits.
	#[cfg(unix)]
	fn leave_member(path: &std::path::Path, trap: &str) -> String {
		format!(
			"/bin/sh -c '{trap}echo $$ > \"$1\"; exec sleep 30' sh '{0}' </dev/null >/dev/null 2>&1 & while [ ! -s '{0}' ]; do sleep 0.01; done",
			path.display()
		)
	}
	// #4268: a command whose group is empty when it exits settles at once, not after the TERM grace.
	#[cfg(unix)]
	#[test]
	fn command_with_an_empty_group_settles_without_the_term_grace_4268() {
		for (terminal, by_number) in group_cases() {
			let case = format!("{terminal:?}, by number: {by_number}");
			let (elapsed, record, signals, pid) = settle("printf done", &terminal, by_number);
			assert_completed(&record, &case);
			assert!(elapsed < PROCESS_TERM_GRACE / 2, "{case}: settled after {elapsed:?}");
			assert_eq!(signals, vec![(pid, libc::SIGTERM)], "{case}: nothing was left to kill");
		}
	}
	// #4268: a member left behind that exits on TERM ends the wait as soon as it is gone.
	#[cfg(unix)]
	#[test]
	fn straggler_that_exits_on_term_settles_before_the_grace_4268() {
		let path = std::env::temp_dir().join(format!("atomic-term-straggler-{}", std::process::id()));
		for (terminal, by_number) in group_cases() {
			let case = format!("{terminal:?}, by number: {by_number}");
			let (elapsed, record, signals, pid) =
				settle(&leave_member(&path, ""), &terminal, by_number);
			let straggler: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
			std::fs::remove_file(&path).unwrap();
			assert_completed(&record, &case);
			assert_gone(straggler, &case);
			assert!(elapsed < PROCESS_TERM_GRACE, "{case}: settled after {elapsed:?}");
			assert_eq!(signals, vec![(pid, libc::SIGTERM)], "{case}: TERM was enough");
		}
	}
	// #4268: a member left behind that ignores TERM still gets KILL once the grace ends, and does not survive.
	#[cfg(unix)]
	#[test]
	fn straggler_that_ignores_term_is_killed_after_the_grace_4268() {
		let path = std::env::temp_dir().join(format!("atomic-kill-straggler-{}", std::process::id()));
		for (terminal, by_number) in group_cases() {
			let case = format!("{terminal:?}, by number: {by_number}");
			// The terminal's hangup when its session leader exits must not end the member either.
			let command = leave_member(&path, "trap \"\" TERM HUP; ");
			let (elapsed, record, signals, pid) = settle(&command, &terminal, by_number);
			let straggler: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
			std::fs::remove_file(&path).unwrap();
			assert_completed(&record, &case);
			assert_gone(straggler, &case);
			assert!(elapsed >= PROCESS_TERM_GRACE, "{case}: settled after {elapsed:?}");
			assert_eq!(
				signals,
				vec![(pid, libc::SIGTERM), (pid, libc::SIGKILL)],
				"{case}: the member needed KILL"
			);
		}
	}
	// #2884: failed cleanup retains the live OS child without a blocked worker.
	#[cfg(unix)]
	#[test]
	fn failed_cleanup_retains_live_child_across_environment_drop() {
		let (actor, owner) = command_owner();
		let path =
			std::env::temp_dir().join(format!("atomic-retained-{}-{}", std::process::id(), actor.id));
		let task = actor
			.start_command(
				&owner,
				pipe_intent(&format!("trap '' TERM; echo $$ > '{}'; exec sleep 30", path.display())),
				"retained".into(),
			)
			.unwrap();
		let pid: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
		std::fs::remove_file(path).unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		command.kill_error.store(libc::EPERM, Ordering::Release);
		actor.shutdown();
		let failed =
			matches!(actor.snapshot(&owner).unwrap().tasks[0].cleanup, Cleanup::Failed { .. });
		let retained = command.retained.lock().unwrap().as_mut().is_some_and(|resource| {
			resource.reference == task.cap.reference()
				&& !resource.message.is_empty()
				&& matches!(resource.child.try_wait(), Ok(None))
		});
		drop(actor);
		drop(command);
		let transferred = FAILED_PROCESSES
			.lock()
			.unwrap()
			.iter()
			.any(|resource| resource.reference == task.cap.reference());
		unsafe {
			libc::kill(pid, libc::SIGKILL);
		}
		// The fixture must also clean up if resource retention regresses.
		let deadline = Instant::now() + PROCESS_SHUTDOWN_GRACE;
		loop {
			poll_failed_processes();
			if transferred {
				if !FAILED_PROCESSES
					.lock()
					.unwrap()
					.iter()
					.any(|resource| resource.reference == task.cap.reference())
				{
					break;
				}
			} else if unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) } != 0 {
				break;
			}
			assert!(Instant::now() < deadline);
			std::thread::sleep(PROCESS_POLL);
		}
		assert!(failed);
		assert!(retained, "failed cleanup dropped its live child");
		assert!(transferred, "environment drop discarded native failure ownership");
	}
	/// A command that leaves a holder in its own session, outside the command's group, holding the output pipes until
	/// `release` exists. `leader` runs once the holder has recorded its PID.
	#[cfg(target_os = "linux")]
	fn escaped_holder(dir: &std::path::Path, leader: &str) -> String {
		format!(
			"setsid /bin/sh -c 'echo $$ > \"$1\"; while [ ! -e \"$2\" ]; do sleep 0.01; done' sh '{0}/holder' '{0}/release' & while [ ! -s '{0}/holder' ]; do sleep 0.01; done; {leader}",
			dir.display()
		)
	}
	#[cfg(target_os = "linux")]
	fn settled_record(actor: &Actor, owner: &OwnerLease) -> TaskRecord {
		let deadline =
			Instant::now() + PROCESS_TERM_GRACE + PROCESS_DRAIN_GRACE + PROCESS_SHUTDOWN_GRACE;
		loop {
			let record = actor.snapshot(owner).unwrap().tasks[0].clone();
			if matches!(record.execution, Execution::Settled { .. })
				&& !matches!(record.cleanup, Cleanup::Active {} | Cleanup::Draining {})
			{
				return record;
			}
			assert!(Instant::now() < deadline, "the result never settled: {record:?}");
			std::thread::sleep(PROCESS_POLL);
		}
	}
	#[cfg(target_os = "linux")]
	fn assert_group_gone(group: libc::pid_t) {
		assert_eq!(unsafe { libc::kill(-group, 0) }, -1, "process group {group} survived cleanup");
		assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
	}
	/// A holder process a test started outside the command's group. It is killed and awaited when dropped, also when
	/// the test panics first, so a failing test never leaves it holding a pipe or stopped.
	#[cfg(target_os = "linux")]
	struct Holder(libc::pid_t);
	#[cfg(target_os = "linux")]
	impl Holder {
		fn read(dir: &std::path::Path) -> Self {
			Self(wait_for_file(&dir.join("holder")).trim().parse().unwrap())
		}
	}
	#[cfg(target_os = "linux")]
	impl Drop for Holder {
		fn drop(&mut self) {
			unsafe {
				libc::kill(self.0, libc::SIGKILL);
			}
			let deadline = Instant::now() + PROCESS_SHUTDOWN_GRACE;
			while unsafe { libc::kill(self.0, 0) } == 0 && Instant::now() < deadline {
				std::thread::sleep(PROCESS_POLL);
			}
		}
	}
	#[cfg(target_os = "linux")]
	fn unconfirmed_drain(group: libc::pid_t, code: &str) -> Vec<ResourceFailure> {
		vec![ResourceFailure {
			resource: format!("process-group:{group}").into(),
			code: code.into(),
			message: "Output reader drain was not confirmed".into(),
		}]
	}
	// #4338: a process outside the group that keeps the output open past the drain window no longer fails the
	// command: its result settles with its exit status and output, and cleanup confirms once the pipe closes.
	#[cfg(target_os = "linux")]
	#[test]
	fn escaped_output_holder_settles_the_result_ahead_of_cleanup_4338() {
		let (actor, owner) = command_owner();
		let dir = std::env::temp_dir().join(format!(
			"atomic-escaped-holder-{}-{}",
			std::process::id(),
			actor.id
		));
		std::fs::create_dir(&dir).unwrap();
		actor
			.start_command(
				&owner,
				pipe_intent(&escaped_holder(&dir, "printf done; exit 7")),
				"escaped".into(),
			)
			.unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		let holder = Holder::read(&dir);
		let group = command.process_group.load(Ordering::Acquire);
		let settled = settled_record(&actor, &owner);
		let spool_closed = command.output.lock().unwrap().file.is_none();
		let holding = unsafe { libc::kill(holder.0, 0) } == 0;
		actor.begin_close(&owner).unwrap();
		let closing = actor.close_receipt(&owner);
		std::fs::write(dir.join("release"), b"").unwrap();
		let finished = command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE);
		let confirmed = actor.snapshot(&owner).unwrap().tasks[0].clone();
		let closed = actor.close_receipt(&owner);
		actor.shutdown();
		drop(holder);
		std::fs::remove_dir_all(&dir).unwrap();
		match &settled.execution {
			Execution::Settled { result: TaskResult::Completed { exit_code, output } } => {
				assert_eq!(*exit_code, Some(7.0));
				assert_eq!(output.byte_count, JsString::from("4"));
			},
			other => panic!("the command did not complete: {other:?}"),
		}
		assert_eq!(std::fs::read(&command.output.lock().unwrap().path).unwrap(), b"done");
		assert!(spool_closed, "settled output must not hold its spool open during quarantine");
		assert!(holding, "the result must settle while the holder still holds the pipe");
		assert_eq!(
			settled.cleanup,
			Cleanup::Quarantined { resources: unconfirmed_drain(group, "CleanupUnconfirmed") }
		);
		assert!(
			closing.unwrap().is_none(),
			"quarantine keeps the owner closing, without a close failure"
		);
		assert!(finished, "cleanup was not confirmed after the holder released the pipe");
		assert_eq!(confirmed.cleanup, Cleanup::Reaped {});
		assert_eq!(confirmed.execution, settled.execution, "confirmation must not change the result");
		assert!(closed.unwrap().is_some());
		assert_group_gone(group);
		assert_eq!(*command.signals.lock().unwrap(), vec![(group, libc::SIGTERM)]);
	}
	/// Starts `escaped_holder` with `grace` as its quarantine bound; returns the command, the holder and the group.
	#[cfg(target_os = "linux")]
	fn start_escaped(
		actor: &Arc<Actor>,
		owner: &OwnerLease,
		dir: &std::path::Path,
		leader: &str,
		grace: Duration,
	) -> (TaskLease, Arc<CommandTask>, Holder, libc::pid_t) {
		std::fs::create_dir(dir).unwrap();
		TEST_QUARANTINE_GRACE.set(grace);
		let launched =
			actor.start_command(owner, pipe_intent(&escaped_holder(dir, leader)), "escaped".into());
		TEST_QUARANTINE_GRACE.set(PROCESS_QUARANTINE_GRACE);
		let task = launched.unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		let holder = Holder::read(dir);
		let group = command.process_group.load(Ordering::Acquire);
		(task, command, holder, group)
	}
	/// Whether the task's cleanup stays quarantined for all of `period`.
	#[cfg(target_os = "linux")]
	fn stays_quarantined(actor: &Actor, owner: &OwnerLease, period: Duration) -> bool {
		let until = Instant::now() + period;
		while Instant::now() < until {
			if !matches!(actor.snapshot(owner).unwrap().tasks[0].cleanup, Cleanup::Quarantined { .. })
			{
				return false;
			}
			std::thread::sleep(PROCESS_POLL);
		}
		true
	}
	// #4338: quarantine has no deadline while the owner is open, so cleanup confirmed long after the result settled is
	// still confirmed, and the owner then closes normally.
	#[cfg(target_os = "linux")]
	#[test]
	fn quarantine_outlasts_its_bound_while_the_owner_is_open_4338() {
		let (actor, owner) = command_owner();
		let dir = std::env::temp_dir().join(format!(
			"atomic-open-quarantine-{}-{}",
			std::process::id(),
			actor.id
		));
		let grace = Duration::from_secs(1);
		let (_task, command, holder, group) =
			start_escaped(&actor, &owner, &dir, "printf done; exit 7", grace);
		let settled = settled_record(&actor, &owner);
		let held = stays_quarantined(&actor, &owner, grace * 2);
		std::fs::write(dir.join("release"), b"").unwrap();
		let finished = command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE);
		let confirmed = actor.snapshot(&owner).unwrap().tasks[0].clone();
		actor.begin_close(&owner).unwrap();
		let closed = actor.close_receipt(&owner);
		actor.shutdown();
		drop(holder);
		std::fs::remove_dir_all(&dir).unwrap();
		assert!(held, "quarantine must not expire while the owner is open");
		assert!(finished, "cleanup was not confirmed after the holder released the pipe");
		assert_eq!(confirmed.cleanup, Cleanup::Reaped {});
		assert_eq!(confirmed.execution, settled.execution);
		assert!(closed.unwrap().is_some());
		assert_group_gone(group);
	}
	// #4338: a stopped holder that never releases the pipe keeps cleanup quarantined while the owner is open; closing
	// the owner gives it its bound, after which cleanup fails, the close reports it, and the result keeps its status.
	#[cfg(target_os = "linux")]
	#[test]
	fn unconfirmable_drain_fails_cleanup_once_closing_bounds_it_and_keeps_the_result_4338() {
		let (actor, owner) = command_owner();
		let dir = std::env::temp_dir().join(format!(
			"atomic-stopped-holder-{}-{}",
			std::process::id(),
			actor.id
		));
		let grace = Duration::from_secs(1);
		let (_task, command, holder, group) =
			start_escaped(&actor, &owner, &dir, "printf done; exit 7", grace);
		assert_eq!(unsafe { libc::kill(holder.0, libc::SIGSTOP) }, 0);
		let settled = settled_record(&actor, &owner);
		let held = stays_quarantined(&actor, &owner, grace * 2);
		actor.begin_close(&owner).unwrap();
		let finished = command.join_until(Instant::now() + grace + PROCESS_SHUTDOWN_GRACE);
		let failed = actor.snapshot(&owner).unwrap().tasks[0].clone();
		let closing = actor.close_receipt(&owner);
		let retained = command.retained.lock().unwrap().is_some();
		actor.shutdown();
		drop(holder);
		std::fs::remove_dir_all(&dir).unwrap();
		assert!(matches!(
			&settled.execution,
			Execution::Settled { result: TaskResult::Completed { exit_code: Some(7.0), .. } }
		));
		assert!(held, "quarantine must not expire while the owner is open");
		assert!(finished, "closing must bound the quarantine");
		assert_eq!(
			failed.execution, settled.execution,
			"failed cleanup must not replace the settled result"
		);
		assert_eq!(
			failed.cleanup,
			Cleanup::Failed { resources: unconfirmed_drain(group, "CleanupFailed") }
		);
		let error = closing.unwrap_err();
		assert_eq!(error.code, "CleanupFailed");
		assert!(error.message.contains(&format!("process-group:{group}")), "{error:?}");
		assert!(retained, "failed cleanup must keep the readers it could not drain");
		assert_group_gone(group);
	}
	// #4338: stopping a task bounds its quarantine too, without its owner closing.
	#[cfg(target_os = "linux")]
	#[test]
	fn stop_bounds_quarantine_without_an_owner_close_4338() {
		let (actor, owner) = command_owner();
		let dir = std::env::temp_dir().join(format!(
			"atomic-stop-bound-{}-{}",
			std::process::id(),
			actor.id
		));
		let grace = Duration::from_secs(1);
		let (task, command, holder, group) =
			start_escaped(&actor, &owner, &dir, "exec sleep 30", grace);
		assert_eq!(unsafe { libc::kill(holder.0, libc::SIGSTOP) }, 0);
		actor.cancel(&task, CancelCause::User).unwrap();
		let settled = settled_record(&actor, &owner);
		let finished = command.join_until(Instant::now() + grace + PROCESS_SHUTDOWN_GRACE);
		let failed = actor.snapshot(&owner).unwrap().tasks[0].clone();
		let state = actor.snapshot(&owner).unwrap().state;
		actor.shutdown();
		drop(holder);
		std::fs::remove_dir_all(&dir).unwrap();
		assert_eq!(
			settled.cleanup,
			Cleanup::Quarantined { resources: unconfirmed_drain(group, "CleanupUnconfirmed") }
		);
		assert!(finished, "the stop must bound the quarantine");
		assert_eq!(state, "open");
		assert_eq!(failed.execution, settled.execution);
		assert_eq!(
			failed.cleanup,
			Cleanup::Failed { resources: unconfirmed_drain(group, "CleanupFailed") }
		);
		assert_group_gone(group);
	}
	// #4338: once a quarantined command has seen its group gone, it never probes or signals that group number again,
	// so a group that later gets the number is neither killed nor mistaken for the command's own.
	#[cfg(target_os = "linux")]
	#[test]
	fn quarantine_never_signals_a_reused_group_number_4338() {
		for reuse in [-1, libc::EPERM] {
			let (actor, owner) = command_owner();
			let dir = std::env::temp_dir().join(format!(
				"atomic-reused-group-{}-{}",
				std::process::id(),
				actor.id
			));
			TEST_GROUP_BY_NUMBER.set(true);
			let (_task, command, holder, group) =
				start_escaped(&actor, &owner, &dir, "printf done; exit 7", PROCESS_QUARANTINE_GRACE);
			TEST_GROUP_BY_NUMBER.set(false);
			let settled = settled_record(&actor, &owner);
			command.reused_group.store(reuse, Ordering::Release);
			let seen = command.loop_iterations.load(Ordering::Acquire);
			let deadline = Instant::now() + PROCESS_SHUTDOWN_GRACE;
			while command.loop_iterations.load(Ordering::Acquire) < seen + 3 {
				assert!(Instant::now() < deadline, "the quarantine stopped looping");
				std::thread::sleep(PROCESS_POLL);
			}
			std::fs::write(dir.join("release"), b"").unwrap();
			let finished = command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE);
			let confirmed = actor.snapshot(&owner).unwrap().tasks[0].clone();
			actor.begin_close(&owner).unwrap();
			let closed = actor.close_receipt(&owner);
			actor.shutdown();
			drop(holder);
			std::fs::remove_dir_all(&dir).unwrap();
			assert_eq!(
				*command.signals.lock().unwrap(),
				vec![(group, libc::SIGTERM)],
				"reuse {reuse}"
			);
			assert!(finished, "reuse {reuse}: cleanup was not confirmed");
			assert_eq!(confirmed.cleanup, Cleanup::Reaped {}, "reuse {reuse}");
			assert_eq!(confirmed.execution, settled.execution, "reuse {reuse}");
			assert!(closed.unwrap().is_some(), "reuse {reuse}");
			assert_group_gone(group);
		}
	}
	// #4338: output written after the result settled ahead of cleanup is drained, never added to the settled output.
	#[cfg(target_os = "linux")]
	#[test]
	fn output_after_an_early_settlement_is_discarded_4338() {
		let (actor, owner) = command_owner();
		let dir = std::env::temp_dir().join(format!(
			"atomic-late-output-{}-{}",
			std::process::id(),
			actor.id
		));
		std::fs::create_dir(&dir).unwrap();
		let holder_script = "echo $$ > \"$1\"; while [ ! -e \"$2\" ]; do sleep 0.01; done; printf late; echo > \"$3\"; while [ ! -e \"$4\" ]; do sleep 0.01; done";
		actor
			.start_command(
				&owner,
				pipe_intent(&format!(
					"setsid /bin/sh -c '{holder_script}' sh '{0}/holder' '{0}/write' '{0}/written' '{0}/release' & while [ ! -s '{0}/holder' ]; do sleep 0.01; done; printf done",
					dir.display()
				)),
				"late".into(),
			)
			.unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		let holder = Holder::read(&dir);
		let settled = settled_record(&actor, &owner);
		std::fs::write(dir.join("write"), b"").unwrap();
		wait_for_file(&dir.join("written"));
		std::fs::write(dir.join("release"), b"").unwrap();
		let finished = command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE);
		let confirmed = actor.snapshot(&owner).unwrap().tasks[0].clone();
		let spool = std::fs::read(&command.output.lock().unwrap().path).unwrap();
		actor.shutdown();
		drop(holder);
		std::fs::remove_dir_all(&dir).unwrap();
		assert!(finished);
		assert_eq!(confirmed.cleanup, Cleanup::Reaped {});
		assert_eq!(confirmed.execution, settled.execution);
		assert!(matches!(
			&settled.execution,
			Execution::Settled { result: TaskResult::Completed { output, .. } } if output.byte_count == JsString::from("4")
		));
		assert_eq!(spool, b"done", "output written after the result settled must not be kept");
	}
	// #4338: a member that outlives the TERM grace and dies at KILL is confirmed within the drain window, so its
	// command never quarantines.
	#[cfg(target_os = "linux")]
	#[test]
	fn straggler_killed_at_the_grace_never_quarantines_4338() {
		let (actor, owner) = command_owner();
		let path = std::env::temp_dir().join(format!(
			"atomic-no-quarantine-{}-{}",
			std::process::id(),
			actor.id
		));
		let (subscription, _) = actor.watch(&owner, None).unwrap();
		actor
			.start_command(
				&owner,
				pipe_intent(&leave_member(&path, "trap \"\" TERM HUP; ")),
				"straggler".into(),
			)
			.unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		let finished = command.join_until(
			Instant::now() + PROCESS_TERM_GRACE + PROCESS_DRAIN_GRACE + PROCESS_SHUTDOWN_GRACE,
		);
		let events = actor.drain(&subscription).unwrap().events;
		let straggler: libc::pid_t = wait_for_file(&path).trim().parse().unwrap();
		std::fs::remove_file(&path).unwrap();
		actor.shutdown();
		assert!(finished);
		let cleanups: Vec<_> = events
			.iter()
			.filter_map(|event| match &event.payload {
				TaskEvent::CleanupChanged { cleanup, .. } => Some(cleanup.clone()),
				_ => None,
			})
			.collect();
		assert_eq!(cleanups, vec![Cleanup::Draining {}, Cleanup::Reaped {}]);
		assert_gone(straggler, "straggler");
	}
	// #4338: a leader whose reap the host has not yet observed leaves the outcome unknown, so the command fails at the
	// drain window, as before, rather than settling a result it does not know.
	#[cfg(target_os = "linux")]
	#[test]
	fn unknown_outcome_at_the_drain_window_fails_as_before_4338() {
		let (actor, owner) = command_owner();
		actor.start_command(&owner, pipe_intent("exec sleep 0.05"), "unreaped".into()).unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		command.reap_delayed.store(true, Ordering::Release);
		let finished = command.join_until(
			Instant::now() + PROCESS_TERM_GRACE + PROCESS_DRAIN_GRACE + PROCESS_SHUTDOWN_GRACE,
		);
		let record = actor.snapshot(&owner).unwrap().tasks[0].clone();
		let group = command.process_group.load(Ordering::Acquire);
		actor.shutdown();
		poll_failed_processes();
		assert!(finished);
		assert_eq!(
			record.execution,
			Execution::Settled {
				result: TaskResult::Failed {
					code: "CleanupFailed".into(),
					message: "Process-group exit was not confirmed".into(),
					output: None,
					exit_code: None,
				}
			}
		);
		assert!(matches!(record.cleanup, Cleanup::Failed { .. }), "{:?}", record.cleanup);
		let deadline = Instant::now() + PROCESS_SHUTDOWN_GRACE;
		while unsafe { libc::kill(-group, 0) } == 0 {
			assert!(Instant::now() < deadline, "the retained leader was never reaped");
			poll_failed_processes();
			std::thread::sleep(PROCESS_POLL);
		}
		assert_group_gone(group);
	}
	// #4338: a stop whose leader the host has not yet reaped still settles as a stop at the drain window and then
	// confirms its cleanup once the reap is observed.
	#[cfg(target_os = "linux")]
	#[test]
	fn stop_with_an_unreaped_leader_quarantines_then_confirms_4338() {
		let (actor, owner) = command_owner();
		let task =
			actor.start_command(&owner, pipe_intent("exec sleep 30"), "unreaped-stop".into()).unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		let group = command.process_group.load(Ordering::Acquire);
		command.reap_delayed.store(true, Ordering::Release);
		actor.cancel(&task, CancelCause::User).unwrap();
		let settled = settled_record(&actor, &owner);
		command.reap_delayed.store(false, Ordering::Release);
		let finished = command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE);
		let confirmed = actor.snapshot(&owner).unwrap().tasks[0].clone();
		actor.shutdown();
		assert!(
			matches!(
				&settled.execution,
				Execution::Settled { result: TaskResult::Failed { code, message, exit_code: None, .. } }
					if code == &JsString::from("CleanupUnconfirmed")
						&& message.process_text() == format!("Stop requested (user); cleanup unconfirmed: process-group:{group}: Process-group exit was not confirmed")
			),
			"{:?}",
			settled.execution
		);
		assert_eq!(
			settled.cleanup,
			Cleanup::Quarantined {
				resources: vec![ResourceFailure {
					resource: format!("process-group:{group}").into(),
					code: "CleanupUnconfirmed".into(),
					message: "Process-group exit was not confirmed".into(),
				}]
			}
		);
		assert!(finished);
		assert_eq!(confirmed.cleanup, Cleanup::Reaped {});
		assert_eq!(confirmed.execution, settled.execution);
		assert_group_gone(group);
	}
	// #4338: a stop whose output is still held settles as cleanup unconfirmed at the drain window, as before, and its
	// cleanup is then confirmed in the background instead of failing for good.
	#[cfg(target_os = "linux")]
	#[test]
	fn stopped_command_with_held_output_confirms_cleanup_after_settling_4338() {
		let (actor, owner) = command_owner();
		let dir = std::env::temp_dir().join(format!(
			"atomic-stopped-escaped-{}-{}",
			std::process::id(),
			actor.id
		));
		std::fs::create_dir(&dir).unwrap();
		let task = actor
			.start_command(&owner, pipe_intent(&escaped_holder(&dir, "exec sleep 30")), "stop".into())
			.unwrap();
		let command = actor.state.lock().unwrap().owners[0].tasks[0].command.clone().unwrap();
		let holder = Holder::read(&dir);
		let group = command.process_group.load(Ordering::Acquire);
		actor.cancel(&task, CancelCause::User).unwrap();
		let settled = settled_record(&actor, &owner);
		std::fs::write(dir.join("release"), b"").unwrap();
		let finished = command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE);
		let confirmed = actor.snapshot(&owner).unwrap().tasks[0].clone();
		actor.shutdown();
		drop(holder);
		std::fs::remove_dir_all(&dir).unwrap();
		match &settled.execution {
			Execution::Settled { result: TaskResult::Failed { code, message, .. } } => {
				assert_eq!(code, &JsString::from("CleanupUnconfirmed"));
				assert_eq!(
					message.process_text(),
					format!(
						"Stop requested (user); cleanup unconfirmed: process-group:{group}: Output reader drain was not confirmed"
					)
				);
			},
			other => panic!("the stop did not settle as cleanup unconfirmed: {other:?}"),
		}
		assert_eq!(
			settled.cleanup,
			Cleanup::Quarantined { resources: unconfirmed_drain(group, "CleanupUnconfirmed") }
		);
		assert!(finished);
		assert_eq!(confirmed.cleanup, Cleanup::Reaped {});
		assert_eq!(confirmed.execution, settled.execution);
		assert_group_gone(group);
	}
	// #2884: terminal metadata is retention arithmetic, not a full-output read.
	#[test]
	fn terminal_retention_metadata_is_independent_of_output_size() {
		let path =
			std::env::temp_dir().join(format!("atomic-output-metadata-{}", std::process::id()));
		let mut store = OutputStore::new(path.clone(), 4, 6, 5);
		store.append(b"abcdefghijkl");
		let path = store.path.clone();
		assert_eq!(store.omitted_ranges(), store.page(0, 12).omitted_ranges);
		store.byte_count = TASK_DISK_BYTES + 100;
		store.disk_len = TASK_DISK_BYTES;
		assert_eq!(
			store.omitted_ranges(),
			vec![OutputOffsets::new(TASK_DISK_BYTES, TASK_DISK_BYTES + 98)]
		);
		drop(store);
		assert!(!path.exists(), "dropped output store kept its spool");
	}
	#[test]
	fn capped_prefix_and_rolling_tail_are_owned_pages() {
		let path = std::env::temp_dir().join(format!("atomic-output-{}", std::process::id()));
		let mut store = OutputStore::new(path.clone(), 4, 6, 5);
		store.append(b"abcdef");
		let path = store.path.clone();
		store.append(b"ghijkl");
		let page = store.page(0, 12);
		assert_eq!(
			page.chunks.iter().map(|c| c.bytes.as_ref()).collect::<Vec<&[u8]>>(),
			vec![b"abcde".as_slice(), b"kl".as_slice()]
		);
		assert_eq!(page.omitted_ranges, vec![OutputOffsets::new(5, 10)]);
		assert_eq!(store.byte_count, 12);
		store.append(b"mn");
		assert_eq!(page.chunks[1].bytes.as_ref(), b"kl");
		assert_eq!(store.page(0, 14).omitted_ranges, vec![OutputOffsets::new(5, 12)]);
		let missing = store.page(6, 3);
		assert!(missing.chunks.is_empty());
		assert_eq!(missing.omitted_ranges, vec![OutputOffsets::new(6, 9)]);
		assert_eq!(std::fs::metadata(&path).unwrap().len(), 5);
		assert!(store.head.len() + store.tail.len() <= 4);
		assert!(store.foreground.is_empty());
		assert!(store.page(3, 0).chunks.is_empty());
		drop(store);
		assert!(!path.exists(), "dropped output store kept its spool");
	}
	#[test]
	fn output_pages_clamp_large_requests_to_live_budget() {
		let path = std::env::temp_dir().join(format!("atomic-page-cap-{}", std::process::id()));
		let mut store = OutputStore::new(path.clone(), 4, 8, TASK_DISK_BYTES);
		store.append(&vec![b'x'; COMMAND_LIVE_BYTES + 1]);
		let path = store.path.clone();
		let page = store.page(0, u32::MAX as u64);
		assert_eq!(page.requested, OutputOffsets::new(0, COMMAND_LIVE_BYTES as u64));
		assert_eq!(page.next_offset, Some(COMMAND_LIVE_BYTES.to_string()));
		assert_eq!(
			page.chunks.iter().map(|chunk| chunk.bytes.len()).sum::<usize>(),
			COMMAND_LIVE_BYTES
		);
		assert_eq!(store.page(COMMAND_LIVE_BYTES as u64, u64::MAX).chunks[0].bytes.as_ref(), b"x");
		drop(store);
		assert!(!path.exists(), "dropped output store kept its spool");
	}

	#[test]
	fn foreground_prefix_flushes_once_and_reads_do_not_move_append_offset() {
		let path =
			std::env::temp_dir().join(format!("atomic-output-background-{}", std::process::id()));
		let mut store = OutputStore::new(path.clone(), 4, 8, 20);
		store.append(b"abcdefg");
		assert!(!path.exists());
		assert_eq!(store.page(2, 3).chunks[0].bytes.as_ref(), b"cde");
		assert_eq!(store.page(2, 3).next_offset.as_deref(), Some("5"));
		store.background();
		let path = store.path.clone();
		store.background();
		assert_eq!(store.path, path);
		assert_eq!(std::fs::read(&path).unwrap(), b"abcdefg");
		assert!(store.foreground.is_empty());
		assert_eq!(store.page(1, 2).chunks[0].bytes.as_ref(), b"bc");
		store.append(b"hi");
		assert_eq!(std::fs::read(&path).unwrap(), b"abcdefghi");
		assert_eq!(store.page(99, 0).requested, OutputOffsets::new(99, 99));
		drop(store);
		assert!(!path.exists(), "dropped output store kept its spool");
	}

	#[test]
	fn disk_failure_keeps_draining_without_retry_or_losing_offsets() {
		let path = std::env::temp_dir()
			.join(format!("atomic-output-missing-{}", std::process::id()))
			.join("missing/output");
		let mut store = OutputStore::new(path, 4, 4, 5);
		store.append(b"abcdefghij");
		assert!(store.unavailable);
		assert!(!store.overflow);
		assert!(store.foreground.is_empty());
		store.append(b"kl");
		let page = store.page(1, 10);
		assert_eq!(page.chunks[0].offsets, OutputOffsets::new(1, 2));
		assert_eq!(page.chunks[0].bytes.as_ref(), b"b");
		assert_eq!(page.chunks[1].offsets, OutputOffsets::new(10, 11));
		assert_eq!(page.chunks[1].bytes.as_ref(), b"k");
		assert_eq!(page.omitted_ranges, vec![OutputOffsets::new(2, 10)]);
		assert_eq!(store.byte_count, 12);
	}

	#[test]
	fn raw_cap_and_chunk_boundaries_preserve_multibyte_decoding() {
		let path = std::env::temp_dir().join(format!("atomic-output-utf8-{}", std::process::id()));
		let mut store = OutputStore::new(path.clone(), 8, 2, 2);
		let mut decoder = Utf8Carry::default();
		store.append(b"a\xe2");
		let path = store.path.clone();
		assert_eq!(decoder.decode(b"a\xe2", false), "a");
		store.append(b"\x82");
		assert_eq!(decoder.decode(b"\x82", false), "");
		store.append(b"\xac!");
		assert_eq!(decoder.decode(b"\xac!", false), "€!");
		assert_eq!(std::fs::read(&path).unwrap(), b"a\xe2");
		let page = store.page(0, 5);
		assert!(page.omitted_ranges.is_empty());
		let mut decoder = Utf8Carry::default();
		let text: String =
			page.chunks.iter().map(|chunk| decoder.decode(&chunk.bytes, false)).collect();
		assert_eq!(text, "a€!");
		assert_eq!(decoder.decode(b"\xf0\x9f", false), "");
		assert_eq!(decoder.decode(b"", true), "�");
		drop(store);
		assert!(!path.exists(), "dropped output store kept its spool");
	}

	#[test]
	fn file_spool_policy_uses_real_cap_without_a_large_file() {
		assert_eq!(COMMAND_LIVE_BYTES, 1_048_576);
		assert_eq!(FOREGROUND_SPILL_BYTES, 8_388_608);
		assert_eq!(TASK_DISK_BYTES, 5_368_709_120);
		assert_eq!(DETAIL_TAIL_BYTES, 8_192);
		let path = std::env::temp_dir().join(format!("atomic-exact-cap-{}", std::process::id()));
		let mut store = OutputStore::new(path.clone(), 4, 8, 5);
		store.append(b"abcde");
		store.background();
		let path = store.path.clone();
		assert!(!store.overflow);
		store.append(b"f");
		assert!(store.overflow);
		assert_eq!(std::fs::metadata(&path).unwrap().len(), 5);
		drop(store);
		assert!(!path.exists(), "dropped output store kept its spool");
	}

	#[test]
	fn released_spool_closes_its_descriptor_and_still_pages_output_3313() {
		let path =
			std::env::temp_dir().join(format!("atomic-output-released-{}", std::process::id()));
		let mut store = OutputStore::new(path, 4, 8, 20);
		store.background();
		store.append(b"abcdef");
		let path = store.path.clone();
		store.release_file();
		assert!(store.file.is_none(), "settled spool kept an open descriptor");
		assert_eq!(store.page(1, 4).chunks[0].bytes.as_ref(), b"bcde");
		assert!(store.file.is_none(), "reading settled output reopened a retained descriptor");
		assert!(!store.unavailable);
		drop(store);
		assert!(!path.exists(), "dropped output store kept its spool");
	}

	#[test]
	fn released_empty_spool_is_removed_3313() {
		let path = std::env::temp_dir().join(format!("atomic-output-empty-{}", std::process::id()));
		let mut store = OutputStore::new(path, 4, 8, 20);
		store.background();
		let path = store.path.clone();
		assert!(path.exists());
		store.release_file();
		assert!(!path.exists(), "empty settled spool was kept on disk");
		assert!(store.page(0, 4).chunks.is_empty());
	}

	/// What a page reads, as its chunks' bytes and its omitted ranges.
	fn read_back(
		store: &mut OutputStore,
		start: u64,
		maximum: u64,
	) -> (Vec<u8>, Vec<(String, String)>) {
		let page = store.page(start, maximum);
		let bytes = page.chunks.iter().flat_map(|chunk| chunk.bytes.iter().copied()).collect();
		let omitted =
			page.omitted_ranges.iter().map(|range| (range.start.clone(), range.end.clone())).collect();
		(bytes, omitted)
	}
	fn holds_memory(store: &OutputStore) -> bool {
		store.head.capacity() + store.tail.capacity() + store.foreground.capacity() > 0
	}

	// #4215: a settled command whose spool holds every byte keeps no in-memory copy, and reads back the same bytes.
	#[test]
	fn settled_whole_spool_frees_memory_and_reads_the_same_4215() {
		let path = std::env::temp_dir().join(format!("atomic-output-whole-{}", std::process::id()));
		let mut store = OutputStore::new(path, 8, 16, 1_000);
		store.background();
		store.append(b"abcdefghijklmnopqrstuvwxyz");
		let before = read_back(&mut store, 0, 64);
		assert!(holds_memory(&store));
		store.settle();
		assert!(!holds_memory(&store), "a settled whole spool kept its in-memory copies");
		assert_eq!(read_back(&mut store, 0, 64), before);
		assert_eq!(before.0, b"abcdefghijklmnopqrstuvwxyz");
		assert_eq!(read_back(&mut store, 20, 3).0, b"uvw");
	}

	// #4215: memory is the only copy of the end of a spool that overflowed its cap, and of a spool that failed to write;
	// settling keeps it.
	#[test]
	fn settled_partial_spool_keeps_its_memory_4215() {
		let path = std::env::temp_dir().join(format!("atomic-output-capped-{}", std::process::id()));
		let mut capped = OutputStore::new(path, 4, 8, 5);
		capped.background();
		capped.append(b"abcdefghij");
		assert!(capped.overflow);
		let before = read_back(&mut capped, 0, 64);
		capped.settle();
		assert!(holds_memory(&capped), "an overflowed spool dropped the only copy of its end");
		assert_eq!(read_back(&mut capped, 0, 64), before);
		let path = std::env::temp_dir().join(format!("atomic-output-failed-{}", std::process::id()));
		let mut failed = OutputStore::new(path, 4, 8, 1_000);
		failed.background();
		failed.unavailable = true;
		failed.append(b"abcdefghij");
		failed.settle();
		assert!(holds_memory(&failed), "a failed spool dropped the only copy of its output");
	}

	// #4215: an output that never spilled (a foreground terminal command) keeps its memory when it settles, and a
	// closed owner's command frees it: what only memory held then reads as omitted.
	#[test]
	fn unspilled_output_is_kept_until_released_4215() {
		let path =
			std::env::temp_dir().join(format!("atomic-output-unspilled-{}", std::process::id()));
		let mut store = OutputStore::new(path.clone(), 8, 16, 1_000);
		store.append(b"terminal");
		store.settle();
		assert!(holds_memory(&store));
		assert_eq!(read_back(&mut store, 0, 64).0, b"terminal");
		store.release_memory();
		assert!(!holds_memory(&store));
		assert_eq!(
			read_back(&mut store, 0, 64),
			(Vec::new(), vec![("0".to_string(), "8".to_string())])
		);
		assert!(!path.exists());
	}

	#[test]
	fn store_never_removes_a_spool_it_did_not_create() {
		let path = std::env::temp_dir().join(format!("atomic-output-foreign-{}", std::process::id()));
		std::fs::write(&path, b"someone else's").unwrap();
		let store = OutputStore::new(path.clone(), 4, 8, 20);
		drop(store);
		let kept = path.exists();
		std::fs::remove_file(&path).unwrap();
		assert!(kept, "store removed a file it never created");
	}

	// #3313: every settled pipe command held its spool descriptor until the process exited.
	#[cfg(unix)]
	#[test]
	fn settled_commands_release_their_spool_descriptors_3313() {
		let (actor, owner) = command_owner();
		for index in 0..3 {
			let command = if index == 0 { "printf kept" } else { "true" };
			actor
				.start_command(&owner, pipe_intent(command), format!("settle-{index}").into())
				.unwrap();
		}
		let commands: Vec<_> = actor.state.lock().unwrap().owners[0]
			.tasks
			.iter()
			.map(|task| task.command.clone().unwrap())
			.collect();
		for command in &commands {
			assert!(command.join_until(Instant::now() + PROCESS_SHUTDOWN_GRACE));
		}
		actor.shutdown();
		let open =
			commands.iter().filter(|command| command.output.lock().unwrap().file.is_some()).count();
		let paths: Vec<_> =
			commands.iter().map(|command| command.output.lock().unwrap().path.clone()).collect();
		let kept_output = std::fs::read(&paths[0]).ok();
		let empty_kept = paths[1..].iter().filter(|path| path.exists()).count();
		let page = commands[0].output.lock().unwrap().page(0, 16);
		let _ = std::fs::remove_file(&paths[0]);
		assert_eq!(open, 0, "settled commands kept spool descriptors");
		assert_eq!(kept_output.as_deref(), Some(b"kept".as_slice()));
		assert_eq!(page.chunks[0].bytes.as_ref(), b"kept");
		assert_eq!(empty_kept, 0, "empty spools of settled commands stayed on disk");
	}

	#[cfg(unix)]
	#[test]
	fn spawn_ebadf_past_open_max_names_the_cause_3313() {
		let ebadf = || io::Error::from_raw_os_error(libc::EBADF);
		let explained = open_max_spawn_error(&ebadf(), 10_236, 10_240).unwrap().to_string();
		assert!(explained.contains("10240 (OPEN_MAX)"), "{explained}");
		assert!(explained.contains("lowest free descriptor in this process is 10236"), "{explained}");
		assert!(open_max_spawn_error(&ebadf(), 20, 10_240).is_none());
		let other = io::Error::from_raw_os_error(libc::ENOENT);
		assert!(open_max_spawn_error(&other, 10_236, 10_240).is_none());
	}
}
