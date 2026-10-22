// Records one live pick as a replay fixture for evals.
// Usage: npm run build && node spe/evals/capture.mjs <round> <task> [max_items]
// Output: spe/evals/fixtures/<round>/<task>/{manifest.json, files...}. The fixtures folder is gitignored (personal photos).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileNameFor } from "../../dist/pick.js";
import { PickerSource } from "../../dist/source/picker.js";

const [round, task, max] = process.argv.slice(2);
if (!round || !task) {
	console.error("usage: node spe/evals/capture.mjs <round> <task> [max_items]");
	process.exit(2);
}
const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures", round, task);
mkdirSync(out, { recursive: true });

const source = new PickerSource();
const session = await source.createSession(max ? Number(max) : undefined);
source.openPicker(session.pickerUri);
console.error(`[capture] picker opened for ${round}/${task}. Select the photos, then click Done.`);
try {
	let s = session;
	while (!s.mediaItemsSet) {
		await new Promise((r) => setTimeout(r, Number.parseFloat(s.pollingConfig?.pollInterval ?? "5") * 1000));
		s = await source.getSession(session.id);
	}
	const items = (await source.listMediaItems(session.id)).sort((a, b) => a.createTime.localeCompare(b.createTime));
	const used = new Set();
	const recorded = [];
	for (const it of items) {
		const file = fileNameFor(it, used);
		await source.download(it, join(out, file));
		const { baseUrl, ...mediaFile } = it.mediaFile;
		recorded.push({ ...it, mediaFile: { ...mediaFile, baseUrl: "" }, file });
	}
	writeFileSync(
		join(out, "manifest.json"),
		JSON.stringify({ round, task, capturedAt: new Date().toISOString(), items: recorded }, null, 1),
	);
	console.error(`[capture] saved ${recorded.length} item(s) to ${out}`);
} finally {
	await source.deleteSession(session.id);
}
