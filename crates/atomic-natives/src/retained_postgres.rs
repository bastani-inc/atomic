use std::{
	collections::HashMap,
	fs::OpenOptions,
	io,
	process::{Child, Command, Stdio},
	sync::{Arc, Mutex, MutexGuard},
	thread,
	time::{Duration, Instant},
};

use napi::{Error, Result};
use napi_derive::napi;

use crate::task;

const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[napi(object)]
pub struct RetainedPostgresSpawnOptions {
	pub executable: String,
	pub args: Vec<String>,
	pub cwd: String,
	pub log_file: String,
	pub env: Option<HashMap<String, String>>,
	pub uid: Option<u32>,
	pub gid: Option<u32>,
}

#[derive(Debug)]
#[napi(object)]
pub struct RetainedPostgresWaitResult {
	pub exited: bool,
	pub signaled: bool,
}

struct LeaseState {
	child: Option<Child>,
}

impl LeaseState {
	fn pid(&self) -> Option<u32> {
		self.child.as_ref().map(Child::id)
	}
}

/// Opaque ownership lease for the exact Postgres process spawned by Atomic.
///
/// Keeping the native child object prevents PID reuse until the process has
/// been observed and reaped. Dropping/releasing the lease deliberately does
/// not terminate the server, preserving abrupt-exit persistence.
#[napi]
pub struct RetainedPostgres {
	state: Arc<Mutex<LeaseState>>,
}

#[napi]
impl RetainedPostgres {
	#[napi(getter)]
	pub fn pid(&self) -> Option<u32> {
		self.state.lock().ok().and_then(|state| state.pid())
	}

	#[napi(js_name = "interruptAndWait")]
	pub fn interrupt_and_wait(&self, timeout_ms: u32) -> task::Promise<RetainedPostgresWaitResult> {
		let state = Arc::clone(&self.state);
		task::blocking("retained-postgres-interrupt", (), move |_| {
			interrupt_and_wait(&state, Duration::from_millis(u64::from(timeout_ms)))
		})
	}

	#[napi]
	pub fn wait(&self, timeout_ms: u32) -> task::Promise<RetainedPostgresWaitResult> {
		let state = Arc::clone(&self.state);
		task::blocking("retained-postgres-wait", (), move |_| {
			wait_for_exit(&state, Duration::from_millis(u64::from(timeout_ms)), false)
		})
	}

	/// Relinquish ownership without signaling or waiting for Postgres.
	#[napi]
	pub fn release(&self) -> Result<()> {
		let mut state = lock_state(&self.state)?;
		state.child.take();
		Ok(())
	}
}

#[napi(js_name = "spawnRetainedPostgres")]
pub fn spawn_retained_postgres(options: RetainedPostgresSpawnOptions) -> Result<RetainedPostgres> {
	let child = spawn_child(options)
		.map_err(|error| Error::from_reason(format!("Could not start Postgres: {error}")))?;
	Ok(RetainedPostgres { state: Arc::new(Mutex::new(LeaseState { child: Some(child) })) })
}

fn spawn_child(options: RetainedPostgresSpawnOptions) -> io::Result<Child> {
	let stdout = OpenOptions::new().create(true).append(true).open(&options.log_file)?;
	let stderr = stdout.try_clone()?;
	let mut command = Command::new(&options.executable);
	command
		.args(&options.args)
		.current_dir(&options.cwd)
		.stdin(Stdio::null())
		.stdout(Stdio::from(stdout))
		.stderr(Stdio::from(stderr));
	if let Some(env) = options.env {
		command.envs(env);
	}
	configure_process(&mut command, options.uid, options.gid);
	command.spawn()
}

#[cfg(unix)]
fn configure_process(command: &mut Command, uid: Option<u32>, gid: Option<u32>) {
	use std::os::unix::process::CommandExt;

	// Keep all identity syscalls in one pre-exec closure: CommandExt applies
	// `gid` before its implicit supplementary-group cleanup, while clearing
	// groups must happen before either setgid or setuid drops root privileges.
	// An omitted uid/gid remains omitted, and an explicit zero remains an
	// explicit root identity rather than being treated as a missing option.
	unsafe {
		command.pre_exec(move || {
			if libc::setsid() == -1 {
				return Err(io::Error::last_os_error());
			}
			#[cfg(not(target_os = "redox"))]
			if libc::geteuid() == 0
				&& uid.is_some_and(|target_uid| target_uid != 0)
				&& libc::setgroups(0, std::ptr::null()) == -1
			{
				return Err(io::Error::last_os_error());
			}
			if let Some(gid) = gid
				&& libc::setgid(gid as libc::gid_t) == -1
			{
				return Err(io::Error::last_os_error());
			}
			if let Some(uid) = uid
				&& libc::setuid(uid as libc::uid_t) == -1
			{
				return Err(io::Error::last_os_error());
			}
			Ok(())
		});
	}
}
#[cfg(windows)]
fn configure_process(command: &mut Command, _uid: Option<u32>, _gid: Option<u32>) {
	use std::os::windows::process::CommandExt;
	// CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP. The postmaster runs attached
	// to an invisible console that its child processes inherit; DETACHED_PROCESS
	// would leave it consoleless, making every console-subsystem descendant
	// (checkpointer, walwriter, backends, ...) allocate its own visible console
	// window. The retained Child keeps the process HANDLE open either way.
	command.creation_flags(0x0800_0000 | 0x0000_0200);
}

#[cfg(not(any(unix, windows)))]
fn configure_process(_command: &mut Command, _uid: Option<u32>, _gid: Option<u32>) {}

