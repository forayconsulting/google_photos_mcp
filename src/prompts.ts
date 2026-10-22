import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Server instructions for configs C, D, and E. `pickTool` names the tool or tool pair that picks. */
export function serverInstructions(pickTool: string): string {
	return `gphotos-mcp gets photos from the user's Google Photos library through Google's Photos Picker.

<approach>
- When the user wants photos, call ${pickTool}. It opens a Google Photos picker tab in the user's laptop browser and waits while they choose. Before calling, tell the user in one line what to select. When the request names a place, date, person, or subject, suggest a search term to type in the picker's search box, which understands those.
- The call returns after the user clicks Done. The files are already downloaded to a temp folder. Read them by path with your normal file-reading tool.
- Reuse picked sets. For follow-up questions about photos already picked, call list_picked or read the files again. Pick again only when the user wants different photos.
- Read only as many images as the task needs. For large sets, work from the manifest and paths, and open a sample only when you must check content.
- Location is not available. Google removes GPS from picker downloads and returns no location field. If the user asks for photos from a place, say so and suggest searching the place name in the picker.
- Sign-in is automatic. If Google sign-in is needed, the server opens it in the browser and continues. Never ask the user to run a command.
- Files are temporary. They are deleted after 24 hours or when the server stops. Write derived output (notes, diagrams, markdown) to the project. Copy originals only when the user asks.
</approach>`;
}

export function registerPrompts(server: McpServer, pickTool: string): void {
	server.registerPrompt(
		"ingest_photo_set",
		{
			description: "Pick a large set of photos (for example a photogrammetry capture) and prepare it for processing.",
			argsSchema: { purpose: z.string().optional().describe("What the photos are for") },
		},
		({ purpose }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `<task>Ingest a set of photos I just took${purpose ? ` for: ${purpose}` : ""}.</task>
<approach>Call ${pickTool} with a max_items high enough for the whole set. Tell me to select every photo in the set. When it returns, check the count, capture time span, and camera consistency from the manifest. Open at most a few images to confirm content.</approach>
<avoid>Reading every image into context. Picking again for follow-up steps.</avoid>
<outputs>The count, time span, camera, folder path, and anything that looks missing or inconsistent.</outputs>`,
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"notes_from_slides",
		{
			description: "Pick photos of presentation slides and write notes from them.",
			argsSchema: { topic: z.string().optional().describe("The talk or meeting") },
		},
		({ topic }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `<task>Take notes from slide photos I took${topic ? ` during ${topic}` : ""}.</task>
<approach>Call ${pickTool}. Read every slide image in capture order. Transcribe titles, key points, numbers, and diagrams faithfully. Mark anything unreadable instead of guessing.</approach>
<avoid>Inventing content that is not on a slide. Picking again when I ask follow-up questions about the same slides.</avoid>
<outputs>Markdown notes, one section per slide or topic, in capture order.</outputs>`,
					},
				},
			],
		}),
	);

	server.registerPrompt(
		"diagram_to_mermaid_or_markdown",
		{
			description: "Pick photos of diagrams, whiteboards, or handwritten pages and convert them.",
			argsSchema: { target: z.enum(["mermaid", "markdown"]).optional().describe("Output format") },
		},
		({ target }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `<task>Convert photos of diagrams or handwritten pages into ${target ?? "Mermaid diagrams or Markdown, whichever fits each image"}.</task>
<approach>Call ${pickTool}. Read each image. Preserve every node, edge, label, and heading you can read. Mark unreadable parts instead of guessing.</approach>
<avoid>Simplifying or dropping elements. Adding structure that is not in the image.</avoid>
<outputs>One code block or Markdown document per image, named by the image's capture time.</outputs>`,
					},
				},
			],
		}),
	);
}
