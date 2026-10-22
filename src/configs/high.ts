import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { filterEntries } from "../manifest.js";
import { type PickDeps, pickPhotos, type StartedPick, startPick } from "../pick.js";
import { errorResult, formatSet, progressFor, text, thumbnails } from "./common.js";

export interface HighOptions {
	/** Config D: append inline thumbnails to the pick result. */
	thumbnails: boolean;
	/** Config E: split picking into start_pick and wait_for_pick. */
	twoStep: boolean;
}

const maxItems = z
	.number()
	.int()
	.min(1)
	.max(2000)
	.optional()
	.describe("Most items the user may pick (Google's limit is 2000). Defaults to 2000.");

/** Configs B to E: high-level tools. The server polls, downloads, and deletes the session. */
export function registerHighLevel(server: McpServer, deps: PickDeps, opts: HighOptions): void {
	const { sets, tmp } = deps;

	if (opts.twoStep) {
		const pending = new Map<string, StartedPick>();

		server.registerTool(
			"start_pick",
			{
				description:
					"Open a Google Photos picker in the user's laptop browser and return at once with a session id. Then call wait_for_pick with that id.",
				inputSchema: { max_items: maxItems },
			},
			async ({ max_items }, extra) => {
				try {
					const started = await startPick(deps, { maxItems: max_items, onProgress: progressFor(extra) });
					pending.set(started.sessionId, started);
					return text(
						`Picker opened in the user's browser. session_id: ${started.sessionId}\nNext: call wait_for_pick.`,
					);
				} catch (err) {
					return errorResult(err);
				}
			},
		);

		server.registerTool(
			"wait_for_pick",
			{
				description:
					"Wait until the user clicks Done in the picker, then return the manifest of downloaded files (paths, capture times, camera data).",
				inputSchema: { session_id: z.string() },
			},
			async ({ session_id }) => {
				try {
					const started = pending.get(session_id);
					if (!started) {
						const done = sets.get(session_id);
						if (done) return text(formatSet(done));
						throw new Error("Unknown session. Call start_pick first.");
					}
					const set = await started.done;
					pending.delete(session_id);
					return text(formatSet(set));
				} catch (err) {
					pending.delete(session_id);
					return errorResult(err);
				}
			},
		);
	} else {
		server.registerTool(
			"pick_photos",
			{
				description:
					"Open a Google Photos picker in the user's laptop browser, wait while they select photos and click Done, then download the originals to a temp folder. Returns a manifest with file paths, capture times, and camera data.",
				inputSchema: { max_items: maxItems },
			},
			async ({ max_items }, extra) => {
				try {
					const set = await pickPhotos(deps, {
						maxItems: max_items,
						onProgress: progressFor(extra),
						signal: extra.signal,
					});
					const result = text(formatSet(set));
					if (opts.thumbnails) result.content.push(...thumbnails(set));
					return result;
				} catch (err) {
					return errorResult(err);
				}
			},
		);
	}

	server.registerTool(
		"list_picked",
		{
			description:
				"List photos already picked in this session, optionally filtered by capture time, camera, or type. Does not open the picker. Defaults to the most recent pick.",
			inputSchema: {
				session_id: z.string().optional().describe("A session id from an earlier pick. Defaults to the most recent."),
				after: z.string().optional().describe("ISO 8601 timestamp. Keep items captured at or after this time."),
				before: z.string().optional().describe("ISO 8601 timestamp. Keep items captured before this time."),
				camera: z.string().optional().describe("Case-insensitive match on camera make or model"),
				type: z.enum(["PHOTO", "VIDEO"]).optional(),
			},
		},
		async ({ session_id, after, before, camera, type }) => {
			try {
				const set = sets.get(session_id);
				if (!set) return text("Nothing has been picked yet in this session.");
				const entries = filterEntries(set.entries, { after, before, camera, type });
				const others = sets.all().filter((s) => s.sessionId !== set.sessionId).length;
				return text(
					`${formatSet(set, entries, "Matched")}${others ? `\n\n${others} earlier pick(s) also available by session_id.` : ""}`,
				);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	server.registerTool(
		"cleanup_photos",
		{
			description: "Delete picked files from the temp folder now. Defaults to every pick in this session.",
			inputSchema: { session_id: z.string().optional() },
		},
		async ({ session_id }) => {
			try {
				const targets = session_id ? [sets.get(session_id)].filter((s) => s !== undefined) : sets.all();
				for (const s of targets) {
					tmp.remove(s.dir);
					sets.delete(s.sessionId);
				}
				return text(`Deleted ${targets.length} picked set(s).`);
			} catch (err) {
				return errorResult(err);
			}
		},
	);
}
