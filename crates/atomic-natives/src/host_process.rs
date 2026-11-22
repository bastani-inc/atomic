//! Processes the host starts for its own work, such as the Git commands of worktree snapshots. On Linux they start
//! without fork (see `crate::spawn`), so starting one costs the host's JavaScript thread the same at any memory size,
//! and a thread of their own moves their input and output and reaps them. On Windows a process starts suspended in a
//! job of its own, which holds it and every process it starts until the host ends them or lets them go (see
//! `windows`). Elsewhere `startHostProcess` refuses, and the host starts them through Node's `child_process` as before.
use napi::bindgen_prelude::{Buffer, Unknown};
use napi::threadsafe_function::ThreadsafeFunction;
#[cfg(target_os = "linux")]
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, Status};
use napi_derive::napi;
use std::collections::HashMap;

#[cfg(windows)]
mod windows;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(windows)]
use windows as platform;

/// Delivers a process's events to the host, keeping its event loop alive until the process has ended.
type EventCallback =
	ThreadsafeFunction<HostProcessEvent, Unknown<'static>, HostProcessEvent, Status, false>;

#[napi(object)]
pub struct HostProcessOptions {
	/// The program: a path, or a name looked up on the `PATH` of `env`.
	pub file: String,
	pub args: Vec<String>,
	pub cwd: Option<String>,
	/// The complete environment of the process.
	pub env: HashMap<String, String>,
	/// Which of standard input, output and error are pipes; the others are `/dev/null`.
	pub pipe_stdin: bool,
	pub pipe_stdout: bool,
	pub pipe_stderr: bool,
	/// Starts the process in a session of its own, as Node's `detached` does. Refused on Windows.
	pub detached: bool,
	/// Ends the process with `SIGKILL` when this process ends, however it ends; not the processes it starts. Not for a
	/// detached process.
	pub end_with_parent: Option<bool>,
	/// On Windows, the name of a pipe server the host listens on: each piped stream is a connection to it, which the
	/// host reads and writes itself. Required there when a stream is piped.
	pub pipe: Option<String>,
	/// Written first into each connection to `pipe`, followed by one byte, the stream's number (0 standard
	/// input, 1 output, 2 error), so the host knows its connections and which stream each is.
	pub pipe_prefix: Option<Buffer>,
}

#[napi(string_enum = "kebab-case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostProcessEventKind {
	Stdout,
	StdoutEnd,
	Stderr,
	StderrEnd,
	/// The process exited with `code`, or was ended by `signal`.
	Exit,
	/// Writing standard input failed with `errno`, such as `EPIPE` once the process stopped reading.
	StdinError,
}

#[napi(object)]
pub struct HostProcessEvent {
	pub kind: HostProcessEventKind,
	pub data: Option<Buffer>,
	/// The exit code; on Windows the process's whole 32-bit exit status, as `child_process` reports it.
	pub code: Option<i64>,
	pub signal: Option<i32>,
	pub errno: Option<String>,
}

#[cfg(any(target_os = "linux", windows))]
impl HostProcessEvent {
	fn of(kind: HostProcessEventKind) -> Self {
		Self { kind, data: None, code: None, signal: None, errno: None }
	}
}

/// A process the host started with [`start_host_process`].
#[napi]
pub struct HostProcess {
	pid: u32,
	#[cfg(any(target_os = "linux", windows))]
	shared: std::sync::Arc<platform::Shared>,
}

#[napi]
impl HostProcess {
	#[napi(getter)]
	pub fn pid(&self) -> u32 {
		self.pid
	}

	/// Queues `chunk` for the process's standard input. False once input can no longer be written: it was ended, or
	/// the process's output thread finished. On Windows always false: standard input is the host's connection.
	#[napi]
	pub fn write(&self, chunk: Buffer) -> bool {
		#[cfg(any(target_os = "linux", windows))]
		return self.shared.write(chunk.to_vec());
		#[cfg(not(any(target_os = "linux", windows)))]
		{
			let _ = chunk;
			false
		}
	}