fn interrupt_and_wait(
	state: &Arc<Mutex<LeaseState>>,
	timeout: Duration,
) -> Result<RetainedPostgresWaitResult> {
	let deadline = Instant::now() + timeout;
	let mut state = lock_state(state)?;
	if reap_if_exited(&mut state)? {
		return Ok(RetainedPostgresWaitResult { exited: true, signaled: false });
	}
	let shutdown = {
		let child = state
			.child
			.as_mut()
			.ok_or_else(|| Error::from_reason("Retained Postgres lease has been released"))?;
		send_fast_shutdown(child, deadline)?
	};
	if shutdown == FastShutdown::Exited {
		state.child.take();
		return Ok(RetainedPostgresWaitResult { exited: true, signaled: false });
	}
	wait_for_exit_locked(&mut state, deadline, true)
}
fn wait_for_exit(
	state: &Arc<Mutex<LeaseState>>,
	timeout: Duration,
	signaled: bool,
) -> Result<RetainedPostgresWaitResult> {
	let mut state = lock_state(state)?;
	wait_for_exit_locked(&mut state, Instant::now() + timeout, signaled)
}

fn wait_for_exit_locked(
	state: &mut LeaseState,
	deadline: Instant,
	signaled: bool,
) -> Result<RetainedPostgresWaitResult> {
	loop {
		if reap_if_exited(state)? {
			return Ok(RetainedPostgresWaitResult { exited: true, signaled });
		}
		let now = Instant::now();
		if now >= deadline {
			return Err(Error::from_reason(
				"Timed out waiting for the retained Postgres process to exit",
			));
		}
		thread::sleep(WAIT_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
	}
}

fn reap_if_exited(state: &mut LeaseState) -> Result<bool> {
	let Some(child) = state.child.as_mut() else {
		return Ok(true);
	};
	match child.try_wait() {
		Ok(Some(_status)) => {
			state.child.take();
			Ok(true)
		},
		Ok(None) => Ok(false),
		Err(error) => {
			Err(Error::from_reason(format!("Could not query retained Postgres process: {error}")))
		},
	}
}

fn lock_state(state: &Arc<Mutex<LeaseState>>) -> Result<MutexGuard<'_, LeaseState>> {
	state.lock().map_err(|_| Error::from_reason("Retained Postgres lease lock poisoned"))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FastShutdown {
	Sent,
	Exited,
}

#[cfg(unix)]
fn send_fast_shutdown(child: &mut Child, deadline: Instant) -> Result<FastShutdown> {
	let pid = child.id();
	if Instant::now() >= deadline {
		return Err(Error::from_reason(format!(
			"Timed out before sending fast shutdown to retained Postgres process {pid}"
		)));
	}
	let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGINT) };
	if result == 0 {
		return Ok(FastShutdown::Sent);
	}
	let error = io::Error::last_os_error();
	if matches!(child.try_wait(), Ok(Some(_))) {
		return Ok(FastShutdown::Exited);
	}
	Err(Error::from_reason(format!(
		"Could not send fast shutdown to retained Postgres process {pid}: {error}"
	)))
}

#[cfg(windows)]
fn send_fast_shutdown(child: &mut Child, deadline: Instant) -> Result<FastShutdown> {
	use std::ffi::OsStr;
	use std::os::windows::ffi::OsStrExt;
	use windows_sys::Win32::Foundation::{ERROR_BAD_PIPE, ERROR_BROKEN_PIPE};

	const POSTGRES_SIGINT: u8 = 2;
	let pid = child.id();
	let pipe_name: Vec<u16> =
		OsStr::new(&format!(r"\\.\pipe\pgsignal_{pid}")).encode_wide().chain(Some(0)).collect();
	let (bytes_read, reply) = match transact_named_pipe(&pipe_name, POSTGRES_SIGINT, deadline) {
		Ok(result) => result,
		Err(error) => {
			if matches!(child.try_wait(), Ok(Some(_))) {
				return Ok(FastShutdown::Exited);
			}
			let code = error.raw_os_error().unwrap_or_default() as u32;
			// PostgreSQL's pgkill treats these transient errors as successful: the
			// pipe server queued the signal and disconnected while exiting.
			if code == ERROR_BROKEN_PIPE || code == ERROR_BAD_PIPE {
				return Ok(FastShutdown::Sent);
			}
			return Err(Error::from_reason(format!(
				"Could not send fast shutdown to retained Postgres process {pid}: {error}"
			)));
		},
	};
	if bytes_read != 1 || reply != POSTGRES_SIGINT {
		if matches!(child.try_wait(), Ok(Some(_))) {
			return Ok(FastShutdown::Exited);
		}
		return Err(Error::from_reason(format!(
			"Retained Postgres process {pid} did not acknowledge fast shutdown"
		)));
	}
	Ok(FastShutdown::Sent)
}

#[cfg(windows)]
struct OwnedWindowsHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for OwnedWindowsHandle {
	fn drop(&mut self) {
		unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
	}
}

#[cfg(windows)]
struct PendingPipeTransaction {
	pipe: OwnedWindowsHandle,
	event: OwnedWindowsHandle,
	signal: u8,
	reply: u8,
	overlapped: windows_sys::Win32::System::IO::OVERLAPPED,
}

// SAFETY: the allocation is moved only by its owning Box, so the addresses
// passed to the kernel remain stable. Its handles are used by one thread at a
// time and are not closed until GetOverlappedResult observes completion.
#[cfg(windows)]
unsafe impl Send for PendingPipeTransaction {}

#[cfg(windows)]
impl PendingPipeTransaction {
	fn wait_for_completion(&mut self) {
		let mut bytes_read = 0_u32;
		unsafe {
			windows_sys::Win32::System::IO::GetOverlappedResult(
				self.pipe.0,
				&self.overlapped,
				&mut bytes_read,
				1,
			);
		}
	}
}

