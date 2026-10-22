import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../log.js";
import type { ManifestEntry, PickedSet } from "../manifest.js";
import type { Progress } from "../pick.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export const LOCATION_NOTE =
	"Location: not available. Google strips GPS from picker downloads and returns no location field.";

export function text(t: string): CallToolResult {
	return { content: [{ type: "text", text: t }] };
}

export function errorResult(err: unknown): CallToolResult {
	const message = err instanceof Error ? err.message : String(err);
	log("tool error:", message);
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Sends MCP progress notifications when the client asked for them. */
export function progressFor(extra: Extra): Progress {
	const token = extra._meta?.progressToken;
	return (done, total, message) => {
		if (token === undefined) return;
		extra
			.sendNotification({
				method: "notifications/progress",
				params: { progressToken: token, progress: done, ...(total ? { total } : {}), message },
			})
			.catch(() => {});
	};
}

function camera(e: ManifestEntry): string {
	return [e.cameraMake, e.cameraModel].filter(Boolean).join(" ") || "-";
}

/** Compact manifest: one header, then one line per item. The folder is printed once to save tokens. */
export function formatSet(set: PickedSet, entries: ManifestEntry[] = set.entries, heading = "Picked"): string {
	const photos = entries.filter((e) => e.type === "PHOTO").length;
	const videos = entries.filter((e) => e.type === "VIDEO").length;
	const lines = [
		`${heading} ${entries.length} item(s) (${photos} photo, ${videos} video). Session: ${set.sessionId}`,
		`Folder: ${set.dir}`,
	];
	if (entries.length)
		lines.push(`Captured: ${entries[0].createTime} to ${entries[entries.length - 1].createTime} (UTC)`);
	lines.push(LOCATION_NOTE, "", "index | createTime (UTC) | type | WxH | camera | file");
	for (const e of entries) {
		lines.push(
			`${e.index} | ${e.createTime} | ${e.type} | ${e.width ?? "?"}x${e.height ?? "?"} | ${camera(e)} | ${basename(e.path)}`,
		);
	}
	return lines.join("\n");
}

/** Config D: up to `max` evenly spaced photo thumbnails (long edge <= 1024 px) as inline image blocks. */
export function thumbnails(set: PickedSet, max = 20): CallToolResult["content"] {
	const photos = set.entries.filter((e) => e.type === "PHOTO" && e.mimeType.startsWith("image/"));
	if (!photos.length) return [];
	const step = Math.max(1, photos.length / max);
	const chosen = Array.from({ length: Math.min(max, photos.length) }, (_, i) => photos[Math.floor(i * step)]);
	const dir = join(set.dir, ".thumbs");
	mkdirSync(dir, { recursive: true });
	const blocks: CallToolResult["content"] = [];
	for (const e of chosen) {
		const out = join(dir, `${e.index}.jpg`);
		try {
			execFileSync("sips", ["-s", "format", "jpeg", "-Z", "1024", e.path, "--out", out], { stdio: "ignore" });
			blocks.push({ type: "text", text: `Thumbnail of item ${e.index} (${basename(e.path)}):` });
			blocks.push({ type: "image", data: readFileSync(out).toString("base64"), mimeType: "image/jpeg" });
		} catch (err) {
			log(`thumbnail failed for ${e.path}:`, String(err));
		}
	}
	return blocks;
}
