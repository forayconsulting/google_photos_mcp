import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { durationMs, type PickedMediaItem } from "../google/picker.js";
import { toEntry } from "../manifest.js";
import type { PickDeps } from "../pick.js";
import { fileNameFor } from "../pick.js";
import { errorResult, LOCATION_NOTE, text } from "./common.js";

/** Config A: low-level tools that mirror the Picker API one to one. The model polls and downloads itself. */
export function registerConfigA(server: McpServer, deps: PickDeps): void {
	const { source, tmp, sets } = deps;
	const listed = new Map<string, Map<string, PickedMediaItem>>();
	const usedNames = new Map<string, Set<string>>();

	server.registerTool(
		"create_session",
		{
			description:
				"Create a Google Photos Picker session and open the picker in the user's laptop browser. Returns the session id and the poll interval to use with get_session.",
			inputSchema: { max_items: z.number().int().min(1).max(2000).optional().describe("Most items the user may pick") },
		},
		async ({ max_items }) => {
			try {
				const s = await source.createSession(max_items);
				source.openPicker(s.pickerUri);
				return text(
					`session_id: ${s.id}\npicker opened in the user's browser\npoll_interval_seconds: ${durationMs(s.pollingConfig?.pollInterval, 5000) / 1000}\nexpire_time: ${s.expireTime ?? "unknown"}`,
				);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	server.registerTool(
		"get_session",
		{
			description: "Get a picker session's state. media_items_set becomes true after the user clicks Done.",
			inputSchema: { session_id: z.string() },
		},
		async ({ session_id }) => {
			try {
				const s = await source.getSession(session_id);
				return text(
					`media_items_set: ${Boolean(s.mediaItemsSet)}${s.pollingConfig ? `\npoll_interval_seconds: ${durationMs(s.pollingConfig.pollInterval, 5000) / 1000}` : ""}`,
				);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	server.registerTool(
		"list_items",
		{
			description: "List the media items the user picked in a session. Only works after media_items_set is true.",
			inputSchema: { session_id: z.string() },
		},
		async ({ session_id }) => {
			try {
				const items = await source.listMediaItems(session_id);
				listed.set(session_id, new Map(items.map((it) => [it.id, it])));
				const lines = items.map((it) => {
					const m = it.mediaFile.mediaFileMetadata ?? {};
					return `${it.id} | ${it.createTime} | ${it.type} | ${m.width ?? "?"}x${m.height ?? "?"} | ${[m.cameraMake, m.cameraModel].filter(Boolean).join(" ") || "-"} | ${it.mediaFile.filename}`;
				});
				return text(
					[
						`${items.length} item(s)`,
						LOCATION_NOTE,
						"item_id | createTime | type | WxH | camera | filename",
						...lines,
					].join("\n"),
				);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	server.registerTool(
		"download_item",
		{
			description: "Download one picked item's original file to a temp folder. Returns the local path.",
			inputSchema: { session_id: z.string(), item_id: z.string() },
		},
		async ({ session_id, item_id }) => {
			try {
				const item = listed.get(session_id)?.get(item_id);
				if (!item) throw new Error("Unknown item. Call list_items for this session first.");
				const dir = tmp.sessionDir(session_id);
				const used = usedNames.get(session_id) ?? new Set<string>();
				usedNames.set(session_id, used);
				const path = join(dir, fileNameFor(item, used));
				await source.download(item, path);
				const set = sets.get(session_id) ?? {
					sessionId: session_id,
					dir,
					pickedAt: new Date().toISOString(),
					entries: [],
				};
				set.entries.push(toEntry(item, set.entries.length + 1, path));
				sets.add(set);
				return text(path);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	server.registerTool(
		"delete_session",
		{
			description: "Delete a picker session on Google's side. Downloaded files stay in the temp folder.",
			inputSchema: { session_id: z.string() },
		},
		async ({ session_id }) => {
			try {
				await source.deleteSession(session_id);
				return text(`deleted ${session_id}`);
			} catch (err) {
				return errorResult(err);
			}
		},
	);
}