#[cfg(windows)]
fn pending_pipe_reaper() -> &'static Option<std::sync::mpsc::Sender<Box<PendingPipeTransaction>>> {
	use std::sync::{OnceLock, mpsc};

	static REAPER: OnceLock<Option<mpsc::Sender<Box<PendingPipeTransaction>>>> = OnceLock::new();
	REAPER.get_or_init(|| {
		let (sender, receiver) = mpsc::channel::<Box<PendingPipeTransaction>>();
		match thread::Builder::new().name("postgres-pipe-reaper".to_owned()).spawn(move || {
			for mut transaction in receiver {
				transaction.wait_for_completion();
			}
		}) {
			Ok(_thread) => Some(sender),
			Err(_) => None,
		}
	})
}

#[cfg(windows)]
fn defer_pending_pipe_completion(transaction: Box<PendingPipeTransaction>) {
	let transaction = match pending_pipe_reaper() {
		Some(sender) => match sender.send(transaction) {
			Ok(()) => return,
			Err(error) => error.0,
		},
		None => transaction,
	};
	// Failure to create or reach the reaper must not free memory or close handles
	// that an outstanding kernel request can still access. Leak as a fail-safe.
	let _leaked = Box::into_raw(transaction);
}

#[cfg(windows)]
fn cancel_and_defer_pipe_completion(transaction: Box<PendingPipeTransaction>) {
	unsafe {
		windows_sys::Win32::System::IO::CancelIoEx(transaction.pipe.0, &transaction.overlapped);
	}
	defer_pending_pipe_completion(transaction);
}

#[cfg(windows)]
fn retry_while_pipe_busy<T>(
	deadline: Instant,
	mut attempt: impl FnMut(u32) -> io::Result<T>,
) -> io::Result<T> {
	use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;

	loop {
		let remaining_ms = remaining_timeout_ms(deadline)?;
		match attempt(remaining_ms) {
			Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => continue,
			Ok(value) => {
				remaining_timeout_ms(deadline)?;
				return Ok(value);
			},
			Err(error) => return Err(error),
		}
	}
}

#[cfg(windows)]
fn open_named_pipe(pipe_name: &[u16], deadline: Instant) -> io::Result<OwnedWindowsHandle> {
	use std::ptr;
	use windows_sys::Win32::{
		Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
		Storage::FileSystem::{CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING},
		System::Pipes::{PIPE_READMODE_MESSAGE, SetNamedPipeHandleState, WaitNamedPipeW},
	};

	retry_while_pipe_busy(deadline, |remaining_ms| {
		if unsafe { WaitNamedPipeW(pipe_name.as_ptr(), remaining_ms) } == 0 {
			return Err(io::Error::last_os_error());
		}
		let pipe = unsafe {
			CreateFileW(
				pipe_name.as_ptr(),
				GENERIC_READ | GENERIC_WRITE,
				0,
				ptr::null(),
				OPEN_EXISTING,
				FILE_FLAG_OVERLAPPED,
				ptr::null_mut(),
			)
		};
		if pipe == INVALID_HANDLE_VALUE {
			return Err(io::Error::last_os_error());
		}
		let pipe = OwnedWindowsHandle(pipe);
		// TransactNamedPipe requires the client end in message-read mode; the
		// default byte mode fails the transaction with ERROR_BAD_PIPE.
		let mode = PIPE_READMODE_MESSAGE;
		if unsafe { SetNamedPipeHandleState(pipe.0, &mode, ptr::null_mut(), ptr::null_mut()) } == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(pipe)
	})
}

#[cfg(windows)]
fn transact_named_pipe(pipe_name: &[u16], signal: u8, deadline: Instant) -> io::Result<(u32, u8)> {
	use std::ptr;
	use windows_sys::Win32::{
		Foundation::{ERROR_IO_PENDING, GetLastError, WAIT_TIMEOUT},
		System::{
			IO::{GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED},
			Pipes::TransactNamedPipe,
			Threading::CreateEventW,
		},
	};

	remaining_timeout_ms(deadline)?;
	// Initialize completion ownership before any kernel I/O starts. Its setup
	// time is therefore charged to the caller's existing deadline, while timeout
	// cleanup itself is only a nonblocking channel handoff.
	let _reaper = pending_pipe_reaper();
	let pipe = open_named_pipe(pipe_name, deadline)?;
	let event = OwnedWindowsHandle(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) });
	if event.0.is_null() {
		return Err(io::Error::last_os_error());
	}
	let mut transaction = Box::new(PendingPipeTransaction {
		pipe,
		event,
		signal,
		reply: 0,
		overlapped: OVERLAPPED::default(),
	});
	transaction.overlapped.hEvent = transaction.event.0;
	// WaitNamedPipe/CreateFile may consume the last part of the budget. Do not
	// begin the signaling I/O after the shared deadline.
	remaining_timeout_ms(deadline)?;
	let immediate = unsafe {
		TransactNamedPipe(
			transaction.pipe.0,
			ptr::from_ref(&transaction.signal).cast(),
			1,
			ptr::from_mut(&mut transaction.reply).cast(),
			1,
			ptr::null_mut(),
			&mut transaction.overlapped,
		)
	};
	let mut bytes_read = 0_u32;
	if immediate != 0 {
		if unsafe {
			GetOverlappedResult(transaction.pipe.0, &transaction.overlapped, &mut bytes_read, 0)
		} == 0
		{
			return Err(io::Error::last_os_error());
		}
		return Ok((bytes_read, transaction.reply));
	}
	let start_error = unsafe { GetLastError() };
	if start_error != ERROR_IO_PENDING {
		return Err(io::Error::from_raw_os_error(start_error as i32));
	}
	let wait_ms = match remaining_timeout_ms(deadline) {
		Ok(wait_ms) => wait_ms,
		Err(error) => {
			cancel_and_defer_pipe_completion(transaction);
			return Err(error);
		},
	};
	let completed = unsafe {
		GetOverlappedResultEx(
			transaction.pipe.0,
			&transaction.overlapped,
			&mut bytes_read,
			wait_ms,
			0,
		)
	};
	if completed != 0 {
		return Ok((bytes_read, transaction.reply));
	}
	let completion_error = unsafe { GetLastError() };
	if completion_error == WAIT_TIMEOUT {
		cancel_and_defer_pipe_completion(transaction);
		return Err(io::Error::new(io::ErrorKind::TimedOut, "Postgres fast shutdown pipe timed out"));
	}
	Err(io::Error::from_raw_os_error(completion_error as i32))
}

