import { randomUUID } from "node:crypto";
import { copyFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PickedMediaItem, PickingSession } from "../google/picker.js";
import { emit } from "./events.js";
import type { PhotoSource } from "./types.js";

interface ReplayItem extends PickedMediaItem {
	/** File path relative to the fixture directory. */
	file: string;
}

/**
 * Serves one recorded real pick (spe/evals/capture.ts output) as if the user picked it live.
 * Used only when GPHOTOS_SOURCE=replay:<dir>. The pick completes after GPHOTOS_REPLAY_DELAY_MS.
 * GPHOTOS_REPLAY_AUTH=revoked simulates an expired sign-in that the server must recover from on its own.
 */
export class ReplaySource implements PhotoSource {
	readonly kind = "replay" as const;
	private items: ReplayItem[];
	private sessions = new Map<string, { openedAt: number | null; deleted: boolean }>();
	private delayMs: number;
	private authRevoked: boolean;

	constructor(private dir: string) {
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { items: ReplayItem[] };
		if (!Array.isArray(manifest.items) || manifest.items.length === 0)
			throw new Error(`replay fixture ${dir} has no items`);
		for (const it of manifest.items) statSync(join(dir, it.file));
		this.items = manifest.items;
		this.delayMs = Number(process.env.GPHOTOS_REPLAY_DELAY_MS ?? 3000);
		this.authRevoked = process.env.GPHOTOS_REPLAY_AUTH === "revoked";
	}

	private async ensureAuth(): Promise<void> {
		if (!this.authRevoked) return;
		emit("consent_opened", { device: "laptop" });
		await new Promise((r) => setTimeout(r, 1000));
		this.authRevoked = false;
		emit("consent_completed");
	}

	/** The simulated user finishes picking a fixed delay after the picker opens. */
	private isSet(s: { openedAt: number | null }): boolean {
		return s.openedAt !== null && Date.now() - s.openedAt >= this.delayMs;
	}

	private session(id: string) {
		const s = this.sessions.get(id);
		if (!s || s.deleted) throw new Error(`session ${id} not found`);
		return s;
	}

	async createSession(): Promise<PickingSession> {
		await this.ensureAuth();
		const id = randomUUID();
		this.sessions.set(id, { openedAt: null, deleted: false });
		emit("session_created", { id });
		return {
			id,
			pickerUri: `https://photos.google.com/picker/replay/${id}`,
			pollingConfig: { pollInterval: "1s", timeoutIn: "1800s" },
			mediaItemsSet: false,
		};
	}

	async getSession(id: string): Promise<PickingSession> {
		await this.ensureAuth();
		const s = this.session(id);
		const set = this.isSet(s);
		return {
			id,
			pickerUri: `https://photos.google.com/picker/replay/${id}`,
			mediaItemsSet: set,
			...(set ? {} : { pollingConfig: { pollInterval: "1s", timeoutIn: "1800s" } }),
		};
	}

	async listMediaItems(sessionId: string): Promise<PickedMediaItem[]> {
		const s = this.session(sessionId);
		if (!this.isSet(s)) throw new Error("FAILED_PRECONDITION: media items not set yet");
		return this.items.map(({ file, ...it }) => ({ ...it, mediaFile: { ...it.mediaFile, baseUrl: `replay:${file}` } }));
	}

	async download(item: PickedMediaItem, destPath: string): Promise<number> {
		const file = item.mediaFile.baseUrl.replace(/^replay:/, "");
		copyFileSync(join(this.dir, file), destPath);
		return statSync(destPath).size;
	}

	async deleteSession(id: string): Promise<void> {
		this.session(id).deleted = true;
		emit("session_deleted", { id });
	}

	openPicker(pickerUri: string): void {
		const id = pickerUri.split("/").at(-1) ?? "";
		const s = this.sessions.get(id);
		if (s && s.openedAt === null) s.openedAt = Date.now();
		emit("picker_opened", { device: "laptop" });
	}
}
