//! Suspended Windows launch and kill-on-close job ownership. No breakaway flags.
use super::windows_pty::PseudoConsole;
use super::*;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
	Foundation::{
		ERROR_BROKEN_PIPE, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
		WAIT_OBJECT_0,
	},
	Security::SECURITY_ATTRIBUTES,
	System::{
		JobObjects::{
			AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT,
			JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
			JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
			JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
			TerminateJobObject,
		},
		Pipes::{CreatePipe, PeekNamedPipe},
		Threading::{
			CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
			DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
			InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
			PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, ResumeThread,
			STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
			WaitForSingleObject,
		},
	},
};

pub(super) struct ContainmentJob(OwnedHandle);
impl ContainmentJob {
	pub(super) fn create() -> io::Result<Self> {
		let job = unsafe { CreateJobObjectW(null(), null()) };
		if job.is_null() {
			return Err(io::Error::last_os_error());
		}
		let job = Self(unsafe { OwnedHandle::from_raw_handle(job) });
		job.limit(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)?;
		Ok(job)
	}
	fn limit(&self, flags: JOB_OBJECT_LIMIT) -> io::Result<()> {
		let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
		limits.BasicLimitInformation.LimitFlags = flags;
		if unsafe {
			SetInformationJobObject(
				raw(&self.0),
				JobObjectExtendedLimitInformation,
				(&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
				std::mem::size_of_val(&limits) as u32,
			)
		} == 0
		{
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}
	pub(super) fn release(self) -> io::Result<()> {
		self.limit(0)
	}
	pub(super) fn assign(&self, process: HANDLE) -> io::Result<()> {
		if unsafe { AssignProcessToJobObject(raw(&self.0), process) } == 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(())
		}
	}
	pub(super) fn active(&self) -> io::Result<u32> {
		let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
		if unsafe {
			QueryInformationJobObject(
				raw(&self.0),
				JobObjectBasicAccountingInformation,
				(&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
				std::mem::size_of_val(&info) as u32,
				null_mut(),
			)
		} == 0
		{
			return Err(io::Error::last_os_error());
		}
		Ok(info.ActiveProcesses)
	}
	pub(super) fn terminate(&self) -> io::Result<()> {
		if unsafe { TerminateJobObject(raw(&self.0), 1) } == 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(())
		}
	}
}
pub(super) struct WindowsProcess {
	process: OwnedHandle,
	job: ContainmentJob,
	pty: Option<PseudoConsole>,
}
struct LaunchFailure {
	error: TaskFailure,
	cleanup: Cleanup,
}
impl From<TaskFailure> for LaunchFailure {
	fn from(error: TaskFailure) -> Self {
		Self { error, cleanup: Cleanup::Reaped {} }
	}
}
type PreparedHandles =
	(ContainmentJob, Option<(File, File, File)>, File, ProcessReader, ProcessReader);
struct WindowsLaunch {
	resource: WindowsProcess,
	stdin: File,
	stdout: ProcessReader,
	stderr: ProcessReader,
}
pub(super) fn raw(handle: &impl AsRawHandle) -> HANDLE {
	handle.as_raw_handle()
}
/// How long a writer that missed the grace still has to report its stop. A host that stalls every thread at once (a
/// paused virtual machine, a starved scheduler) can let the whole grace pass before the writer ran at all; once it
/// runs it reports within a few of its polls, while a writer that is really stuck never does.
const STDIN_WRITER_LATE_REPORT: Duration = Duration::from_millis(100);
#[derive(Default)]
struct StdinWriterStop {
	requested: AtomicBool,
	// Held only across delivery of nonempty bytes, not an idle poll or queue cleanup.
	writes_closed: Mutex<bool>,
}
impl StdinWriterStop {
	fn deliver(&self, write: impl FnOnce() -> io::Result<usize>) -> io::Result<usize> {
		let closed = self.writes_closed.lock().unwrap();
		if *closed {
			return Err(io::ErrorKind::BrokenPipe.into());
		}
		write()
	}
	fn close_input_between_writes(&self, input: &Mutex<InputQueue>) -> bool {
		match input.try_lock() {
			Ok(mut queue) => {
				queue.close();
				true
			},
			// With the queue busy, fence future deliveries without waiting for its holder to run.
			Err(std::sync::TryLockError::WouldBlock) => {
				self.writes_closed.try_lock().map(|mut closed| *closed = true).is_ok()
			},
			Err(std::sync::TryLockError::Poisoned(_)) => false,
		}
	}
}
/// Stops the stdin writer and confirms it. `job_ended` says the command's job has exited with no process left in it: the
/// pipe the writer feeds then has no reader, so a writer that the host has not yet scheduled can no longer deliver input
/// to anything of the command, and it is left to end on its own instead of failing a command that ran to completion.
/// A writer of a job that still has processes, such as a command that keeps its background processes on exit, is
/// confirmed the same way when it is not in a write (see `close_input_between_writes`).
fn finish_stdin_writer(
	stop_input: &StdinWriterStop,
	writer: std::thread::JoinHandle<()>,
	writer_done: &std::sync::mpsc::Receiver<()>,
	input: &Mutex<InputQueue>,
	timeout: Duration,
	late_report: Duration,
	job_ended: bool,
) -> (Option<std::thread::JoinHandle<()>>, Option<String>) {
	let deadline = Instant::now() + timeout;
	stop_input.requested.store(true, Ordering::Release);
	writer.thread().unpark();
	// The writer reports its stop only after it closed the input and dropped the stdin handle, so from then on it
	// holds nothing of the command and is left to end on its own: its thread's end is no cleanup of the command, and
	// a command that ran to completion failed when that end came after the grace (#5202).
	if writer_done.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_ok() {
		return (None, None);
	}
	while !writer.is_finished() && Instant::now() < deadline {
		std::thread::yield_now();
	}
	let mut writer = Some(writer);
	if writer.as_ref().unwrap().is_finished() {
		let failure =
			writer.take().unwrap().join().err().map(|_| "Windows stdin worker panicked".into());
		(None, failure)
	} else if writer_done.recv_timeout(late_report).is_ok()
		|| job_ended
		|| stop_input.close_input_between_writes(input)
	{
		(None, None)
	} else {
		(writer, Some("Windows stdin worker stop was not confirmed".into()))
	}
}
struct RetainedWindows {
	resource: WindowsProcess,
	writer: Option<std::thread::JoinHandle<()>>,
}
static FAILED_WINDOWS: Mutex<Vec<RetainedWindows>> = Mutex::new(Vec::new());
pub(super) fn poll_failed_windows() {
	super::windows_pty::poll_failed_consoles();
	FAILED_WINDOWS.lock().unwrap().retain_mut(|failed| {
		let _ = failed.resource.kill();
		if let Some(pty) = &mut failed.resource.pty {
			pty.begin_close();
		}
		if !failed.resource.exited().unwrap_or(false) {
			unsafe {
				TerminateProcess(raw(&failed.resource.process), 1);
			}
		}
		if failed.resource.exited().unwrap_or(false)
			&& matches!(failed.resource.active(), Ok(0))
			&& failed.writer.as_ref().is_none_or(std::thread::JoinHandle::is_finished)
			&& failed.resource.pty.as_mut().is_none_or(PseudoConsole::reaped)
		{
			if let Some(writer) = failed.writer.take() {
				let _ = writer.join();
			}
			false
		} else {
			true
		}
	});
}
pub(super) fn pipe() -> io::Result<(File, File)> {
	let mut read = null_mut();
	let mut write = null_mut();
	let attributes = SECURITY_ATTRIBUTES {
		nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
		lpSecurityDescriptor: null_mut(),
		bInheritHandle: 0,
	};
	if unsafe { CreatePipe(&mut read, &mut write, &attributes, 65536) } == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) })
}
pub(super) struct PipeReader(pub(super) File);
impl Read for PipeReader {
	fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
		let mut available = 0;
		if unsafe {
			PeekNamedPipe(raw(&self.0), null_mut(), 0, null_mut(), &mut available, null_mut())
		} == 0
		{
			let error = io::Error::last_os_error();
			return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
				Ok(0)
			} else {
				Err(error)
			};
		}
		if available == 0 {
			return Err(io::ErrorKind::WouldBlock.into());
		}
		let count = bytes.len().min(available as usize);
		self.0.read(&mut bytes[..count])
	}
}
impl WindowsProcess {
	fn exited(&self) -> io::Result<bool> {
		let value = unsafe { WaitForSingleObject(raw(&self.process), 0) };
		if value == u32::MAX { Err(io::Error::last_os_error()) } else { Ok(value == WAIT_OBJECT_0) }
	}
	fn active(&self) -> io::Result<u32> {
		self.job.active()
	}
	fn kill(&self) -> io::Result<()> {
		self.job.terminate()
	}
	fn wait(&self, timeout: Duration) {
		let _ = unsafe { WaitForSingleObject(raw(&self.process), timeout.as_millis() as u32) };
	}
	fn disarm_kill_on_close(&self) -> io::Result<()> {
		self.job.limit(0)
	}
	fn exit_code(&self) -> io::Result<u32> {
		let mut code = 0;
		if unsafe { GetExitCodeProcess(raw(&self.process), &mut code) } == 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(code)
		}
	}
}
fn spawn(
	command: &Arc<CommandTask>,
	refuse_assignment: bool,
) -> Result<WindowsLaunch, LaunchFailure> {
	let mut pty = None;
	let result = spawn_inner(command, refuse_assignment, &mut pty);
	match result {
		Ok(mut launch) => {
			launch.resource.pty = pty;
			Ok(launch)
		},
		Err(mut failure) => {
			if let Some(console) = &mut pty
				&& (!console.close_until(Instant::now() + PROCESS_DRAIN_GRACE)
					|| console.failure().is_some())
			{
				failure.cleanup = Cleanup::Failed {
					resources: vec![ResourceFailure {
						resource: "conpty".into(),
						code: "CleanupFailed".into(),
						message: "ConPTY setup cleanup was not confirmed".into(),
					}],
				};
			}
			Err(failure)
		},
	}
}
fn spawn_inner(
	command: &Arc<CommandTask>,
	refuse_assignment: bool,
	pty: &mut Option<PseudoConsole>,
) -> Result<WindowsLaunch, LaunchFailure> {
	let super::windows_command::ProcessCommand { application, mut line, cwd, environment } =
		super::windows_command::prepare(&command.intent)
			.map_err(|error| TaskFailure { code: "SpawnFailed".into(), message: error.to_string() })?;
	if command.file_spool() {
		let mut store = command.output.lock().unwrap();
		store.background();
		if store.unavailable {
			return Err(
				TaskFailure {
					code: "SpawnFailed".into(),
					message: format!(
						"Output spool unavailable: {}",
						store.spool_error.as_deref().unwrap_or("write failed")
					),
				}
				.into(),
			);
		}
	}
	let mut prepare = || -> io::Result<PreparedHandles> {
		let job = ContainmentJob::create()?;
		if let CommandTerminal::Pty { columns, rows } = command.intent.terminal {
			let stdin = PseudoConsole::create(command, columns, rows, pty)?;
			return Ok((job, None, stdin, Box::new(io::empty()), Box::new(io::empty())));
		}
		let (stdin_read, stdin_write) = pipe()?;
		let (out_read, stdout) = pipe()?;
		let (err_read, stderr) = pipe()?;
		let stdout_read: ProcessReader = Box::new(PipeReader(out_read));
		let stderr_read: ProcessReader = Box::new(PipeReader(err_read));
		Ok((job, Some((stdin_read, stdout, stderr)), stdin_write, stdout_read, stderr_read))
	};
	let (job, child_handles, stdin_write, stdout_read, stderr_read) =
		prepare().map_err(|error| TaskFailure {
			code: "ContainmentUnavailable".into(),
			message: error.to_string(),
		})?;
	let inherited = child_handles
		.as_ref()
		.map(|(stdin, stdout, stderr)| [raw(stdin), raw(stdout), raw(stderr)])
		.unwrap_or([null_mut(); 3]);
	for handle in inherited.into_iter().filter(|handle| !handle.is_null()) {
		if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
			return Err(fail("ContainmentUnavailable").into());
		}
	}
	let mut attribute_size = 0;
	unsafe {
		InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
	}
	let mut attributes = vec![0usize; attribute_size.div_ceil(std::mem::size_of::<usize>())];
	let attribute_list = attributes.as_mut_ptr().cast();
	if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) } == 0 {
		return Err(fail("ContainmentUnavailable").into());
	}
	let attribute_result = unsafe {
		UpdateProcThreadAttribute(
			attribute_list,
			0,
			if pty.is_some() {
				PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
			} else {
				PROC_THREAD_ATTRIBUTE_HANDLE_LIST
			} as usize,
			pty.as_ref().map_or(inherited.as_ptr().cast(), |console| {
				console.handle() as *const std::ffi::c_void
			}),
			if pty.is_some() {
				std::mem::size_of::<isize>()
			} else {
				std::mem::size_of_val(&inherited)
			},
			null_mut(),
			null(),
		)
	};
	if attribute_result == 0 {
		unsafe {
			DeleteProcThreadAttributeList(attribute_list);
		}
		return Err(fail("ContainmentUnavailable").into());
	}
	let mut startup = STARTUPINFOEXW::default();
	startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
	if child_handles.is_some() {
		startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
		startup.StartupInfo.hStdInput = inherited[0];
		startup.StartupInfo.hStdOutput = inherited[1];
		startup.StartupInfo.hStdError = inherited[2];
	} else {
		// Redirected host stdio otherwise leaks into the child despite inherit=false.
		startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
		startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
		startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
		startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
	}
	startup.lpAttributeList = attribute_list;
	let mut info = PROCESS_INFORMATION::default();
	let created = unsafe {
		CreateProcessW(
			application.as_ptr(),
			line.as_mut_ptr(),
			null(),
			null(),
			i32::from(child_handles.is_some()),
			CREATE_SUSPENDED
				| CREATE_UNICODE_ENVIRONMENT
				| if pty.is_some() { 0 } else { CREATE_NO_WINDOW }
				| EXTENDED_STARTUPINFO_PRESENT,
			environment.as_ptr().cast(),
			cwd.as_ref().map_or(null(), |value| value.as_ptr()),
			&startup.StartupInfo,
			&mut info,
		)
	};
	let create_error = io::Error::last_os_error();
	unsafe {
		DeleteProcThreadAttributeList(attribute_list);
	}
	if created == 0 {
		return Err(
			TaskFailure { code: "SpawnFailed".into(), message: create_error.to_string() }.into(),
		);
	}
	let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
	let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread) };
	// No user instruction has executed yet. Assignment precedes ResumeThread.
	let assigned = !refuse_assignment && job.assign(raw(&process)).is_ok();
	if !assigned || unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
		let terminated = unsafe { TerminateProcess(raw(&process), 1) } != 0;
		let reaped =
			terminated && unsafe { WaitForSingleObject(raw(&process), 3000) } == WAIT_OBJECT_0;
		if reaped {
			return Err(fail("ContainmentUnavailable").into());
		}
		FAILED_WINDOWS.lock().unwrap().push(RetainedWindows {
			resource: WindowsProcess { process, job, pty: pty.take() },
			writer: None,
		});
		return Err(LaunchFailure {
			error: fail("ContainmentUnavailable"),
			cleanup: Cleanup::Failed {
				resources: vec![ResourceFailure {
					resource: "suspended-process".into(),
					code: "CleanupFailed".into(),
					message: "Suspended process termination was not confirmed".into(),
				}],
			},
		});
	}
	drop(thread);
	drop(child_handles);
	Ok(WindowsLaunch {
		resource: WindowsProcess { process, job, pty: None },
		stdin: stdin_write,
		stdout: stdout_read,
		stderr: stderr_read,
	})
}