#[cfg(windows)]
fn remaining_timeout_ms(deadline: Instant) -> io::Result<u32> {
	let remaining = deadline.saturating_duration_since(Instant::now());
	if remaining.is_zero() {
		return Err(io::Error::new(
			io::ErrorKind::TimedOut,
			"Postgres fast shutdown deadline elapsed",
		));
	}
	let rounded_up = remaining.as_micros().saturating_add(999) / 1_000;
	Ok(rounded_up.min(u128::from(u32::MAX)) as u32)
}

#[cfg(not(any(unix, windows)))]
fn send_fast_shutdown(_child: &mut Child, _deadline: Instant) -> Result<FastShutdown> {
	Err(Error::from_reason("Retained Postgres shutdown is unsupported on this platform"))
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		env,
		fs::{self, read_to_string},
		path::{Path, PathBuf},
		sync::{
			Arc,
			atomic::{AtomicU64, Ordering},
		},
		time::{Duration, Instant, SystemTime, UNIX_EPOCH},
	};

	use super::*;
	static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
	const INTERRUPT_FIXTURE_ENV: &str = "ATOMIC_RETAINED_POSTGRES_INTERRUPT_FIXTURE";
	#[cfg(target_os = "linux")]
	const CAPABILITY_DROP_FIXTURE_ENV: &str = "ATOMIC_RETAINED_POSTGRES_CAPABILITY_DROP_FIXTURE";
	static mut FIXTURE_INTERRUPT_COUNT: libc::c_int = 0;
	static mut FIXTURE_INTERRUPTS_BEFORE_EXIT: libc::c_int = 1;

	extern "C" fn fixture_interrupt_handler(_signal: libc::c_int) {
		// SAFETY: the signal is masked while its handler runs. `write` and `_exit`
		// are async-signal-safe, and the statics are initialized before SIGINT is
		// unblocked for this single-purpose child process.
		unsafe {
			FIXTURE_INTERRUPT_COUNT += 1;
			let count = FIXTURE_INTERRUPT_COUNT;
			let message: &[u8] = if count == 1 { b"interrupt-1\n" } else { b"interrupt-2\n" };
			libc::write(libc::STDOUT_FILENO, message.as_ptr().cast(), message.len());
			if count >= FIXTURE_INTERRUPTS_BEFORE_EXIT {
				libc::_exit(0);
			}
		}
	}

	#[test]
	fn retained_interrupt_fixture() {
		let Some(interrupts_before_exit) = env::var_os(INTERRUPT_FIXTURE_ENV) else {
			return;
		};
		let interrupts_before_exit = interrupts_before_exit.to_string_lossy().parse().unwrap();
		// Install a real process handler rather than delegating signal semantics to
		// `/bin/sh`. POSIX shells may not trap a signal inherited as ignored, which
		// is how background-oriented Linux runners launch their command tree.
		unsafe {
			FIXTURE_INTERRUPT_COUNT = 0;
			FIXTURE_INTERRUPTS_BEFORE_EXIT = interrupts_before_exit;
			let mut action: libc::sigaction = std::mem::zeroed();
			action.sa_sigaction = fixture_interrupt_handler as *const () as usize;
			libc::sigemptyset(&mut action.sa_mask);
			assert_eq!(libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut()), 0);
			let ready = b"ready\n";
			assert_eq!(
				libc::write(libc::STDOUT_FILENO, ready.as_ptr().cast(), ready.len()),
				ready.len() as isize,
			);
		}
		loop {
			thread::park();
		}
	}

	fn interrupt_fixture(interrupts_before_exit: u8) -> (RetainedPostgres, PathBuf) {
		let root = fixture_root();
		let log_file = root.join("postgres.log");
		let lease = spawn_retained_postgres(RetainedPostgresSpawnOptions {
			executable: env::current_exe().unwrap().to_string_lossy().into_owned(),
			args: vec![
				"--exact".to_owned(),
				"retained_postgres::tests::retained_interrupt_fixture".to_owned(),
				"--nocapture".to_owned(),
			],
			cwd: root.to_string_lossy().into_owned(),
			log_file: log_file.to_string_lossy().into_owned(),
			env: Some(HashMap::from([(
				INTERRUPT_FIXTURE_ENV.to_owned(),
				interrupts_before_exit.to_string(),
			)])),
			uid: None,
			gid: None,
		})
		.unwrap();
		(lease, root)
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn retained_capability_drop_fixture() {
		let Some(root) = env::var_os(CAPABILITY_DROP_FIXTURE_ENV) else {
			return;
		};
		if unsafe { libc::geteuid() } != 0 {
			return;
		}

		#[repr(C)]
		#[derive(Clone, Copy, Default)]
		struct CapabilityHeader {
			version: u32,
			pid: i32,
		}
		#[repr(C)]
		#[derive(Clone, Copy, Default)]
		struct CapabilityData {
			effective: u32,
			permitted: u32,
			inheritable: u32,
		}

		const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
		const CAP_SETGID: u32 = 6;
		const CAP_SETUID: u32 = 7;
		let mut header = CapabilityHeader { version: LINUX_CAPABILITY_VERSION_3, pid: 0 };
		let mut data = [CapabilityData::default(); 2];
		assert_eq!(unsafe { libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr()) }, 0);
		assert_ne!(data[0].effective & (1 << CAP_SETUID), 0);
		data[0].effective &= !(1 << CAP_SETGID);
		data[0].permitted &= !(1 << CAP_SETGID);
		assert_eq!(unsafe { libc::syscall(libc::SYS_capset, &header, data.as_ptr()) }, 0);

		let root = PathBuf::from(root);
		let result = spawn_retained_postgres(RetainedPostgresSpawnOptions {
			executable: "/bin/true".to_owned(),
			args: Vec::new(),
			cwd: root.to_string_lossy().into_owned(),
			log_file: root.join("capability.log").to_string_lossy().into_owned(),
			env: None,
			uid: Some(65534),
			gid: None,
		});
		if let Ok(lease) = result {
			let _ = wait_for_exit(&lease.state, Duration::from_secs(2), false);
			panic!("spawn must fail closed when root cannot clear supplementary groups");
		}
	}
	fn fixture(script: &str) -> (RetainedPostgres, PathBuf) {
		fixture_as(script, None, None)
	}

	fn fixture_root() -> PathBuf {
		let root = std::env::temp_dir().join(format!(
			"atomic-retained-postgres-{}-{}-{}",
			std::process::id(),
			SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
			NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
		));
		fs::create_dir_all(&root).unwrap();
		root
	}

	fn fixture_as(script: &str, uid: Option<u32>, gid: Option<u32>) -> (RetainedPostgres, PathBuf) {
		let root = fixture_root();
		let log_file = root.join("postgres.log");
		let lease = spawn_retained_postgres(RetainedPostgresSpawnOptions {
			executable: "/bin/sh".to_owned(),
			args: vec!["-c".to_owned(), script.to_owned()],
			cwd: root.to_string_lossy().into_owned(),
			log_file: log_file.to_string_lossy().into_owned(),
			env: None,
			uid,
			gid,
		})
		.unwrap();
		(lease, root)
	}

	fn wait_for_log(root: &Path, needle: &str) {
		let deadline = Instant::now() + Duration::from_secs(2);
		while Instant::now() < deadline {
			if read_to_string(root.join("postgres.log")).unwrap_or_default().contains(needle) {
				return;
			}
			thread::sleep(Duration::from_millis(10));
		}
		panic!("fixture never became ready");
	}

	fn parse_id_groups(value: &str) -> Vec<u32> {
		let mut groups: Vec<u32> =
			value.split_whitespace().map(|group| group.parse().unwrap()).collect();
		groups.sort_unstable();
		groups.dedup();
		groups
	}

	fn current_unix_groups() -> Vec<u32> {
		let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
		assert!(count >= 0);
		let mut groups = vec![0 as libc::gid_t; count as usize];
		if count > 0 {
			assert_eq!(unsafe { libc::getgroups(count, groups.as_mut_ptr()) }, count);
		}
		groups.push(unsafe { libc::getegid() });
		groups.sort_unstable();
		groups.dedup();
		groups
	}

	#[test]
	fn native_spawn_without_owner_preserves_unix_identity_and_supplementary_groups() {
		let uid = unsafe { libc::geteuid() };
		let gid = unsafe { libc::getegid() };
		let (lease, root) = fixture("id -u; id -g; id -G");
		wait_for_exit(&lease.state, Duration::from_secs(2), false).unwrap();
		let output = read_to_string(root.join("postgres.log")).unwrap();
		let mut lines = output.lines();
		assert_eq!(lines.next(), Some(uid.to_string().as_str()));
		assert_eq!(lines.next(), Some(gid.to_string().as_str()));
		assert_eq!(parse_id_groups(lines.next().unwrap()), current_unix_groups());
		assert_eq!(lines.next(), None);
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn native_spawn_applies_unix_uid_and_gid() {
		let uid = unsafe { libc::geteuid() };
		let gid = unsafe { libc::getegid() };
		let (lease, root) = fixture_as("id -u; id -g", Some(uid), Some(gid));
		wait_for_exit(&lease.state, Duration::from_secs(2), false).unwrap();
		assert_eq!(read_to_string(root.join("postgres.log")).unwrap(), format!("{uid}\n{gid}\n"));
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn interrupt_targets_retained_child_and_reaps_it() {
		let (lease, root) = interrupt_fixture(1);
		wait_for_log(&root, "ready");
		let result = interrupt_and_wait(&lease.state, Duration::from_secs(2)).unwrap();
		assert!(result.exited);
		assert!(result.signaled);
		assert!(lease.pid().is_none());
		assert!(read_to_string(root.join("postgres.log")).unwrap().contains("interrupt-1"));
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn exited_child_is_reaped_without_sending_a_signal() {
		let (lease, root) = fixture("echo exited");
		wait_for_log(&root, "exited");
		thread::sleep(Duration::from_millis(20));
		let result = interrupt_and_wait(&lease.state, Duration::from_secs(1)).unwrap();
		assert!(result.exited);
		assert!(!result.signaled);
		assert!(lease.pid().is_none());
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn timeout_retains_the_same_child_and_retries_the_interrupt() {
		let (lease, root) = interrupt_fixture(2);
		wait_for_log(&root, "ready");
		let pid = lease.pid().unwrap();
		let error = interrupt_and_wait(&lease.state, Duration::from_millis(30)).unwrap_err();
		assert!(error.reason.contains("Timed out"));
		assert_eq!(lease.pid(), Some(pid));
		wait_for_log(&root, "interrupt-1");
		let result = interrupt_and_wait(&lease.state, Duration::from_secs(2)).unwrap();
		assert!(result.exited);
		assert!(result.signaled, "retry signals the same retained child again");
		assert!(read_to_string(root.join("postgres.log")).unwrap().contains("interrupt-2"));
		fs::remove_dir_all(root).unwrap();
	}
	#[test]
	fn zero_timeout_never_signals_and_retains_the_same_child_for_retry() {
		let (lease, root) = interrupt_fixture(1);
		wait_for_log(&root, "ready");
		let pid = lease.pid().unwrap();

		let error = interrupt_and_wait(&lease.state, Duration::ZERO).unwrap_err();
		assert!(error.reason.contains("Timed out"));
		thread::sleep(Duration::from_millis(50));
		assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0);
		assert!(!read_to_string(root.join("postgres.log")).unwrap().contains("interrupt-1"));

		let result = interrupt_and_wait(&lease.state, Duration::from_secs(2)).unwrap();
		assert!(result.exited);
		assert!(result.signaled, "retry signals the same retained child");
		assert!(read_to_string(root.join("postgres.log")).unwrap().contains("interrupt-1"));
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn concurrent_callers_serialize_on_one_interrupt() {
		let (lease, root) = interrupt_fixture(1);
		wait_for_log(&root, "ready");
		let state = Arc::clone(&lease.state);
		let first =
			std::thread::spawn(move || interrupt_and_wait(&state, Duration::from_secs(2)).unwrap());
		let second = interrupt_and_wait(&lease.state, Duration::from_secs(2)).unwrap();
		let first = first.join().unwrap();
		assert_eq!(u8::from(first.signaled) + u8::from(second.signaled), 1);
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn release_drops_ownership_without_killing_the_child() {
		let (lease, root) = fixture("echo ready; while :; do sleep 1; done");
		wait_for_log(&root, "ready");
		let pid = lease.pid().unwrap();
		lease.release().unwrap();
		assert!(lease.pid().is_none());
		assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0);
		unsafe {
			libc::kill(pid as libc::pid_t, libc::SIGTERM);
			libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), 0);
		}
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn dropping_owner_abruptly_does_not_kill_the_child() {
		let (lease, root) = fixture("echo ready; while :; do sleep 1; done");
		wait_for_log(&root, "ready");
		let pid = lease.pid().unwrap();
		drop(lease);
		assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0);
		unsafe {
			libc::kill(pid as libc::pid_t, libc::SIGTERM);
			libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), 0);
		}
		fs::remove_dir_all(root).unwrap();
	}
	#[cfg(target_os = "linux")]
	#[test]
	fn root_spawn_fails_closed_when_supplementary_groups_cannot_be_cleared() {
		if unsafe { libc::geteuid() } != 0 {
			return;
		}
		let root = fixture_root();
		let status = Command::new(env::current_exe().unwrap())
			.args([
				"--exact",
				"retained_postgres::tests::retained_capability_drop_fixture",
				"--nocapture",
			])
			.env(CAPABILITY_DROP_FIXTURE_ENV, &root)
			.status()
			.unwrap();
		assert!(status.success(), "the capability-limited root fixture accepted an unsafe spawn");
		fs::remove_dir_all(root).unwrap();
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn root_spawn_drops_primary_identity_and_clears_root_supplementary_groups() {
		if unsafe { libc::geteuid() } != 0 {
			return;
		}
		let root = std::env::temp_dir()
			.join(format!("atomic-retained-postgres-owner-{}", std::process::id()));
		fs::create_dir_all(&root).unwrap();
		let log_file = root.join("owner.log");
		let lease = spawn_retained_postgres(RetainedPostgresSpawnOptions {
			executable: "/bin/sh".to_owned(),
			args: vec!["-c".to_owned(), "id -u; id -g; id -G".to_owned()],
			cwd: root.to_string_lossy().into_owned(),
			log_file: log_file.to_string_lossy().into_owned(),
			env: None,
			uid: Some(65534),
			gid: Some(65534),
		})
		.unwrap();
		wait_for_exit(&lease.state, Duration::from_secs(2), false).unwrap();
		let output = read_to_string(log_file).unwrap();
		let mut lines = output.lines();
		assert_eq!(lines.next(), Some("65534"));
		assert_eq!(lines.next(), Some("65534"));
		let groups = parse_id_groups(lines.next().unwrap());
		assert_eq!(groups, vec![65534]);
		assert!(!groups.contains(&0), "the dropped child must not retain root group 0");
		assert_eq!(lines.next(), None);
		fs::remove_dir_all(root).unwrap();
	}
}

