import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GoogleAuth } from "./auth.js";

const BASE_URL = "https://photospicker.googleapis.com/v1";

export interface PollingConfig {
	pollInterval?: string;
	timeoutIn?: string;
}

export interface PickingSession {
	id: string;
	pickerUri: string;
	pollingConfig?: PollingConfig;
	expireTime?: string;
	mediaItemsSet?: boolean;
}

export interface PickedMediaItem {
	id: string;
	createTime: string;
	type: "PHOTO" | "VIDEO" | "TYPE_UNSPECIFIED";
	mediaFile: {
		baseUrl: string;
		mimeType: string;
		filename: string;
		mediaFileMetadata?: {
			width?: number;
			height?: number;
			cameraMake?: string;
			cameraModel?: string;
			photoMetadata?: {
				focalLength?: number;
				apertureFNumber?: number;
				isoEquivalent?: number;
				exposureTime?: string;
			};
			videoMetadata?: { fps?: number; processingStatus?: string };
		};
	};
}

export class PickerApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly googleStatus?: string,
	) {
		super(message);
	}
}

/** Parses Google duration strings such as "3.5s" into milliseconds. */
export function durationMs(d: string | undefined, fallbackMs: number): number {
	if (!d) return fallbackMs;
	const n = Number.parseFloat(d.replace(/s$/, ""));
	return Number.isFinite(n) && n > 0 ? n * 1000 : fallbackMs;
}

export class PickerClient {
	constructor(
		private auth: GoogleAuth,
		private fetchImpl: typeof fetch = fetch,
	) {}

	/** Authenticated request with one retry after a 401, ported from googlehealth's apiRequest. */
	private async request(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
		const token = await this.auth.accessToken();
		const res = await this.fetchImpl(url, {
			...init,
			headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
		});
		if (res.status === 401 && !retried) {
			this.auth.clearAccessToken();
			return this.request(url, init, true);
		}
		return res;
	}

	private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.request(`${BASE_URL}${path}`, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
		});
		if (res.status === 204) return {} as T;
		const data = (await res.json().catch(() => ({}))) as T & { error?: { status?: string } };
		if (!res.ok) {
			const googleStatus = data.error?.status;
			throw new PickerApiError(
				`${method} ${path.split("?")[0]} failed: HTTP ${res.status} ${googleStatus ?? ""}`.trim(),
				res.status,
				googleStatus,
			);
		}
		return data;
	}

	createSession(maxItemCount?: number): Promise<PickingSession> {
		return this.json(
			"POST",
			"/sessions",
			maxItemCount ? { pickingConfig: { maxItemCount: String(maxItemCount) } } : {},
		);
	}

	getSession(id: string): Promise<PickingSession> {
		return this.json("GET", `/sessions/${encodeURIComponent(id)}`);
	}

	async deleteSession(id: string): Promise<void> {
		await this.json("DELETE", `/sessions/${encodeURIComponent(id)}`);
	}

	async listMediaItems(sessionId: string): Promise<PickedMediaItem[]> {
		const items: PickedMediaItem[] = [];
		let pageToken = "";
		do {
			const q = new URLSearchParams({ sessionId, pageSize: "100" });
			if (pageToken) q.set("pageToken", pageToken);
			const page = await this.json<{ mediaItems?: PickedMediaItem[]; nextPageToken?: string }>(
				"GET",
				`/mediaItems?${q}`,
			);
			items.push(...(page.mediaItems ?? []));
			pageToken = page.nextPageToken ?? "";
		} while (pageToken);
		return items;
	}

	/** Downloads the original bytes. Photos use =d (EXIF kept, GPS stripped by Google). Videos use =dv. */
	async download(item: PickedMediaItem, destPath: string): Promise<number> {
		const suffix = item.type === "VIDEO" ? "=dv" : "=d";
		const res = await this.request(`${item.mediaFile.baseUrl}${suffix}`);
		if (!res.ok || !res.body)
			throw new PickerApiError(`download of ${item.mediaFile.filename} failed: HTTP ${res.status}`, res.status);
		await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(destPath));
		return Number(res.headers.get("content-length") ?? 0);
	}
}
