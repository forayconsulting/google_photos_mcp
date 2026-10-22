import type { PickedMediaItem } from "./google/picker.js";

export interface ManifestEntry {
	index: number;
	path: string;
	filename: string;
	createTime: string;
	type: string;
	mimeType: string;
	width?: number;
	height?: number;
	cameraMake?: string;
	cameraModel?: string;
	focalLength?: number;
	apertureFNumber?: number;
	isoEquivalent?: number;
	exposureTime?: string;
	fps?: number;
}

export interface PickedSet {
	sessionId: string;
	dir: string;
	pickedAt: string;
	entries: ManifestEntry[];
}

export function toEntry(item: PickedMediaItem, index: number, path: string): ManifestEntry {
	const m = item.mediaFile.mediaFileMetadata ?? {};
	return {
		index,
		path,
		filename: item.mediaFile.filename,
		createTime: item.createTime,
		type: item.type,
		mimeType: item.mediaFile.mimeType,
		width: m.width,
		height: m.height,
		cameraMake: m.cameraMake,
		cameraModel: m.cameraModel,
		focalLength: m.photoMetadata?.focalLength,
		apertureFNumber: m.photoMetadata?.apertureFNumber,
		isoEquivalent: m.photoMetadata?.isoEquivalent,
		exposureTime: m.photoMetadata?.exposureTime,
		fps: m.videoMetadata?.fps,
	};
}

/** Picked sets held for the life of the server process, newest last. */
export class PickedSets {
	private sets = new Map<string, PickedSet>();

	add(set: PickedSet): void {
		this.sets.delete(set.sessionId);
		this.sets.set(set.sessionId, set);
	}

	get(sessionId?: string): PickedSet | undefined {
		if (sessionId) return this.sets.get(sessionId);
		return [...this.sets.values()].at(-1);
	}

	all(): PickedSet[] {
		return [...this.sets.values()];
	}

	delete(sessionId: string): void {
		this.sets.delete(sessionId);
	}
}

export interface EntryFilter {
	after?: string;
	before?: string;
	camera?: string;
	type?: "PHOTO" | "VIDEO";
}

export function filterEntries(entries: ManifestEntry[], f: EntryFilter): ManifestEntry[] {
	const after = f.after ? Date.parse(f.after) : Number.NEGATIVE_INFINITY;
	const before = f.before ? Date.parse(f.before) : Number.POSITIVE_INFINITY;
	if (Number.isNaN(after) || Number.isNaN(before)) throw new Error("after/before must be ISO 8601 timestamps");
	const camera = f.camera?.toLowerCase();
	return entries.filter((e) => {
		const t = Date.parse(e.createTime);
		if (t < after || t >= before) return false;
		if (f.type && e.type !== f.type) return false;
		if (camera && !`${e.cameraMake ?? ""} ${e.cameraModel ?? ""}`.toLowerCase().includes(camera)) return false;
		return true;
	});
}