#[cfg(all(test, windows))]
mod windows_tests {
	use std::{
		collections::{HashMap, HashSet},
		env,
		ffi::OsStr,
		fs,
		net::TcpStream,
		os::windows::ffi::OsStrExt,
		path::PathBuf,
		process::Command,
		ptr,
		sync::mpsc,
		thread,
		time::{Duration, Instant},
	};
	use windows_sys::Win32::{
		Foundation::{
			CloseHandle, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GetLastError, INVALID_HANDLE_VALUE,
		},
		Storage::FileSystem::{PIPE_ACCESS_DUPLEX, ReadFile, WriteFile},
		System::Pipes::{
			ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE, PIPE_WAIT,
		},
	};

	use super::{
		RetainedPostgres, interrupt_and_wait, retry_while_pipe_busy, spawn_retained_postgres,
		transact_named_pipe,
	};
	use crate::retained_postgres::RetainedPostgresSpawnOptions;

	#[test]
	fn accepted_windows_pipe_transaction_is_cancelled_at_the_shared_deadline() {
		let pipe_name: Vec<u16> =
			OsStr::new(&format!(r"\\.\pipe\atomic-retained-postgres-timeout-{}", std::process::id()))
				.encode_wide()
				.chain(Some(0))
				.collect();
		let server_name = pipe_name.clone();
		let (ready_tx, ready_rx) = mpsc::channel();
		let (release_tx, release_rx) = mpsc::channel();
		let (released_tx, released_rx) = mpsc::channel();
		let server = thread::spawn(move || {
			let pipe = unsafe {
				CreateNamedPipeW(
					server_name.as_ptr(),
					PIPE_ACCESS_DUPLEX,
					PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
					1,
					1,
					1,
					0,
					ptr::null(),
				)
			};
			assert_ne!(pipe, INVALID_HANDLE_VALUE);
			ready_tx.send(()).unwrap();
			let connected = unsafe { ConnectNamedPipe(pipe, ptr::null_mut()) };
			assert!(connected != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED);
			let mut signal = 0_u8;
			let mut bytes_read = 0_u32;
			assert_ne!(unsafe { ReadFile(pipe, &mut signal, 1, &mut bytes_read, ptr::null_mut()) }, 0);
			assert_eq!((bytes_read, signal), (1, 2));
			let released_before_fallback = release_rx.recv_timeout(Duration::from_millis(500)).is_ok();
			released_tx.send(released_before_fallback).unwrap();
			let mut bytes_written = 0_u32;
			unsafe {
				WriteFile(pipe, &signal, 1, &mut bytes_written, ptr::null_mut());
				CloseHandle(pipe);
			}
		});

		ready_rx.recv().unwrap();
		let started = Instant::now();
		let error =
			transact_named_pipe(&pipe_name, 2, started + Duration::from_millis(30)).unwrap_err();
		assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
		assert!(started.elapsed() < Duration::from_millis(250));
		let _ = release_tx.send(());
		assert!(released_rx.recv().unwrap(), "the timeout returned before the server acknowledged");
		server.join().unwrap();
	}

