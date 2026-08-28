const STRUCT_CODEGEN: &str =
	include_str!("../../../third_party/napi-derive-backend/src/codegen/struct.rs");
const FN_CODEGEN: &str = include_str!("../../../third_party/napi-derive-backend/src/codegen/fn.rs");

fn section<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
	let start = source.find(start).unwrap_or_else(|| panic!("missing section start: {start}"));
	let rest = &source[start..];
	let end = rest.find(end).unwrap_or_else(|| panic!("missing section end: {end}"));
	&rest[..end]
}

fn assert_ordered(source: &str, first: &str, second: &str) {
	let first_index = source.find(first).unwrap_or_else(|| panic!("missing first token: {first}"));
	let second_index =
		source.find(second).unwrap_or_else(|| panic!("missing second token: {second}"));
	assert!(first_index < second_index, "expected `{first}` before `{second}`");
}

#[test]
fn generated_class_reference_conversions_prove_non_null_before_borrowing() {
	for (start, end, pointer, reference) in [
		(
			"impl napi::bindgen_prelude::FromNapiRef for #name",
			"impl napi::bindgen_prelude::FromNapiMutRef for #name",
			"let wrapped_val = std::ptr::NonNull::new",
			"wrapped_val.as_ref()",
		),
		(
			"impl napi::bindgen_prelude::FromNapiMutRef for #name",
			"impl napi::bindgen_prelude::ValidateNapiValue for &#name",
			"let mut wrapped_val = std::ptr::NonNull::new",
			"wrapped_val.as_mut()",
		),
	] {
		let conversion = section(STRUCT_CODEGEN, start, end);
		assert_ordered(conversion, "napi_unwrap", pointer);
		assert_ordered(conversion, pointer, "register_native_borrow_with_value");
		assert_ordered(conversion, "register_native_borrow_with_value", reference);
	}
	assert!(!STRUCT_CODEGEN.contains("Ok(&*(wrapped_val"));
	assert!(!STRUCT_CODEGEN.contains("Ok(&mut *(wrapped_val"));
}

#[test]
fn generated_receivers_and_accessors_never_rebuild_boxes_from_nullable_pointers() {
	assert_eq!(FN_CODEGEN.matches("NonNull::new(cb.unwrap_raw::<#parent>()?)").count(), 2);
	for (start, end) in [
		("unsafe fn #getter_name(", "if field.setter {"),
		("unsafe fn #setter_name(", "if field.getter {"),
	] {
		let accessor = section(STRUCT_CODEGEN, start, end);
		assert_eq!(accessor.matches("std::ptr::NonNull::new").count(), 1);
		assert_eq!(accessor.matches("class_accessor_unwrap_this").count(), 1);
		assert_ordered(accessor, "std::ptr::NonNull::new", "class_accessor_unwrap_this");
		assert_ordered(accessor, "class_accessor_unwrap_this", ".ok_or_else");
		assert_ordered(accessor, ".ok_or_else", "acquire_native_borrow");
		assert_ordered(accessor, "acquire_native_borrow", "this_ptr.as_ptr()");
		assert_ordered(accessor, "this_ptr.as_ptr()", "this_ptr.as_mut()");
	}
	assert!(!FN_CODEGEN.contains("Box::from_raw(this_ptr)"));
	assert!(!STRUCT_CODEGEN.contains("Box::from_raw(this_ptr)"));
	assert_eq!(FN_CODEGEN.matches("this_ptr.as_ptr()").count(), 2);
	assert_eq!(STRUCT_CODEGEN.matches("this_ptr.as_ptr()").count(), 2);
}
