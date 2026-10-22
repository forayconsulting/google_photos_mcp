import type { PickedMediaItem, PickingSession } from "../google/picker.js";

/** The seam between the tools and Google. PickerSource is live. ReplaySource serves recorded real picks to evals. */
export interface PhotoSource {
	readonly kind: "picker" | "replay";
	createSession(maxItemCount?: number): Promise<PickingSession>;
	getSession(id: string): Promise<PickingSession>;
	listMediaItems(sessionId: string): Promise<PickedMediaItem[]>;
	download(item: PickedMediaItem, destPath: string): Promise<number>;
	deleteSession(id: string): Promise<void>;
	/** Shows the picker to the user on this laptop. */
	openPicker(pickerUri: string): void;
}
