import { spawn } from "node:child_process";
import { GoogleAuth } from "../google/auth.js";
import { type PickedMediaItem, PickerClient, type PickingSession } from "../google/picker.js";
import { emit } from "./events.js";
import type { PhotoSource } from "./types.js";

export function openInBrowser(url: string): void {
	spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

export class PickerSource implements PhotoSource {
	readonly kind = "picker" as const;
	private client: PickerClient;

	constructor(client?: PickerClient) {
		this.client = client ?? new PickerClient(GoogleAuth.default(openInBrowser));
	}

	async createSession(maxItemCount?: number): Promise<PickingSession> {
		const s = await this.client.createSession(maxItemCount);
		emit("session_created", { id: s.id });
		return s;
	}

	getSession(id: string): Promise<PickingSession> {
		return this.client.getSession(id);
	}

	listMediaItems(sessionId: string): Promise<PickedMediaItem[]> {
		return this.client.listMediaItems(sessionId);
	}

	download(item: PickedMediaItem, destPath: string): Promise<number> {
		return this.client.download(item, destPath);
	}

	async deleteSession(id: string): Promise<void> {
		await this.client.deleteSession(id);
		emit("session_deleted", { id });
	}

	openPicker(pickerUri: string): void {
		// /autoclose asks Google to close the tab after Done. The spike saw it stay open; harmless.
		openInBrowser(`${pickerUri}/autoclose`);
		emit("picker_opened", { device: "laptop" });
	}
}