	#[test]
	fn pipe_busy_open_race_retries_without_resetting_the_deadline() {
		let deadline = Instant::now() + Duration::from_millis(100);
		let mut budgets = Vec::new();
		let value = retry_while_pipe_busy(deadline, |remaining_ms| {
			budgets.push(remaining_ms);
			if budgets.len() == 1 {
				thread::sleep(Duration::from_millis(10));
				return Err(std::io::Error::from_raw_os_error(ERROR_PIPE_BUSY as i32));
			}
			Ok(7_u8)
		})
		.unwrap();
		assert_eq!(value, 7);
		assert_eq!(budgets.len(), 2);
		assert!(budgets[1] < budgets[0], "the retry receives only the original deadline's remainder");

		let mut attempts = 0;
		let error =
			retry_while_pipe_busy::<()>(Instant::now() + Duration::from_millis(30), |_remaining_ms| {
				attempts += 1;
				thread::sleep(Duration::from_millis(40));
				Err(std::io::Error::from_raw_os_error(ERROR_PIPE_BUSY as i32))
			})
			.unwrap_err();
		assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
		assert_eq!(attempts, 1, "ERROR_PIPE_BUSY does not start a new deadline");
	}

	/// Locate the npm-distributed Windows Postgres binaries. Requires `npm ci`
	/// in the repository first; overridable via ATOMIC_EMBEDDED_POSTGRES_BIN_DIR.
	fn embedded_postgres_bin_dir() -> Option<PathBuf> {
		if let Some(dir) = env::var_os("ATOMIC_EMBEDDED_POSTGRES_BIN_DIR") {
			return Some(PathBuf::from(dir));
		}
		let mut current = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
		while let Some(dir) = current {
			let candidate = dir
				.join("node_modules")
				.join("@embedded-postgres")
				.join(format!(
					"windows-{}",
					if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
				))
				.join("native")
				.join("bin");
			if candidate.join("postgres.exe").exists() && candidate.join("initdb.exe").exists() {
				return Some(candidate);
			}
			current = dir.parent().map(PathBuf::from);
		}
		None
	}

