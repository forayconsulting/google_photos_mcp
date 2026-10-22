import { PickerSource } from "./picker.js";
import { ReplaySource } from "./replay.js";
import type { PhotoSource } from "./types.js";

/** GPHOTOS_SOURCE must be set: "picker" for live use, "replay:<dir>" for evals. No silent default. */
export function sourceFromEnv(value = process.env.GPHOTOS_SOURCE): PhotoSource {
	if (value === "picker") return new PickerSource();
	if (value?.startsWith("replay:")) return new ReplaySource(value.slice("replay:".length));
	throw new Error(
		`GPHOTOS_SOURCE must be "picker" or "replay:<dir>" (got ${value === undefined ? "nothing" : JSON.stringify(value)}).`,
	);
}
