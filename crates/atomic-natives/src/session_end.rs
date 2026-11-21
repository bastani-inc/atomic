//! The end of the user's Windows session: sign-out, restart or shutdown, or an installer asking programs to close.
//! Windows asks each top-level window whether the session may end (`WM_QUERYENDSESSION`), tells it whether it does
//! (`WM_ENDSESSION`), and then ends every process of the session. A console program that loaded user32, as Node and
//! Bun do, gets no console event for it, so [`watch_session_end`] gives the process a hidden top-level window, on a
//! thread of its own, that hears it.
use napi::Status;
use napi::bindgen_prelude::ToNapiValue;
use napi::sys;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use std::time::Instant;

/// When Windows said the session ends. The callback gets the milliseconds since, read from the monotonic clock as it
/// is called, so however late it runs and however the wall clock moves, it knows how much of Windows's wait is left.
pub struct SessionEnded(Instant);

impl ToNapiValue for SessionEnded {
	unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> napi::Result<sys::napi_value> {
		unsafe { f64::to_napi_value(env, value.0.elapsed().as_secs_f64() * 1_000.0) }
	}
}

/// Told how long ago the session ended, and answers whether the process shuts down for it. Weak: it never keeps the
/// event loop alive.
type SessionEndCallback = ThreadsafeFunction<SessionEnded, bool, SessionEnded, Status, false, true>;

/// The longest the window holds Windows's notice that the session ends, while the process shuts down: Windows lists a
/// program that takes 5 seconds as one keeping the user from signing out.
#[cfg_attr(not(windows), allow(dead_code))]
const HOLD_MS: u64 = 4_500;

/// On Windows, calls back when the user's session ends, and keeps Windows waiting while the process shuts down: until
/// the callback answers false, the process exits, or 4.5 seconds have passed. A sign-out that another program cancels
/// calls nothing. Windows also ends the process before the programs it started, so they still run while it shuts down.
/// The window is made on a thread of its own, without waiting for it; only the first call in a process starts one.
/// Elsewhere it does nothing.
#[napi(js_name = "watchSessionEnd")]
pub fn watch_session_end(
	#[napi(ts_arg_type = "(endedMsAgo: number) => boolean")] on_end: SessionEndCallback,
) {
	#[cfg(windows)]
	windows::watch(on_end);
	#[cfg(not(windows))]
	let _ = on_end;
}

#[cfg(windows)]
mod windows {
	use super::{HOLD_MS, SessionEndCallback, SessionEnded};
	use napi::Status;
	use napi::threadsafe_function::ThreadsafeFunctionCallMode;
	use std::sync::{OnceLock, mpsc};
	use std::time::{Duration, Instant};
	use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
	use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
	use windows_sys::Win32::System::Threading::{
		GetProcessShutdownParameters, SetProcessShutdownParameters,
	};
	use windows_sys::Win32::UI::WindowsAndMessaging::{
		CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, RegisterClassExW,
		WM_CLOSE, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSEXW, WS_OVERLAPPED,
	};

	/// Above the default 0x280 of every other program, so Windows ends this process before the ones it started.
	/// 0x300 is the first value of the range Windows keeps for programs that end first.
	const SHUTDOWN_LEVEL: u32 = 0x300;
	const CLASS_NAME: &str = "AtomicSessionEnd";
	const WINDOW_TITLE: &str = "Atomic";

	static CALLBACK: OnceLock<SessionEndCallback> = OnceLock::new();

	pub(super) fn watch(on_end: SessionEndCallback) {
		if CALLBACK.set(on_end).is_err() {
			return;
		}
		let _ = std::thread::Builder::new().name("session-end".into()).spawn(|| {
			if !create_window().is_null() {
				end_before_children();
				pump();
			}
		});
	}

	fn wide(text: &str) -> Vec<u16> {
		text.encode_utf16().chain(Some(0)).collect()
	}

	/// Raises the process's shutdown level to [`SHUTDOWN_LEVEL`] unless it is already higher, keeping its flags.
	fn end_before_children() {
		let (mut level, mut flags) = (0u32, 0u32);
		if unsafe { GetProcessShutdownParameters(&mut level, &mut flags) } != 0
			&& level < SHUTDOWN_LEVEL
		{
			unsafe { SetProcessShutdownParameters(SHUTDOWN_LEVEL, flags) };
		}
	}

	/// A top-level window, as only those hear the end of the session (a message-only window does not), that is never
	/// shown: it has no taskbar button, no Alt+Tab entry and never takes the focus.
	fn create_window() -> HWND {
		let class = wide(CLASS_NAME);
		let title = wide(WINDOW_TITLE);
		let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
		let class_info = WNDCLASSEXW {
			cbSize: size_of::<WNDCLASSEXW>() as u32,
			lpfnWndProc: Some(window_procedure),
			hInstance: instance,
			lpszClassName: class.as_ptr(),
			..Default::default()
		};
		if unsafe { RegisterClassExW(&class_info) } == 0 {
			return std::ptr::null_mut();
		}
		unsafe {
			CreateWindowExW(
				0,
				class.as_ptr(),
				title.as_ptr(),
				WS_OVERLAPPED,
				0,
				0,
				0,
				0,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				instance,
				std::ptr::null(),
			)
		}
	}

	/// Handles the window's messages for the rest of the process's life. Windows sends the session's messages
	/// directly to the window procedure while the thread waits here; nothing wakes it otherwise.
	fn pump() {
		let mut message = MSG::default();
		while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
			unsafe { DispatchMessageW(&message) };
		}
	}

	unsafe extern "system" fn window_procedure(
		window: HWND,
		message: u32,
		wparam: WPARAM,
		lparam: LPARAM,
	) -> LRESULT {
		match message {
			// The session may end. Nothing happens until Windows says it does: another program can still cancel it.
			WM_QUERYENDSESSION => 1,
			WM_ENDSESSION => {
				if wparam != 0 {
					session_ends();
				}
				0
			},
			// The window stays for the life of the process.
			WM_CLOSE => 0,
			_ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
		}
	}

	/// Tells the process the session ends, and holds Windows's notice while it shuts down: Windows ends the process
	/// once the window returns. The process's exit ends this thread too.
	fn session_ends() {
		let Some(callback) = CALLBACK.get() else { return };
		let ended = Instant::now();
		let deadline = ended + Duration::from_millis(HOLD_MS);
		let (answered, answer) = mpsc::channel();
		let status = callback.call_with_return_value(
			SessionEnded(ended),
			ThreadsafeFunctionCallMode::NonBlocking,
			move |shutting_down, _| {
				let _ = answered.send(matches!(shutting_down, Ok(true)));
				Ok(())
			},
		);
		if status != Status::Ok {
			return;
		}
		if answer.recv_timeout(deadline.saturating_duration_since(Instant::now())) == Ok(true) {
			std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
		}
	}
}