	fn descendants_of(root_pid: u32) -> HashSet<u32> {
		use windows_sys::Win32::System::Diagnostics::ToolHelp::{
			CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
			TH32CS_SNAPPROCESS,
		};

		let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
		assert_ne!(snapshot, INVALID_HANDLE_VALUE);
		let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
		let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
		entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
		if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
			loop {
				children.entry(entry.th32ParentProcessID).or_default().push(entry.th32ProcessID);
				if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
					break;
				}
			}
		}
		unsafe { CloseHandle(snapshot) };
		let mut tree = HashSet::from([root_pid]);
		let mut pending = vec![root_pid];
		while let Some(pid) = pending.pop() {
			for &child in children.get(&pid).map(Vec::as_slice).unwrap_or_default() {
				if tree.insert(child) {
					pending.push(child);
				}
			}
		}
		tree
	}

	fn visible_top_level_window_pids() -> HashSet<u32> {
		use windows_sys::Win32::UI::WindowsAndMessaging::{
			EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
		};

		unsafe extern "system" fn collect(
			window: windows_sys::Win32::Foundation::HWND,
			state: windows_sys::Win32::Foundation::LPARAM,
		) -> windows_sys::core::BOOL {
			unsafe {
				if IsWindowVisible(window) != 0 {
					let mut pid = 0_u32;
					GetWindowThreadProcessId(window, &mut pid);
					if pid != 0 {
						(*(state as *mut HashSet<u32>)).insert(pid);
					}
				}
			}
			1
		}

		let mut pids = HashSet::new();
		unsafe {
			EnumWindows(Some(collect), ptr::from_mut(&mut pids) as isize);
		}
		pids
	}

	/// Postgres refuses to run for an effective member of Administrators
	/// (its `pgwin32_is_admin` check), so the end-to-end test only runs where
	/// a real launch is possible (regular user or a restricted token, as on
	/// any supported install).
	fn token_is_admin() -> bool {
		use windows_sys::Win32::Security::{
			AllocateAndInitializeSid, CheckTokenMembership, FreeSid, SECURITY_NT_AUTHORITY,
		};

		const SECURITY_BUILTIN_DOMAIN_RID: u32 = 0x20;
		const DOMAIN_ALIAS_RID_ADMINS: u32 = 0x220;
		let authority = SECURITY_NT_AUTHORITY;
		let mut admins_sid = ptr::null_mut();
		if unsafe {
			AllocateAndInitializeSid(
				&authority,
				2,
				SECURITY_BUILTIN_DOMAIN_RID,
				DOMAIN_ALIAS_RID_ADMINS,
				0,
				0,
				0,
				0,
				0,
				0,
				&mut admins_sid,
			)
		} == 0
		{
			return false;
		}
		let mut is_member = 0;
		let ok = unsafe { CheckTokenMembership(ptr::null_mut(), admins_sid, &mut is_member) };
		unsafe { FreeSid(admins_sid) };
		ok != 0 && is_member != 0
	}

	fn free_tcp_port() -> u16 {
		std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
	}

	/// Removes the temporary cluster directory even when the test panics.
	struct DirGuard(PathBuf);

	impl Drop for DirGuard {
		fn drop(&mut self) {
			fs::remove_dir_all(&self.0).ok();
		}
	}

	/// Shuts the retained postmaster down even when the test panics, since
	/// dropping the lease alone intentionally leaves the process running.
	struct LeaseGuard(Option<RetainedPostgres>);

	impl LeaseGuard {
		fn shutdown(mut self) -> bool {
			let state = &self.0.as_ref().unwrap().state;
			let exited = interrupt_and_wait(state, Duration::from_secs(60)).unwrap().exited;
			if exited {
				self.0.take();
			}
			exited
		}
	}

	impl Drop for LeaseGuard {
		fn drop(&mut self) {
			if let Some(lease) = self.0.take() {
				interrupt_and_wait(&lease.state, Duration::from_secs(60)).ok();
			}
		}
	}

	/// End-to-end regression test for visible console windows (issue #2670):
	/// initialize a real embedded Postgres cluster, start the postmaster through
	/// `spawnRetainedPostgres`, wait for readiness, then assert that neither the
	/// postmaster nor any descendant owns a visible top-level window.
	#[test]
	fn retained_postgres_tree_owns_no_visible_windows() {
		let Some(bin_dir) = embedded_postgres_bin_dir() else {
			eprintln!(
				"skipping retained_postgres_tree_owns_no_visible_windows: run `npm ci` first or set ATOMIC_EMBEDDED_POSTGRES_BIN_DIR"
			);
			return;
		};
		if token_is_admin() {
			eprintln!(
				"skipping retained_postgres_tree_owns_no_visible_windows: Postgres does not run for an Administrators member"
			);
			return;
		}
		let root = env::temp_dir().join(format!(
			"atomic-retained-postgres-windows-{}-{}",
			std::process::id(),
			std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
		));
		let _root_guard = DirGuard(root.clone());
		let data_dir = root.join("data");
		fs::create_dir_all(&data_dir).unwrap();
		let password_file = root.join("pw");
		fs::write(&password_file, "atomic\n").unwrap();
		let initdb = Command::new(bin_dir.join("initdb.exe"))
			.args([
				"-D",
				data_dir.to_str().unwrap(),
				"-U",
				"postgres",
				"-A",
				"password",
				&format!("--pwfile={}", password_file.display()),
				"-E",
				"UTF8",
				"--no-locale",
			])
			.output()
			.unwrap();
		assert!(
			initdb.status.success(),
			"initdb failed: {}",
			String::from_utf8_lossy(&initdb.stderr)
		);

		// The port is picked by binding an ephemeral listener and releasing it,
		// so another process can occasionally claim it before Postgres binds;
		// retry with a fresh port when Postgres reports a bind failure.
		let log_file = root.join("postgres.log");
		let mut attempt = 0;
		let guard = loop {
			attempt += 1;
			fs::remove_file(&log_file).ok();
			let port = free_tcp_port();
			let lease = spawn_retained_postgres(RetainedPostgresSpawnOptions {
				executable: bin_dir.join("postgres.exe").to_str().unwrap().to_owned(),
				args: vec![
					"-D".to_owned(),
					data_dir.to_str().unwrap().to_owned(),
					"-p".to_owned(),
					port.to_string(),
					"-c".to_owned(),
					"listen_addresses=127.0.0.1".to_owned(),
				],
				cwd: data_dir.to_str().unwrap().to_owned(),
				log_file: log_file.to_str().unwrap().to_owned(),
				env: None,
				uid: None,
				gid: None,
			})
			.unwrap();
			let guard = LeaseGuard(Some(lease));

			let deadline = Instant::now() + Duration::from_secs(60);
			let mut ready = false;
			while Instant::now() < deadline {
				if TcpStream::connect(("127.0.0.1", port)).is_ok() {
					ready = true;
					break;
				}
				if fs::read_to_string(&log_file)
					.unwrap_or_default()
					.contains("could not create any TCP/IP sockets")
				{
					break;
				}
				thread::sleep(Duration::from_millis(100));
			}
			if ready {
				break guard;
			}
			let log = fs::read_to_string(&log_file).unwrap_or_default();
			assert!(
				log.contains("could not create any TCP/IP sockets") && attempt < 5,
				"embedded Postgres never accepted connections (attempt {attempt}); log: {log}",
			);
		};
		let postmaster_pid = guard.0.as_ref().unwrap().pid().unwrap();

		// Sample repeatedly: postmaster children (checkpointer, walwriter, ...)
		// keep spawning shortly after readiness, and each visible console would
		// persist rather than flash.
		let mut offenders = HashSet::new();
		let mut tree = HashSet::new();
		for _sample in 0..10 {
			tree = descendants_of(postmaster_pid);
			offenders.extend(visible_top_level_window_pids().intersection(&tree).copied());
			thread::sleep(Duration::from_millis(300));
		}
		assert!(
			tree.len() > 1,
			"expected the postmaster to have descendant processes; tree: {tree:?}",
		);

		assert!(guard.shutdown());

		assert!(
			offenders.is_empty(),
			"PostgreSQL processes own visible top-level windows: {offenders:?}",
		);
	}
}
