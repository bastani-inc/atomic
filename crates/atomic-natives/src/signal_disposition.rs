//! Whether this process ignores a signal, as a process started under `nohup` ignores SIGHUP. Read before the runtime
//! installs a handler of its own for the signal, which replaces the inherited disposition.
use napi_derive::napi;

/// Whether this process ignores `signal`. `null` where signals have no dispositions (Windows) and for a number that
/// names no signal.
#[napi(js_name = "signalIgnored")]
pub fn signal_ignored(signal: i32) -> Option<bool> {
	ignored(signal)
}

#[cfg(unix)]
fn ignored(signal: i32) -> Option<bool> {
	let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
	(unsafe { libc::sigaction(signal, std::ptr::null(), &mut current) } == 0)
		.then_some(current.sa_sigaction == libc::SIG_IGN)
}

#[cfg(not(unix))]
fn ignored(_signal: i32) -> Option<bool> {
	None
}

#[cfg(all(test, unix))]
mod tests {
	use super::ignored;

	#[test]
	fn reports_an_ignored_signal_and_a_default_one() {
		let mut saved: libc::sigaction = unsafe { std::mem::zeroed() };
		let mut ignore: libc::sigaction = unsafe { std::mem::zeroed() };
		ignore.sa_sigaction = libc::SIG_IGN;
		let mut default: libc::sigaction = unsafe { std::mem::zeroed() };
		default.sa_sigaction = libc::SIG_DFL;
		assert_eq!(unsafe { libc::sigaction(libc::SIGUSR2, &ignore, &mut saved) }, 0);
		let when_ignored = ignored(libc::SIGUSR2);
		assert_eq!(unsafe { libc::sigaction(libc::SIGUSR2, &default, std::ptr::null_mut()) }, 0);
		let when_default = ignored(libc::SIGUSR2);
		unsafe { libc::sigaction(libc::SIGUSR2, &saved, std::ptr::null_mut()) };
		assert_eq!(when_ignored, Some(true));
		assert_eq!(when_default, Some(false));
	}

	#[test]
	fn names_no_disposition_for_a_number_that_is_no_signal() {
		assert_eq!(ignored(-1), None);
	}
}