	/// Closes standard input once everything queued was written. Nothing on Windows.
	#[napi]
	pub fn end(&self) {
		#[cfg(any(target_os = "linux", windows))]
		self.shared.end();
	}

	/// Sends `signal` to the process, or to its process group when `group` is true. False once the process was
	/// reaped, after its output ended and its exit was reported, as its ID may name another process by then, or when
	/// the signal could not be sent. On Windows, as `child_process` there, `SIGINT`, `SIGQUIT`, `SIGKILL` and `SIGTERM`
	/// end the process itself, and false once it exited.
	#[napi]
	pub fn kill(&self, signal: i32, group: bool) -> bool {
		#[cfg(any(target_os = "linux", windows))]
		return self.shared.kill(signal, group);
		#[cfg(not(any(target_os = "linux", windows)))]
		{
			let _ = (signal, group);
			false
		}
	}

	/// Keeps the host's event loop alive until the process has ended, which is the default.
	#[napi(js_name = "ref")]
	pub fn refer(&self, env: Env) -> napi::Result<()> {
		#[cfg(any(target_os = "linux", windows))]
		return self.shared.refer(&env, true);
		#[cfg(not(any(target_os = "linux", windows)))]
		{
			let _ = env;
			Ok(())
		}
	}

	/// Says the host has handled the process's `close`, after which it never signals it again: the process is reaped
	/// once it has exited and this was called, or the handle was dropped. On Windows nothing more is reported.
	#[napi]
	pub fn release(&self) {
		#[cfg(any(target_os = "linux", windows))]
		self.shared.release_by_host();
	}

	/// Ends the process and, while it runs, the processes below it, then every process in its job (Windows). False once
	/// the job was released, and elsewhere.
	#[napi(js_name = "endTree")]
	pub fn end_tree(&self) -> bool {
		#[cfg(windows)]
		return self.shared.end_tree();
		#[cfg(not(windows))]
		false
	}

	/// Lets the processes in its job run on (Windows): neither the job nor this process's exit ends them afterwards.
	#[napi(js_name = "releaseTree")]
	pub fn release_tree(&self) {
		#[cfg(windows)]
		self.shared.release_tree();
	}

	/// Lets the host's event loop end while the process runs.
	#[napi]
	pub fn unref(&self, env: Env) -> napi::Result<()> {
		#[cfg(any(target_os = "linux", windows))]
		return self.shared.refer(&env, false);
		#[cfg(not(any(target_os = "linux", windows)))]
		{
			let _ = env;
			Ok(())
		}
	}
}

#[cfg(any(target_os = "linux", windows))]
impl Drop for HostProcess {
	fn drop(&mut self) {
		self.shared.release_by_host();
	}
}

/// Starts `options.file`, delivering its output, its end and its exit to `on_event` in the order they happened. A
/// failure to start it throws with the errno name (`ENOENT`, `EACCES`, ...) as the error's code. On Windows the
/// process starts suspended in a job of its own, its piped streams are connections to the host's pipe server
/// `options.pipe`, and `on_event` gets only its exit; a start that cannot put it in the job or connect its streams
/// throws `ENOTSUP` before the program ran. Off Linux and Windows it always refuses with `ENOSYS`.
#[napi(js_name = "startHostProcess")]
pub fn start_host_process(
	options: HostProcessOptions,
	#[napi(ts_arg_type = "(event: HostProcessEvent) => void")] on_event: EventCallback,
) -> napi::Result<HostProcess, String> {
	#[cfg(any(target_os = "linux", windows))]
	return platform::start(options, on_event);
	#[cfg(not(any(target_os = "linux", windows)))]
	{
		let _ = (options, on_event);
		Err(napi::Error::new("ENOSYS".to_string(), "host processes start through child_process here"))
	}
}

