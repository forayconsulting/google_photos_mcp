// Smoke test for the video tools: start the built server, call watch_video and then inspect_video on a local file.
// Usage: node spe/evals/video-smoke.mjs <video> <start> <end> [listen_for phrases as JSON]
// Prints each result's text and saves its inline images next to the video's analysis folder.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [video, start, end, phrases] = process.argv.slice(2);
const listen_for = phrases ? JSON.parse(phrases) : undefined;
const tmpRoot = mkdtempSync(join(tmpdir(), "video-smoke-"));
const transport = new StdioClientTransport({
	command: "node",
	args: ["dist/index.js"],
	env: { ...process.env, GPHOTOS_SOURCE: "picker", GPHOTOS_TMP_ROOT: tmpRoot },
	stderr: "inherit",
});
const client = new Client({ name: "video-smoke", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`tools: ${tools.join(", ")}`);

let failed = false;
for (const [name, args] of [
	["watch_video", { path: video, listen_for }],
	["inspect_video", { path: video, start: Number(start), end: Number(end), listen_for }],
]) {
	const t0 = Date.now();
	const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60_000 });
	const texts = r.content.filter((c) => c.type === "text").map((c) => c.text);
	const images = r.content.filter((c) => c.type === "image");
	images.forEach((img, i) =>
		writeFileSync(join(tmpRoot, `${name}-${i + 1}.${img.mimeType.split("/")[1]}`), Buffer.from(img.data, "base64")),
	);
	console.log(
		`\n===== ${name} ${r.isError ? "ERROR" : "ok"} in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${images.length} image(s)`,
	);
	console.log(texts.join("\n"));
	if (r.isError) failed = true;
}
console.log(`\nImages saved in ${tmpRoot}`);
await client.close();
process.exit(failed ? 1 : 0);
