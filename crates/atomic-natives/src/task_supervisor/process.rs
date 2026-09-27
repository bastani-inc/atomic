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
	#[cfg(all(test, unix))]
	kill_error: std::sync::atomic::AtomicI32,
	#[cfg(all(test, unix))]
	signals: Mutex<Vec<(libc::pid_t, libc::c_int)>>,
}
impl CommandTask {
	fn file_spool(&self) -> bool {
		matches!(self.intent.terminal, CommandTerminal::Pipe {})
			&& self.options.sink != Some(CommandOutputSink::Drained)
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
	fn signal_group(&self, pid: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
		#[cfg(test)]
		self.signals.lock().unwrap().push((pid, signal));
		#[cfg(test)]
		if signal == libc::SIGKILL && self.kill_error.load(Ordering::Acquire) != 0 {
			return Err(io::Error::from_raw_os_error(self.kill_error.load(Ordering::Acquire)));
		}
		if unsafe { libc::kill(-pid, signal) } == 0 {
			return Ok(());
		}
		let error = io::Error::last_os_error();
		// Darwin reports EPERM when a group contains only an unreaped zombie.
		// Defer that refusal only while we still own the exited leader. Cleanup
		// must subsequently reap it and independently confirm the group is gone;
		// this does not treat a signal refusal as evidence of successful cleanup.
		#[cfg(target_os = "macos")]
		if error.raw_os_error() == Some(libc::EPERM) && child_exited_without_reaping(pid)? {
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
		let ti = state.owners[oi].tasks.len();
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
			#[cfg(all(test, unix))]
			kill_error: std::sync::atomic::AtomicI32::new(0),
			#[cfg(all(test, unix))]
			signals: Mutex::new(Vec::new()),
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
		loop {
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
				for result in [
					drain_pipe(&mut stdout, command, &mut stdout_eof),
					drain_pipe(&mut stderr, command, &mut stderr_eof),
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
			let cancelling = {
				let state = self.state.lock().unwrap();
				state.owners[runner.cap.owner].tasks[runner.cap.task.unwrap()].cancel_cause.is_some()
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
				if let Err(error) = command.signal_group(pid, signal) {
					cleanup_failure = Some(error.to_string());
				}
				stopping = Some(Instant::now());
			}
			if let Some(stop) = stopping {
				if !killed && stop.elapsed() >= PROCESS_TERM_GRACE {
					// The direct child has not been reaped: its PID, and therefore our PGID, cannot be reused.
					// A successful escalation can resolve an earlier TERM refusal;
					// reaping and group disappearance must still be confirmed below.
					cleanup_failure =
						command.signal_group(pid, libc::SIGKILL).err().map(|error| error.to_string());
					killed = true;
				}
				if killed {
					if cleanup_failure.is_some() {
						break;
					}
					// No more signals are permitted after this point. Reap the leader,
					// then confirm the entire group disappeared, independently of EOF.
					if status.is_none() {
						match child.try_wait() {
							Ok(value) => status = value,
							Err(error) => {
								cleanup_failure = Some(error.to_string());
								break;
							},
						}
					}
					if status.is_some() {
						match process_group_gone(pid) {
							Ok(true) if (stdout_eof && stderr_eof) || setup_failure.is_some() => break,
							Ok(_) => {},
							Err(error) => {
								// Darwin also returns EPERM for zombie-only groups after the
								// leader is reaped. Other parents may still be reaping members.
								// Retry only this read-only probe within the existing bound:
								// ESRCH is still required, and persistent refusal stays a failure.
								#[cfg(target_os = "macos")]
								if error.raw_os_error() == Some(libc::EPERM)
									&& stop.elapsed() < PROCESS_TERM_GRACE + PROCESS_DRAIN_GRACE
								{
									std::thread::sleep(PROCESS_POLL);
									continue;
								}
								cleanup_failure = Some(error.to_string());
								break;
							},
						}
					}
				}
				if stop.elapsed() >= PROCESS_TERM_GRACE + PROCESS_DRAIN_GRACE {
					cleanup_failure =
						Some("Process-group exit or reader drain was not confirmed".into());
					break;
				}
			}
			std::thread::sleep(PROCESS_POLL);
		}
		command.input.lock().unwrap().close();
		if let Some(message) = cleanup_failure {
			command.retain_failed(runner.cap.reference(), child, (stdout, stderr), message.clone());
			let _ = self.runner_outcome(
				runner,
				TaskResult::Failed {
					code: "CleanupFailed".into(),
					message: message.clone().into(),
					output: None,
					exit_code: None,
				},
			);
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
		let status = status.expect("group confirmed only after direct child reaped");
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
		let result = if let Some(message) = read_failure {
			TaskResult::Failed {
				code: if setup_failure.is_some() { "SpawnFailed" } else { "OutputUnavailable" }.into(),
				message: message.into(),
				output: Some(output),
				exit_code: status.code().map(f64::from),
			}
		} else {
			TaskResult::Completed { output, exit_code: status.code().map(f64::from) }
		};
		let _ = self.runner_outcome(runner, result);
		let _ = self.acknowledge_cleanup(runner, Cleanup::Reaped {});
		if let Some(message) = setup_failure {
			command.setup_result(Err(TaskFailure { code: "SpawnFailed".into(), message }));
		}
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
			Ok(count) => command.output.lock().unwrap().append(&buffer[..count]),
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
	Ok(unsafe { info.si_pid() } != 0)
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

/// Registers an output writer thread that can outlive the command worker, such as
/// the ConPTY reader. The spool stays open until every such writer has stopped.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) struct DetachedOutputWriter(Arc<CommandTask>);
#[cfg_attr(not(windows), allow(dead_code))]
impl DetachedOutputWriter {
	pub(super) fn register(command: &Arc<CommandTask>) -> Self {
		command.output.lock().unwrap().detached_writers += 1;
		Self(command.clone())
	}
	pub(super) fn command(&self) -> &CommandTask {
		&self.0
	}
}
impl Drop for DetachedOutputWriter {
	fn drop(&mut self) {
		self
			.0
			.output
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
			.detached_writer_stopped();
	}
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
	settled: bool,
	detached_writers: usize,
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
			settled: false,
			detached_writers: 0,
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
	/// The command worker has settled. The spool closes once no detached writer can still append.
	fn settle(&mut self) {
		self.settled = true;
		if self.detached_writers == 0 {
			self.release_file();
		}
	}
	fn detached_writer_stopped(&mut self) {
		self.detached_writers -= 1;
		if self.settled && self.detached_writers == 0 {
			self.release_file();
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
		assert_eq!(
			*command.signals.lock().unwrap(),
			vec![(pid, libc::SIGTERM), (pid, libc::SIGKILL)]
		);
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

	#[test]
	fn settled_spool_stays_open_until_detached_writers_stop_3313() {
		let path =
			std::env::temp_dir().join(format!("atomic-output-late-writer-{}", std::process::id()));
		let mut store = OutputStore::new(path, 4, 8, 20);
		store.background();
		store.append(b"abc");
		store.detached_writers += 1;
		store.settle();
		assert!(store.file.is_some(), "spool closed while a detached writer could still append");
		store.append(b"def");
		store.detached_writer_stopped();
		assert!(store.file.is_none(), "spool stayed open after its last writer stopped");
		let path = store.path.clone();
		assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
		assert_eq!(store.page(0, 6).chunks[0].bytes.as_ref(), b"abcdef");
		drop(store);
		assert!(!path.exists(), "dropped output store kept its spool");
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