/// The name Node gives `errno`, for the error codes a start can fail with.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn errno_name(errno: i32) -> String {
	let name = match errno {
		libc::ENOENT => "ENOENT",
		libc::EACCES => "EACCES",
		libc::ENOTDIR => "ENOTDIR",
		libc::EPERM => "EPERM",
		libc::EAGAIN => "EAGAIN",
		libc::EMFILE => "EMFILE",
		libc::ENFILE => "ENFILE",
		libc::ENOMEM => "ENOMEM",
		libc::E2BIG => "E2BIG",
		libc::EINVAL => "EINVAL",
		libc::ENOEXEC => "ENOEXEC",
		libc::ELOOP => "ELOOP",
		libc::ENAMETOOLONG => "ENAMETOOLONG",
		libc::ETXTBSY => "ETXTBSY",
		libc::EISDIR => "EISDIR",
		libc::EPIPE => "EPIPE",
		libc::EIO => "EIO",
		_ => return format!("E{errno}"),
	};
	name.into()
}

#[cfg(target_os = "linux")]
mod linux {
	use super::*;
	use crate::spawn::{SignalDefaults, SpawnRequest, SpawnedChild, spawn};
	use std::collections::VecDeque;
	use std::ffi::OsString;
	use std::fs::File;
	use std::io::{self, Read, Write};
	use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
	use std::path::PathBuf;
	use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
	use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

	/// How long the output thread waits between checks for the exit where the kernel has no process file
	/// descriptors (before Linux 5.3).
	const EXIT_POLL_MS: libc::c_int = 20;
	const READ_CHUNK_BYTES: usize = 64 * 1024;

	struct Input {
		chunks: VecDeque<Vec<u8>>,
		ended: bool,
		/// Set once standard input is closed: nothing more is accepted.
		closed: bool,
	}

	/// What the host and the process's output thread share.
	///
	/// The process is reaped only once it exited, both output pipes reached their end, and the host handled its
	/// `close` (or dropped the handle): until then its ID, and the ID of its process group, cannot name another
	/// process, so a signal the host sends before `close`, to the process or to its group, can only reach what it
	/// started.
	pub(super) struct Shared {
		pid: libc::pid_t,
		input: Mutex<Input>,
		/// Wakes the output thread for queued input; an eventfd.
		wake: OwnedFd,
		reaped: AtomicBool,
		exit_sent: AtomicBool,
		stdout_open: AtomicBool,
		stderr_open: AtomicBool,
		pidfd: Option<OwnedFd>,
		callback: Mutex<Option<Sink>>,
		/// Whether the host released the process (after its `close`, or by dropping the handle) and whether the
		/// output thread finished with it: the second of the two reaps it.
		host_released: AtomicBool,
		releases: AtomicU8,
	}

	/// Where a process's events go: the host's callback, or a test's channel.
	pub(super) enum Sink {
		Host(EventCallback),
		#[cfg(test)]
		Probe(std::sync::mpsc::Sender<HostProcessEvent>),
	}

	fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
		mutex.lock().unwrap_or_else(PoisonError::into_inner)
	}

	impl Shared {
		fn notify(&self) {
			let one = 1u64.to_ne_bytes();
			let _ = unsafe { libc::write(self.wake.as_raw_fd(), one.as_ptr().cast(), one.len()) };
		}
		pub(super) fn write(&self, chunk: Vec<u8>) -> bool {
			let mut input = locked(&self.input);
			if input.ended || input.closed {
				return false;
			}
			input.chunks.push_back(chunk);
			drop(input);
			self.notify();
			true
		}
		pub(super) fn end(&self) {
			locked(&self.input).ended = true;
			self.notify();
		}
		/// Signals the process, or its group, only while it is unreaped: a reaped process's ID may name another one.
		pub(super) fn kill(&self, signal: i32, group: bool) -> bool {
			if self.reaped.load(Ordering::Acquire) {
				return false;
			}
			if group {
				return unsafe { libc::kill(-self.pid, signal) } == 0;
			}
			let sent = match &self.pidfd {
				Some(pidfd) => unsafe {
					libc::syscall(
						libc::SYS_pidfd_send_signal,
						pidfd.as_raw_fd(),
						signal,
						std::ptr::null::<libc::siginfo_t>(),
						0,
					)
				},
				None => unsafe { libc::kill(self.pid, signal) }.into(),
			};
			sent == 0
		}
		#[allow(deprecated)]
		pub(super) fn refer(&self, env: &Env, keep_alive: bool) -> napi::Result<()> {
			if let Some(Sink::Host(callback)) = locked(&self.callback).as_mut() {
				if keep_alive {
					callback.refer(env)?;
				} else {
					callback.unref(env)?;
				}
			}
			Ok(())
		}
		fn emit(&self, event: HostProcessEvent) {
			match event.kind {
				HostProcessEventKind::StdoutEnd => self.stdout_open.store(false, Ordering::Release),
				HostProcessEventKind::StderrEnd => self.stderr_open.store(false, Ordering::Release),
				HostProcessEventKind::Exit => self.exit_sent.store(true, Ordering::Release),
				_ => {},
			}
			match locked(&self.callback).as_ref() {
				Some(Sink::Host(callback)) => {
					callback.call(event, ThreadsafeFunctionCallMode::NonBlocking);
				},
				#[cfg(test)]
				Some(Sink::Probe(probe)) => {
					let _ = probe.send(event);
				},
				None => {},
			}
		}
		fn emit_exit(&self, status: ExitStatus) {
			self.emit(HostProcessEvent {
				code: status.code.map(i64::from),
				signal: status.signal,
				..HostProcessEvent::of(HostProcessEventKind::Exit)
			});
		}
		/// The output thread's last step, once it reported the exit and the end of the output: lets the host's event
		/// loop end, and reaps the process if the host already released it.
		fn finish(&self) {
			locked(&self.input).closed = true;
			drop(locked(&self.callback).take());
			self.release();
		}
		pub(super) fn release_by_host(&self) {
			if !self.host_released.swap(true, Ordering::AcqRel) {
				self.release();
			}
		}
		/// The second release reaps the process, which has exited by then: the output thread releases it only after
		/// reporting its exit.
		fn release(&self) {
			if self.releases.fetch_add(1, Ordering::AcqRel) == 1 {
				let _ = SpawnedChild::new(self.pid).wait();
				self.reaped.store(true, Ordering::Release);
			}
		}
	}

	#[derive(Clone, Copy)]
	struct ExitStatus {
		code: Option<i32>,
		signal: Option<i32>,
	}

	/// The exit of `pid`, if it has exited, read without reaping it.
	fn exited(pid: libc::pid_t) -> Option<ExitStatus> {
		let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
		loop {
			let read = unsafe {
				libc::waitid(
					libc::P_PID,
					pid as libc::id_t,
					&mut info,
					libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
				)
			};
			if read == 0 {
				break;
			}
			if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
				return None;
			}
		}
		if unsafe { info.si_pid() } == 0 {
			return None;
		}
		let status = unsafe { info.si_status() };
		Some(if info.si_code == libc::CLD_EXITED {
			ExitStatus { code: Some(status), signal: None }
		} else {
			ExitStatus { code: None, signal: Some(status) }
		})
	}

	fn to_error(error: io::Error) -> napi::Error<String> {
		let code = error.raw_os_error().map_or_else(|| "EIO".to_string(), errno_name);
		napi::Error::new(code, error.to_string())
	}

	fn null_device(write: bool) -> io::Result<File> {
		std::fs::OpenOptions::new().read(!write).write(write).open("/dev/null")
	}

	fn pidfd_open(pid: libc::pid_t) -> Option<OwnedFd> {
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
		(fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
	}

	pub(super) fn start(
		options: HostProcessOptions,
		on_event: EventCallback,
	) -> napi::Result<HostProcess, String> {
		let cwd = options.cwd.map(PathBuf::from);
		let env =
			options.env.into_iter().map(|(key, value)| (OsString::from(key), OsString::from(value)));
		let request = SpawnRequest::new(
			OsString::from(&options.file).as_os_str(),
			options.args.into_iter().map(OsString::from),
			env,
			cwd.as_deref(),
			options.detached,
			SignalDefaults::All,
		)
		.map_err(to_error)?;
		let request = if options.end_with_parent == Some(true) && !options.detached {
			request.ending_with_parent()
		} else {
			request
		};
		let pipe = |piped: bool, write: bool| -> io::Result<(OwnedFd, Option<File>)> {
			if !piped {
				return Ok((OwnedFd::from(null_device(write)?), None));
			}
			let mut fds = [0 as RawFd; 2];
			if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
				return Err(io::Error::last_os_error());
			}
			let (read, written) =
				unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
			// `write`: the child writes, so it gets the write end.
			Ok(if write {
				(written, Some(File::from(read)))
			} else {
				(read, Some(File::from(written)))
			})
		};
		let (stdin_child, stdin) = pipe(options.pipe_stdin, false).map_err(to_error)?;
		let (stdout_child, stdout) = pipe(options.pipe_stdout, true).map_err(to_error)?;
		let (stderr_child, stderr) = pipe(options.pipe_stderr, true).map_err(to_error)?;
		let wake = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
		if wake < 0 {
			return Err(to_error(io::Error::last_os_error()));
		}
		let wake = unsafe { OwnedFd::from_raw_fd(wake) };
		let pid = spawn(
			&request,
			[stdin_child.as_raw_fd(), stdout_child.as_raw_fd(), stderr_child.as_raw_fd()],
			None,
		)
		.map_err(to_error)?;
		drop((stdin_child, stdout_child, stderr_child));
		let shared = Arc::new(Shared {
			pid,
			input: Mutex::new(Input {
				chunks: VecDeque::new(),
				ended: false,
				closed: stdin.is_none(),
			}),
			wake,
			reaped: AtomicBool::new(false),
			exit_sent: AtomicBool::new(false),
			stdout_open: AtomicBool::new(stdout.is_some()),
			stderr_open: AtomicBool::new(stderr.is_some()),
			pidfd: pidfd_open(pid),
			callback: Mutex::new(Some(Sink::Host(on_event))),
			host_released: AtomicBool::new(false),
			releases: AtomicU8::new(0),
		});
		let worker = shared.clone();
		let started = std::thread::Builder::new()
			.name("host-process".into())
			.spawn(move || output_thread(&worker, |shared| supervise(stdin, stdout, stderr, shared)));
		if let Err(error) = started {
			// No thread can reap it: end and reap it here rather than leave it running unowned.
			let mut child = SpawnedChild::new(pid);
			let _ = child.kill(libc::SIGKILL);
			let _ = child.wait();
			return Err(to_error(error));
		}
		Ok(HostProcess { pid: pid as u32, shared })
	}

	/// The output thread: `work` moves the process's input and output to its end; if it panics, [`recover`] still ends,
	/// reports and releases the process.
	fn output_thread(shared: &Shared, work: impl FnOnce(&Shared)) {
		let worked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(shared)));
		if worked.is_err() {
			recover(shared);
		}
	}

	/// After the output thread failed: ends the process if it still runs, reports what the host has not been told,
	/// its exit and the end of its output, and finishes, so the host sees `close` and nothing is left running.
	fn recover(shared: &Shared) {
		if !shared.exit_sent.load(Ordering::Acquire) {
			let _ = shared.kill(libc::SIGKILL, false);
			let status = loop {
				if let Some(status) = exited(shared.pid) {
					break Some(status);
				}
				let mut poll = libc::pollfd {
					fd: shared.pidfd.as_ref().map_or(-1, AsRawFd::as_raw_fd),
					events: libc::POLLIN,
					revents: 0,
				};
				if unsafe { libc::poll(&mut poll, 1, EXIT_POLL_MS) } < 0
					&& io::Error::last_os_error().raw_os_error() != Some(libc::EINTR)
				{
					break None;
				}
			};
			shared.emit_exit(status.unwrap_or(ExitStatus { code: None, signal: Some(libc::SIGKILL) }));
		}
		if shared.stdout_open.load(Ordering::Acquire) {
			shared.emit(HostProcessEvent::of(HostProcessEventKind::StdoutEnd));
		}
		if shared.stderr_open.load(Ordering::Acquire) {
			shared.emit(HostProcessEvent::of(HostProcessEventKind::StderrEnd));
		}
		shared.finish();
	}

	fn set_nonblocking(file: &File) {
		let fd = file.as_raw_fd();
		unsafe {
			let flags = libc::fcntl(fd, libc::F_GETFL);
			if flags >= 0 {
				libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
			}
		}
	}

	/// Moves input and output until the process exited and both output pipes reached their end.
	fn supervise(
		mut stdin: Option<File>,
		mut stdout: Option<File>,
		mut stderr: Option<File>,
		shared: &Shared,
	) {
		// A write to a pipe the process closed must fail with EPIPE here, not raise SIGPIPE in the host.
		unsafe {
			let mut pipe_signal: libc::sigset_t = std::mem::zeroed();
			libc::sigemptyset(&mut pipe_signal);
			libc::sigaddset(&mut pipe_signal, libc::SIGPIPE);
			libc::pthread_sigmask(libc::SIG_BLOCK, &pipe_signal, std::ptr::null_mut());
		}
		for file in [&stdin, &stdout, &stderr].into_iter().flatten() {
			set_nonblocking(file);
		}
		let mut pending: Option<(Vec<u8>, usize)> = None;
		let mut has_exited = false;
		let mut buffer = vec![0u8; READ_CHUNK_BYTES];
		loop {
			// Take queued input, and close standard input once it was ended and everything was written.
			if stdin.is_some() {
				let mut input = locked(&shared.input);
				if pending.is_none() {
					pending = input.chunks.pop_front().map(|chunk| (chunk, 0));
				}
				if pending.is_none() && input.ended {
					input.closed = true;
					stdin = None;
				}
			}
			if has_exited && stdout.is_none() && stderr.is_none() {
				break;
			}
			let mut fds = Vec::with_capacity(5);
			fds.push(libc::pollfd { fd: shared.wake.as_raw_fd(), events: libc::POLLIN, revents: 0 });
			for file in [&stdout, &stderr] {
				fds.push(libc::pollfd {
					fd: file.as_ref().map_or(-1, AsRawFd::as_raw_fd),
					events: libc::POLLIN,
					revents: 0,
				});
			}
			fds.push(libc::pollfd {
				fd: match (&stdin, &pending) {
					(Some(file), Some(_)) => file.as_raw_fd(),
					_ => -1,
				},
				events: libc::POLLOUT,
				revents: 0,
			});
			fds.push(libc::pollfd {
				fd: match (&shared.pidfd, has_exited) {
					(Some(pidfd), false) => pidfd.as_raw_fd(),
					_ => -1,
				},
				events: libc::POLLIN,
				revents: 0,
			});
			let timeout = if has_exited || shared.pidfd.is_some() { -1 } else { EXIT_POLL_MS };
			let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
			if ready < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
				panic!("polling a host process failed: {}", io::Error::last_os_error());
			}
			if fds[0].revents != 0 {
				let mut count = [0u8; 8];
				let _ = unsafe {
					libc::read(shared.wake.as_raw_fd(), count.as_mut_ptr().cast(), count.len())
				};
			}
			for (index, (stream, kind, end)) in [
				(&mut stdout, HostProcessEventKind::Stdout, HostProcessEventKind::StdoutEnd),
				(&mut stderr, HostProcessEventKind::Stderr, HostProcessEventKind::StderrEnd),
			]
			.into_iter()
			.enumerate()
			{
				if fds[index + 1].revents == 0 {
					continue;
				}
				let Some(file) = stream.as_mut() else { continue };
				match file.read(&mut buffer) {
					Ok(0) => {
						*stream = None;
						shared.emit(HostProcessEvent::of(end));
					},
					Ok(count) => shared.emit(HostProcessEvent {
						data: Some(Buffer::from(buffer[..count].to_vec())),
						..HostProcessEvent::of(kind)
					}),
					Err(error)
						if matches!(
							error.kind(),
							io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
						) => {},
					Err(_) => {
						*stream = None;
						shared.emit(HostProcessEvent::of(end));
					},
				}
			}
			if fds[3].revents != 0
				&& let (Some(file), Some((chunk, written))) = (stdin.as_mut(), pending.as_mut())
			{
				match file.write(&chunk[*written..]) {
					Ok(count) => {
						*written += count;
						if *written == chunk.len() {
							pending = None;
						}
					},
					Err(error)
						if matches!(
							error.kind(),
							io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
						) => {},
					Err(error) => {
						pending = None;
						let mut input = locked(&shared.input);
						input.chunks.clear();
						input.closed = true;
						drop(input);
						stdin = None;
						shared.emit(HostProcessEvent {
							errno: Some(error.raw_os_error().map_or_else(|| "EIO".into(), errno_name)),
							..HostProcessEvent::of(HostProcessEventKind::StdinError)
						});
					},
				}
			}
			if !has_exited
				&& (fds[4].revents != 0 || shared.pidfd.is_none())
				&& let Some(status) = exited(shared.pid)
			{
				has_exited = true;
				shared.emit_exit(status);
			}
		}
		drop(stdin);
		shared.finish();
	}

	#[cfg(test)]
	mod tests {
		use super::*;
		use std::sync::mpsc;

		/// A `sleep` started as the host starts processes, with output pipes it never closes, and its shared state
		/// reporting to a channel.
		fn sleeping() -> (Arc<Shared>, mpsc::Receiver<HostProcessEvent>) {
			let request = SpawnRequest::new(
				std::ffi::OsStr::new("sleep"),
				[OsString::from("30")],
				crate::spawn::child_environment(true, []),
				None,
				false,
				SignalDefaults::All,
			)
			.unwrap();
			let pipes = crate::spawn::stdio_pipes().unwrap();
			let pid = spawn(
				&request,
				[pipes.child[0].as_raw_fd(), pipes.child[1].as_raw_fd(), pipes.child[2].as_raw_fd()],
				None,
			)
			.unwrap();
			std::mem::forget(pipes);
			let (sender, receiver) = mpsc::channel();
			let shared = Arc::new(Shared {
				pid,
				input: Mutex::new(Input { chunks: VecDeque::new(), ended: false, closed: false }),
				wake: unsafe { OwnedFd::from_raw_fd(libc::eventfd(0, libc::EFD_CLOEXEC)) },
				reaped: AtomicBool::new(false),
				exit_sent: AtomicBool::new(false),
				stdout_open: AtomicBool::new(true),
				stderr_open: AtomicBool::new(true),
				pidfd: pidfd_open(pid),
				callback: Mutex::new(Some(Sink::Probe(sender))),
				host_released: AtomicBool::new(false),
				releases: AtomicU8::new(0),
			});
			(shared, receiver)
		}

		fn running(pid: libc::pid_t) -> bool {
			unsafe { libc::kill(pid, 0) == 0 }
		}

		#[test]
		fn an_output_thread_that_panics_still_ends_reports_and_reaps_its_process() {
			let (shared, events) = sleeping();
			let worker = shared.clone();
			let thread = std::thread::spawn(move || {
				output_thread(&worker, |_| panic!("an output thread failed"));
			});
			assert!(thread.join().is_ok(), "the panic does not end the thread unhandled");
			let events: Vec<HostProcessEvent> = events.try_iter().collect();
			assert_eq!(
				events.iter().map(|event| &event.kind).collect::<Vec<_>>(),
				[
					&HostProcessEventKind::Exit,
					&HostProcessEventKind::StdoutEnd,
					&HostProcessEventKind::StderrEnd
				]
			);
			assert_eq!(events[0].signal, Some(libc::SIGKILL), "the process that still ran was killed");
			assert!(running(shared.pid), "the process stays unreaped until the host released it");
			shared.release_by_host();
			assert!(!running(shared.pid), "the host's release reaped it");
			assert!(!shared.kill(libc::SIGKILL, false), "a reaped process is not signalled");
		}
	}
}
