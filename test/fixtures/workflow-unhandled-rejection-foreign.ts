export async function failElsewhere(label: string): Promise<string> {
	throw new Error(`${label} failed outside the workflow module`);
}
