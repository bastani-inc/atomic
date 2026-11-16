use napi_derive::napi;

#[napi(object)]
pub struct WindowsAccessRule {
	pub allow: bool,
	pub sid: String,
}

#[napi(object)]
pub struct WindowsDirectorySecurity {
	#[napi(js_name = "currentSid")]
	pub current_sid: String,
	#[napi(js_name = "ownerSid")]
	pub owner_sid: String,
	pub dacl: String,
	#[napi(js_name = "accessRules")]
	pub access_rules: Vec<WindowsAccessRule>,
}

#[napi(js_name = "windowsDirectorySecurity")]
pub fn windows_directory_security(path: String) -> Option<WindowsDirectorySecurity> {
	read_directory_security(&path)
}

#[cfg(windows)]
fn read_directory_security(path: &str) -> Option<WindowsDirectorySecurity> {
	use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};
	use windows_sys::Win32::{
		Foundation::ERROR_SUCCESS,
		Security::{
			ACL,
			Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
			DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
		},
	};
	let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect();
	if wide[..wide.len() - 1].contains(&0) {
		return None;
	}
	let mut owner: PSID = ptr::null_mut();
	let mut dacl: *mut ACL = ptr::null_mut();
	let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
	let status = unsafe {
		GetNamedSecurityInfoW(
			wide.as_ptr(),
			SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
			&mut owner,
			ptr::null_mut(),
			&mut dacl,
			ptr::null_mut(),
			&mut descriptor,
		)
	};
	if status != ERROR_SUCCESS || descriptor.is_null() {
		return None;
	}
	let descriptor = windows::LocalAllocation(descriptor);
	Some(WindowsDirectorySecurity {
		current_sid: windows::current_user_sid()?,
		owner_sid: windows::sid_string(owner)?,
		dacl: if dacl.is_null() { String::new() } else { windows::dacl_sddl(descriptor.0)? },
		access_rules: windows::access_rules(dacl)?,
	})
}

#[cfg(not(windows))]
fn read_directory_security(_path: &str) -> Option<WindowsDirectorySecurity> {
	None
}

#[cfg(windows)]
mod windows {
	use std::{ffi::c_void, ptr};

	use windows_sys::Win32::{
		Foundation::{CloseHandle, HANDLE, LocalFree},
		Security::{
			ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
			Authorization::{
				ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
				SDDL_REVISION_1,
			},
			DACL_SECURITY_INFORMATION, GetAce, GetTokenInformation, PSECURITY_DESCRIPTOR, PSID,
			TOKEN_QUERY, TOKEN_USER, TokenUser,
		},
		System::Threading::{GetCurrentProcess, OpenProcessToken},
	};

	use super::WindowsAccessRule;

	const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
	const ACCESS_DENIED_ACE_TYPE: u8 = 1;

	pub(super) struct LocalAllocation(pub(super) *mut c_void);

	impl Drop for LocalAllocation {
		fn drop(&mut self) {
			unsafe { LocalFree(self.0) };
		}
	}

	struct OwnedHandle(HANDLE);

	impl Drop for OwnedHandle {
		fn drop(&mut self) {
			unsafe { CloseHandle(self.0) };
		}
	}

	fn take_local_string(text: *mut u16) -> Option<String> {
		if text.is_null() {
			return None;
		}
		let allocation = LocalAllocation(text.cast());
		let mut length = 0;
		while unsafe { *text.add(length) } != 0 {
			length += 1;
		}
		let units = unsafe { std::slice::from_raw_parts(allocation.0.cast::<u16>(), length) };
		String::from_utf16(units).ok()
	}

	pub(super) fn sid_string(sid: PSID) -> Option<String> {
		if sid.is_null() {
			return None;
		}
		let mut text = ptr::null_mut();
		if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
			return None;
		}
		take_local_string(text)
	}

	pub(super) fn dacl_sddl(descriptor: PSECURITY_DESCRIPTOR) -> Option<String> {
		let mut text = ptr::null_mut();
		let mut length = 0;
		let converted = unsafe {
			ConvertSecurityDescriptorToStringSecurityDescriptorW(
				descriptor,
				SDDL_REVISION_1,
				DACL_SECURITY_INFORMATION,
				&mut text,
				&mut length,
			)
		};
		if converted == 0 {
			return None;
		}
		take_local_string(text)
	}

	pub(super) fn access_rules(dacl: *mut ACL) -> Option<Vec<WindowsAccessRule>> {
		if dacl.is_null() {
			return Some(Vec::new());
		}
		let count = unsafe { (*dacl).AceCount };
		let mut rules = Vec::with_capacity(usize::from(count));
		for index in 0..u32::from(count) {
			let mut ace: *mut c_void = ptr::null_mut();
			if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
				return None;
			}
			let allow = match unsafe { (*ace.cast::<ACE_HEADER>()).AceType } {
				ACCESS_ALLOWED_ACE_TYPE => true,
				ACCESS_DENIED_ACE_TYPE => false,
				_ => continue,
			};
			let sid = unsafe { ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart) };
			rules.push(WindowsAccessRule { allow, sid: sid_string(sid.cast())? });
		}
		Some(rules)
	}

	pub(super) fn current_user_sid() -> Option<String> {
		let mut token: HANDLE = ptr::null_mut();
		if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
			return None;
		}
		let token = OwnedHandle(token);
		let mut needed = 0u32;
		unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed) };
		if needed == 0 {
			return None;
		}
		let mut buffer = vec![0u64; (needed as usize).div_ceil(std::mem::size_of::<u64>())];
		let read = unsafe {
			GetTokenInformation(token.0, TokenUser, buffer.as_mut_ptr().cast(), needed, &mut needed)
		};
		if read == 0 {
			return None;
		}
		let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
		sid_string(user.User.Sid)
	}
}

#[cfg(test)]
mod tests {
	use super::windows_directory_security;

	#[cfg(windows)]
	#[test]
	fn reads_an_owned_directory_and_nothing_for_a_missing_one() {
		let dir =
			std::env::temp_dir().join(format!("atomic-natives-security-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let security = windows_directory_security(dir.to_string_lossy().into_owned())
			.expect("a readable descriptor");
		std::fs::remove_dir_all(&dir).unwrap();
		assert!(security.current_sid.starts_with("S-1-"), "{}", security.current_sid);
		assert!(security.owner_sid.starts_with("S-1-"), "{}", security.owner_sid);
		assert!(security.dacl.starts_with("D:"), "{}", security.dacl);
		assert!(!security.access_rules.is_empty());
		assert!(security.access_rules.iter().all(|rule| rule.sid.starts_with("S-1-")));
		assert!(windows_directory_security(dir.to_string_lossy().into_owned()).is_none());
	}

	#[cfg(not(windows))]
	#[test]
	fn reads_nothing_off_windows() {
		assert!(
			windows_directory_security(std::env::temp_dir().to_string_lossy().into_owned()).is_none()
		);
	}
}