impl Actor {
	pub(super) fn run_command_windows(&self, runner: &RunnerLease, command: &Arc<CommandTask>) {
		let launch = match spawn(command, false) {
			Ok(launch) => launch,
			Err(LaunchFailure { error, cleanup }) => {
				let _ = self.runner_outcome(
					runner,
					TaskResult::Failed {
						code: error.code.clone().into(),
						message: error.message.clone().into(),
						output: None,
						exit_code: None,
					},
				);
				let _ = self.acknowledge_cleanup(runner, cleanup);
				command.setup_result(Err(error));
				return;
			},
		};
		let WindowsLaunch { mut resource, stdin, mut stdout, mut stderr } = launch;
		let stop_input = Arc::new(StdinWriterStop::default());
		let stopped = stop_input.clone();
		let input_command = command.clone();
		let (writer_done_tx, writer_done_rx) = std::sync::mpsc::channel();
		let writer = std::thread::Builder::new().name("task-stdin".into()).spawn(move || {
			let writer_done = writer_done_tx;
			let mut stdin = Some(stdin);
			while !stopped.requested.load(Ordering::Acquire) {
				input_command
					.input
					.lock()
					.unwrap()
					.drain_with(&mut stdin, |pipe, bytes| stopped.deliver(|| pipe.write(bytes)));
				if !stopped.requested.load(Ordering::Acquire) {
					std::thread::park_timeout(PROCESS_POLL);
				}
			}
			input_command.input.lock().unwrap().close();
			drop(stdin);
			let _ = writer_done.send(());
		});
		let writer = match writer {
			Ok(writer) => writer,
			Err(error) => {
				let _ = resource.kill();
				if let Some(pty) = &mut resource.pty {
					pty.begin_close();
				}
				let deadline = Instant::now() + PROCESS_DRAIN_GRACE;
				while Instant::now() < deadline
					&& !(resource.exited().unwrap_or(false)
						&& matches!(resource.active(), Ok(0))
						&& resource.pty.as_mut().is_none_or(PseudoConsole::reaped))
				{
					std::thread::sleep(PROCESS_POLL);
				}
				let reaped = resource.exited().unwrap_or(false)
					&& matches!(resource.active(), Ok(0))
					&& resource.pty.as_mut().is_none_or(|pty| pty.reaped() && pty.failure().is_none());
				let message = error.to_string();
				drop(stdout);
				drop(stderr);
				command.input.lock().unwrap().close();
				let _ = self.runner_outcome(
					runner,
					TaskResult::Failed {
						code: "SpawnFailed".into(),
						message: message.clone().into(),
						output: None,
						exit_code: None,
					},
				);
				let cleanup = if reaped {
					drop(resource);
					Cleanup::Reaped {}
				} else {
					FAILED_WINDOWS.lock().unwrap().push(RetainedWindows { resource, writer: None });
					Cleanup::Failed {
						resources: vec![ResourceFailure {
							resource: "windows-job".into(),
							code: "CleanupFailed".into(),
							message: "Input setup failure cleanup was not confirmed".into(),
						}],
					}
				};
				let _ = self.acknowledge_cleanup(runner, cleanup);
				command.setup_result(Err(TaskFailure { code: "SpawnFailed".into(), message }));
				return;
			},
		};
		{
			let mut state = self.state.lock().unwrap();
			let (oi, ti) = state.runner(self.id, &runner.cap).unwrap();
			if matches!(state.owners[oi].tasks[ti].record.execution, Execution::Queued {}) {
				state.owners[oi].tasks[ti].record.execution = Execution::Running {};
				let reference = runner.cap.reference();
				state.emit(oi, Some(reference.task_id.clone()), TaskEvent::TaskStarted { reference });
			}
		}
		command.setup_result(Ok(()));
		let started = Instant::now();
		let mut stopping = None;
		let mut stdout_eof = false;
		let mut stderr_eof = false;
		let mut failure = None;
		let mut preserved_background = false;
		loop {
			if let Some(pty) = &mut resource.pty {
				if stopping.is_none()
					&& let Some((columns, rows)) = command.resize.lock().unwrap().take()
					&& let Err(error) = pty.resize(columns, rows)
				{
					failure = Some(error.to_string());
				}
				if let Some(error) = pty.failure() {
					failure = Some(error);
				}
			}
			for result in [
				drain_pipe(&mut stdout, command, &mut stdout_eof),
				drain_pipe(&mut stderr, command, &mut stderr_eof),
			] {
				if let Err(error) = result {
					failure = Some(error.to_string());
				}
			}
			if command.background.load(Ordering::Acquire) {
				command.output.lock().unwrap().background();
				if command.file_spool() && command.output.lock().unwrap().overflow {
					let _ =
						self.cancel(&TaskLease { cap: runner.cap.clone() }, CancelCause::OutputLimit);
				}
			}
			if command
				.intent
				.execution_timeout_ms
				.is_some_and(|budget| started.elapsed().as_secs_f64() * 1000.0 >= budget)
			{
				let _ =
					self.cancel(&TaskLease { cap: runner.cap.clone() }, CancelCause::ExecutionTimeout);
			}
			let cancelling = self.state.lock().unwrap().owners[runner.cap.owner].tasks
				[runner.cap.task.unwrap()]
			.cancel_cause
			.is_some();
			let exited = match resource.exited() {
				Ok(exited) => exited,
				Err(error) => {
					failure = Some(error.to_string());
					false
				},
			};
			if stopping.is_none()
				&& command.options.keep_background_on_exit == Some(true)
				&& exited
				&& !cancelling
				&& failure.is_none()
			{
				stop_input.requested.store(true, Ordering::Release);
				writer.thread().unpark();
				for _ in 0..16 {
					let before = command.output.lock().unwrap().byte_count;
					for result in [
						drain_pipe(&mut stdout, command, &mut stdout_eof),
						drain_pipe(&mut stderr, command, &mut stderr_eof),
					] {
						if let Err(error) = result {
							failure = Some(error.to_string());
						}
					}
					if failure.is_some()
						|| (stdout_eof && stderr_eof)
						|| command.output.lock().unwrap().byte_count == before
					{
						break;
					}
				}
				if failure.is_none() {
					if let Err(error) = resource.disarm_kill_on_close() {
						failure = Some(error.to_string());
					} else {
						preserved_background = true;
						break;
					}
				}
			}
			if stopping.is_none() && (cancelling || exited || failure.is_some()) {
				let _ = self.acknowledge_cleanup(runner, Cleanup::Draining {});
				if let Err(error) = resource.kill() {
					failure = Some(error.to_string());
				}
				stop_input.requested.store(true, Ordering::Release);
				writer.thread().unpark();
				if let Some(pty) = &mut resource.pty {
					pty.begin_close();
				}
				stopping = Some(Instant::now());
			}
			if let Some(stopped) = stopping {
				if !stdout_eof || !stderr_eof {
					for result in [
						drain_pipe(&mut stdout, command, &mut stdout_eof),
						drain_pipe(&mut stderr, command, &mut stderr_eof),
					] {
						if let Err(error) = result {
							failure = Some(error.to_string());
						}
					}
				}
				match resource.active() {
					Ok(0)
						if exited
							&& stdout_eof && stderr_eof
							&& resource.pty.as_mut().is_none_or(PseudoConsole::reaped) =>
					{
						break;
					},
					Ok(_) => {},
					Err(error) => {
						failure = Some(error.to_string());
					},
				}
				if stopped.elapsed() >= PROCESS_DRAIN_GRACE {
					failure = Some("Windows job exit or reader drain was not confirmed".into());
					break;
				}
			}
			if stopping.is_none() && !exited {
				resource.wait(PROCESS_POLL);
			} else {
				std::thread::sleep(PROCESS_POLL);
			}
		}
		if !preserved_background {
			let _ = resource.kill();
		}
		let job_ended = !preserved_background
			&& resource.exited().unwrap_or(false)
			&& matches!(resource.active(), Ok(0));
		let (writer, writer_failure) = finish_stdin_writer(
			&stop_input,
			writer,
			&writer_done_rx,
			&command.input,
			PROCESS_DRAIN_GRACE,
			STDIN_WRITER_LATE_REPORT,
			job_ended,
		);
		if let Some(error) = writer_failure {
			failure = Some(error);
		}
		// A reader can finish during the final reaped() probe; preserve its error too.
		if let Some(pty) = &mut resource.pty
			&& let Some(error) = pty.failure()
		{
			failure = Some(error);
		}
		if preserved_background && failure.is_none() {
			detach_background_output(stdout, stdout_eof, stderr, stderr_eof);
		} else {
			drop(stdout);
			drop(stderr);
		}
		if let Some(message) = failure {
			FAILED_WINDOWS.lock().unwrap().push(RetainedWindows { resource, writer });
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
						resource: "windows-job".into(),
						code: "CleanupFailed".into(),
						message: message.into(),
					}],
				},
			);
			return;
		}
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
		let exit_code = resource.exit_code().ok().map(f64::from);
		drop(resource);
		let _ = self.runner_outcome(runner, TaskResult::Completed { output, exit_code });
		let _ = self.acknowledge_cleanup(runner, Cleanup::Reaped {});
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	fn intent(command: &str) -> CommandIntent {
		CommandIntent {
			kind: CommandTaskKind::Command,
			command: command.into(),
			description: None,
			cwd: None,
			env: None,
			shell: None,
			inherit_env: None,
			terminal: CommandTerminal::Pipe {},
			execution_timeout_ms: None,
			parent_task_id: None,
		}
	}
	// RFC #2884: failed assignment must never run a single untrusted instruction.
	#[test]
	fn assignment_failure_reaps_suspended_command_without_side_effects() {
		let path = std::env::temp_dir().join(format!("atomic-job-refusal-{}", std::process::id()));
		let command = Arc::new(CommandTask {
			intent: intent(&format!("echo UNSUPERVISED > \"{}\"", path.display())),
			options: CommandResourceOptions {
				sink: Some(CommandOutputSink::Drained),
				..Default::default()
			},
			background: AtomicBool::new(false),
			output: Mutex::new(OutputStore::new(
				path.with_extension("output"),
				COMMAND_LIVE_BYTES,
				FOREGROUND_SPILL_BYTES,
				TASK_DISK_BYTES,
			)),
			input: Mutex::new(InputQueue::default()),
			resize: Mutex::new(None),
			setup: Mutex::new(None),
			setup_changed: Condvar::new(),
			worker: Mutex::new(None),
			finished: AtomicBool::new(false),
		});
		let error = match spawn(&command, true) {
			Ok(_) => panic!("assignment failure launched command"),
			Err(error) => error,
		};
		assert_eq!(error.error.code, "ContainmentUnavailable");
		assert_eq!(error.cleanup, Cleanup::Reaped {});
		assert!(!path.exists(), "suspended command executed before job assignment");
	}
	#[test]
	fn windows_owner_close_confirms_job_descendants_and_replay_is_inert() {
		let actor = Actor::new();
		let scope = OwnerScope::Session { session_id: "windows-command".into() };
		let owner = actor.open(&actor.bind(scope.clone()), scope).unwrap();
		let identities =
			std::env::temp_dir().join(format!("atomic-job-tree-{}.json", std::process::id()));
		let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
			.join("../../test/fixtures/task-process-tree.mjs");
		let task = actor
			.start_command(
				&owner,
				intent(&format!("node \"{}\" \"{}\"", fixture.display(), identities.display())),
				"job".into(),
			)
			.unwrap();
		let ready = Instant::now() + Duration::from_secs(5);
		while !std::fs::read_to_string(&identities).is_ok_and(|text| text.contains("grandchild")) {
			assert!(Instant::now() < ready, "process-tree identities missing");
			std::thread::sleep(PROCESS_POLL);
		}
		actor.begin_close(&owner).unwrap();
		let deadline = Instant::now() + PROCESS_SHUTDOWN_GRACE;
		let receipt = loop {
			if let Some(receipt) = actor.close_receipt(&owner).unwrap() {
				break receipt;
			}
			assert!(Instant::now() < deadline, "job cleanup deadline");
			std::thread::sleep(PROCESS_POLL);
		};
		assert_eq!(receipt.tasks[0].cleanup, Cleanup::Reaped {});
		assert_eq!(actor.cancel(&task, CancelCause::User).unwrap().cleanup, Cleanup::Reaped {});
		actor.shutdown();
		std::fs::remove_file(identities).unwrap();
	}
	// A command that ran to completion while its stdin writer was held off past the stop grace and the late report still
	// completes: its job has ended, so nothing reads the input the writer would send (#5202).
	#[test]
	fn command_whose_job_ended_completes_while_its_stdin_writer_is_held_off_5202() {
		let actor = Actor::new();
		let scope = OwnerScope::Session { session_id: "windows-held-writer".into() };
		let owner = actor.open(&actor.bind(scope.clone()), scope).unwrap();
		let task =
			actor.start_command(&owner, intent("ping -n 2 127.0.0.1 >NUL"), "job".into()).unwrap();
		let command = actor.command_resource(&task).unwrap();
		// The writer takes the input queue's lock on every pass; holding it keeps the writer from reporting its stop
		// until the command has ended and the grace and late report have passed.
		let held = command.input.lock().unwrap();
		std::thread::sleep(
			Duration::from_secs(2) + PROCESS_DRAIN_GRACE + STDIN_WRITER_LATE_REPORT * 5,
		);
		drop(held);
		let deadline =
			Instant::now() + PROCESS_DRAIN_GRACE + PROCESS_SHUTDOWN_GRACE + STDIN_WRITER_TEST_WAIT;
		let record = loop {
			let record = actor.snapshot(&owner).unwrap().tasks[0].clone();
			if matches!(record.execution, Execution::Settled { .. })
				&& !matches!(record.cleanup, Cleanup::Active {} | Cleanup::Draining {})
			{
				break record;
			}
			assert!(Instant::now() < deadline, "the result never settled: {record:?}");
			std::thread::sleep(PROCESS_POLL);
		};
		actor.shutdown();
		assert!(
			matches!(
				&record.execution,
				Execution::Settled { result: TaskResult::Completed { exit_code: Some(code), .. } } if *code == 0.0
			),
			"{record:?}"
		);
		assert_eq!(record.cleanup, Cleanup::Reaped {});
	}
	#[test]
	fn completed_command_with_busy_idle_stdin_queue_and_kept_background_is_reaped_5702() {
		let actor = Actor::new();
		let scope = OwnerScope::Session { session_id: "windows-idle-input".into() };
		let owner = actor.open(&actor.bind(scope.clone()), scope).unwrap();
		let dir = std::env::temp_dir().join(format!("atomic-idle-input-{}", std::process::id()));
		std::fs::create_dir(&dir).unwrap();
		let mut waiting = intent(
			"node -e \"const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync('exit'))clearInterval(t)},10)\"",
		);
		waiting.cwd = Some(dir.to_string_lossy().to_string().into());
		let options =
			CommandResourceOptions { keep_background_on_exit: Some(true), ..Default::default() };
		let task = actor.start_command_configured(&owner, waiting, "job".into(), options).unwrap();
		let command = actor.command_resource(&task).unwrap();
		// Hold the empty queue through settlement: an idle writer stalled under this lock cannot be writing to a pipe.
		let held = command.input.lock().unwrap();
		std::fs::write(dir.join("exit"), "").unwrap();
		let deadline = Instant::now() + PROCESS_DRAIN_GRACE + STDIN_WRITER_TEST_WAIT;
		let record = loop {
			let record = actor.snapshot(&owner).unwrap().tasks[0].clone();
			if !matches!(record.cleanup, Cleanup::Active {} | Cleanup::Draining {}) {
				break record;
			}
			assert!(Instant::now() < deadline, "command did not settle: {record:?}");
			std::thread::sleep(PROCESS_POLL);
		};
		drop(held);
		actor.shutdown();
		std::fs::remove_dir_all(dir).unwrap();
		assert!(
			matches!(&record.execution, Execution::Settled { result: TaskResult::Completed { exit_code: Some(code), .. } } if *code == 0.0),
			"{record:?}"
		);
		assert_eq!(record.cleanup, Cleanup::Reaped {});
	}
	#[test]
	fn confirming_idle_stdin_while_the_queue_is_locked_fences_the_next_delivery_5702() {
		let stop = StdinWriterStop::default();
		let input = Mutex::new(InputQueue::default());
		let _idle_poll = input.lock().unwrap();
		assert!(stop.close_input_between_writes(&input));
		let mut bytes = Vec::new();
		assert!(stop.deliver(|| bytes.write(b"late")).is_err());
		assert!(bytes.is_empty());
	}
	const STDIN_WRITER_TEST_WAIT: Duration = Duration::from_secs(10);
	#[test]
	fn stdin_writer_completion_notifies_without_poll_delay_and_bounds_blocked_worker_5202_5340() {
		let mut durations = Vec::new();
		for _ in 0..5 {
			let stop_input = Arc::new(StdinWriterStop::default());
			let stopped = stop_input.clone();
			let (ready_tx, ready_rx) = std::sync::mpsc::channel();
			let (done_tx, done_rx) = std::sync::mpsc::channel();
			let writer = std::thread::spawn(move || {
				ready_tx.send(()).unwrap();
				while !stopped.requested.load(Ordering::Acquire) {
					std::thread::park_timeout(Duration::from_secs(5));
				}
				let _ = done_tx.send(());
			});
			ready_rx.recv_timeout(STDIN_WRITER_TEST_WAIT).unwrap();
			let started = Instant::now();
			let (retained, failure) = finish_stdin_writer(
				&stop_input,
				writer,
				&done_rx,
				&Mutex::new(InputQueue::default()),
				PROCESS_DRAIN_GRACE,
				STDIN_WRITER_LATE_REPORT,
				false,
			);
			assert!(retained.is_none());
			assert!(failure.is_none());
			durations.push(started.elapsed());
		}
		durations.sort();
		assert!(
			durations[2] < PROCESS_POLL,
			"median writer completion {:?} >= {:?}",
			durations[2],
			PROCESS_POLL
		);

		let stop_panic = StdinWriterStop::default();
		let (panic_done_tx, panic_done_rx) = std::sync::mpsc::channel();
		let panic_writer = std::thread::spawn(move || {
			let _done = panic_done_tx;
			panic!("stdin fixture panic");
		});
		let (retained, failure) = finish_stdin_writer(
			&stop_panic,
			panic_writer,
			&panic_done_rx,
			&Mutex::new(InputQueue::default()),
			PROCESS_DRAIN_GRACE,
			STDIN_WRITER_LATE_REPORT,
			false,
		);
		assert!(retained.is_none());
		assert_eq!(failure.as_deref(), Some("Windows stdin worker panicked"));

		// A writer blocked in a write to the command's stdin holds the input queue's lock for as long as the write lasts.
		let stop_blocked = Arc::new(StdinWriterStop::default());
		let blocked_delivery = stop_blocked.clone();
		let blocked_input = Arc::new(Mutex::new(InputQueue::default()));
		let writing = blocked_input.clone();
		let (blocked_ready_tx, blocked_ready_rx) = std::sync::mpsc::channel();
		let (release_tx, release_rx) = std::sync::mpsc::channel();
		let (blocked_done_tx, blocked_done_rx) = std::sync::mpsc::channel();
		let blocked_writer = std::thread::spawn(move || {
			let _done = blocked_done_tx;
			let _write = writing.lock().unwrap();
			blocked_delivery
				.deliver(|| {
					blocked_ready_tx.send(()).unwrap();
					let _ = release_rx.recv_timeout(STDIN_WRITER_TEST_WAIT);
					Ok(1)
				})
				.unwrap();
		});
		blocked_ready_rx.recv_timeout(STDIN_WRITER_TEST_WAIT).unwrap();
		let started = Instant::now();
		let (retained, failure) = finish_stdin_writer(
			&stop_blocked,
			blocked_writer,
			&blocked_done_rx,
			&blocked_input,
			Duration::from_millis(10),
			STDIN_WRITER_LATE_REPORT,
			false,
		);
		assert!(started.elapsed() < PROCESS_DRAIN_GRACE);
		assert!(retained.is_some());
		assert_eq!(failure.as_deref(), Some("Windows stdin worker stop was not confirmed"));
		release_tx.send(()).unwrap();
		retained.unwrap().join().unwrap();

		let stop_stalled = Arc::new(StdinWriterStop::default());
		let stalled_delivery = stop_stalled.clone();
		let stalled_input = Arc::new(Mutex::new(InputQueue::default()));
		let stalled_write = stalled_input.clone();
		let (stall_ready_tx, stall_ready_rx) = std::sync::mpsc::channel();
		let (stall_release_tx, stall_release_rx) = std::sync::mpsc::channel();
		let (stall_done_tx, stall_done_rx) = std::sync::mpsc::channel();
		let stalled_writer = std::thread::spawn(move || {
			drop(stall_done_tx);
			let _write = stalled_write.lock().unwrap();
			stalled_delivery
				.deliver(|| {
					stall_ready_tx.send(()).unwrap();
					let _ = stall_release_rx.recv();
					Ok(1)
				})
				.unwrap();
		});
		stall_ready_rx.recv_timeout(STDIN_WRITER_TEST_WAIT).unwrap();
		let started = Instant::now();
		let (retained, failure) = finish_stdin_writer(
			&stop_stalled,
			stalled_writer,
			&stall_done_rx,
			&stalled_input,
			Duration::from_millis(10),
			STDIN_WRITER_LATE_REPORT,
			false,
		);
		assert!(started.elapsed() < PROCESS_DRAIN_GRACE);
		assert!(retained.is_some());
		assert_eq!(failure.as_deref(), Some("Windows stdin worker stop was not confirmed"));
		stall_release_tx.send(()).unwrap();
		retained.unwrap().join().unwrap();
	}
	// A writer that reported its stop has closed the input and the stdin handle. Under load its thread can take longer
	// than the grace to end, and a command that ran to completion must not fail on that.
	#[test]
	fn stdin_writer_that_reported_its_stop_is_confirmed_while_its_thread_still_ends_5340() {
		let stop_input = StdinWriterStop::default();
		let (done_tx, done_rx) = std::sync::mpsc::channel();
		let (ready_tx, ready_rx) = std::sync::mpsc::channel();
		let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
		let (ended_tx, ended_rx) = std::sync::mpsc::channel();
		let writer = std::thread::spawn(move || {
			done_tx.send(()).unwrap();
			ready_tx.send(()).unwrap();
			let _ = release_rx.recv();
			ended_tx.send(()).unwrap();
		});
		ready_rx.recv_timeout(STDIN_WRITER_TEST_WAIT).unwrap();
		let started = Instant::now();
		let (retained, failure) = finish_stdin_writer(
			&stop_input,
			writer,
			&done_rx,
			&Mutex::new(InputQueue::default()),
			Duration::from_millis(10),
			STDIN_WRITER_LATE_REPORT,
			false,
		);
		assert!(started.elapsed() < PROCESS_DRAIN_GRACE);
		assert_eq!(failure, None);
		assert!(retained.is_none());
		release_tx.send(()).unwrap();
		ended_rx.recv_timeout(STDIN_WRITER_TEST_WAIT).unwrap();
	}
	// A host that stalls every thread lets the grace pass before the writer ran at all; the writer reports once it
	// runs, and that stop is confirmed too.
	#[test]
	fn stdin_writer_that_reports_its_stop_just_after_the_grace_is_confirmed_5340() {
		let grace = Duration::from_millis(10);
		let stop_input = Arc::new(StdinWriterStop::default());
		let stopped = stop_input.clone();
		let (ready_tx, ready_rx) = std::sync::mpsc::channel();
		let (done_tx, done_rx) = std::sync::mpsc::channel();
		let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
		let writer = std::thread::spawn(move || {
			ready_tx.send(()).unwrap();
			while !stopped.requested.load(Ordering::Acquire) {
				std::thread::park_timeout(PROCESS_POLL);
			}
			std::thread::sleep(grace + STDIN_WRITER_TEST_WAIT / 2);
			done_tx.send(()).unwrap();
			let _ = release_rx.recv();
		});
		ready_rx.recv_timeout(STDIN_WRITER_TEST_WAIT).unwrap();
		let (retained, failure) = finish_stdin_writer(
			&stop_input,
			writer,
			&done_rx,
			&Mutex::new(InputQueue::default()),
			grace,
			STDIN_WRITER_TEST_WAIT,
			false,
		);
		assert_eq!(failure, None);
		assert!(retained.is_none());
		release_tx.send(()).unwrap();
	}
	// A loaded host can leave the writer unscheduled past the grace and the late report, even part-way through a pass
	// that holds the input queue's lock. Once the command's job has ended, nothing reads the pipe it feeds, so a command
	// that ran to completion must not fail on that (#5202); the writer still ends on its own once it runs.
	#[test]
	fn stdin_writer_not_yet_scheduled_after_its_job_ended_does_not_fail_the_command_5202() {
		let stop_input = StdinWriterStop::default();
		let input = Arc::new(Mutex::new(InputQueue::default()));
		let pass = input.clone();
		let (ready_tx, ready_rx) = std::sync::mpsc::channel();
		let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
		let (done_tx, done_rx) = std::sync::mpsc::channel();
		let (ended_tx, ended_rx) = std::sync::mpsc::channel();
		let writer = std::thread::spawn(move || {
			let held = pass.lock().unwrap();
			ready_tx.send(()).unwrap();
			let _ = release_rx.recv_timeout(STDIN_WRITER_TEST_WAIT);
			drop(held);
			let _ = done_tx.send(());
			ended_tx.send(()).unwrap();
		});
		ready_rx.recv_timeout(STDIN_WRITER_TEST_WAIT).unwrap();
		let started = Instant::now();
		let (retained, failure) = finish_stdin_writer(
			&stop_input,
			writer,
			&done_rx,
			&input,
			Duration::from_millis(10),
			STDIN_WRITER_LATE_REPORT,
			true,
		);
		assert!(started.elapsed() < PROCESS_DRAIN_GRACE);
		assert_eq!(failure, None);
		assert!(retained.is_none());
		release_tx.send(()).unwrap();
		ended_rx.recv_timeout(STDIN_WRITER_TEST_WAIT).unwrap();
	}
	// A named worktree's Git command keeps its background processes on exit, so its job has not ended when its stdin
	// writer is stopped. A loaded host can leave that writer unscheduled past the grace and the late report; it is not
	// in a write, so the supervisor closes the input under it, and once it runs it only closes the stdin handle and
	// ends. A command that ran to completion must not fail on that (#5512).
	#[test]
	fn stdin_writer_not_yet_scheduled_while_kept_background_runs_does_not_fail_5512() {
		let stop_input = Arc::new(StdinWriterStop::default());
		let stopped = stop_input.clone();
		let input = Arc::new(Mutex::new(InputQueue::default()));
		let queue = input.clone();
		let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
		let (done_tx, done_rx) = std::sync::mpsc::channel();
		let (ended_tx, ended_rx) = std::sync::mpsc::channel();
		let writer = std::thread::spawn(move || {
			let _ = release_rx.recv_timeout(STDIN_WRITER_TEST_WAIT);
			assert!(stopped.requested.load(Ordering::Acquire));
			queue.lock().unwrap().close();
			let _ = done_tx.send(());
			ended_tx.send(()).unwrap();
		});
		let started = Instant::now();
		let (retained, failure) = finish_stdin_writer(
			&stop_input,
			writer,
			&done_rx,
			&input,
			Duration::from_millis(10),
			STDIN_WRITER_LATE_REPORT,
			false,
		);
		assert!(started.elapsed() < PROCESS_DRAIN_GRACE);
		assert_eq!(failure, None);
		assert!(retained.is_none());
		release_tx.send(()).unwrap();
		ended_rx.recv_timeout(STDIN_WRITER_TEST_WAIT).unwrap();
	}
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod conpty_tests;
