import { workflow } from "@bastani/atomic/workflows";

export default workflow({
	name: "slash-autosend-noop",
	description: "No-op workflow for slash auto-send regression coverage.",
	inputs: {},
	outputs: {},
	run: async () => ({}),
});
