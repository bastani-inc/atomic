export async function failElsewhere(label: string): Promise<string> {
	throw new Error(`${label} failed outside the workflow module`);
}

async function rejectElsewhere(label: string): Promise<never> {
	throw new Error(`${label} failed outside the workflow module`);
}

export const failingUi = {
	input: () => rejectElsewhere("ui"),
	confirm: () => rejectElsewhere("ui"),
	select: () => rejectElsewhere("ui"),
	editor: () => rejectElsewhere("ui"),
	custom: () => rejectElsewhere("ui"),
};
