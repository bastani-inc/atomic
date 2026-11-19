exports.emit = (path, strict) => {
	const replacement = path.getData("replacement");
	if (strict && replacement === undefined) throw new Error("Missing replacement in the active compiler plugin");
	path.node.value = replacement ?? 0;
};
