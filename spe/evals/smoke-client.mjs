// Smoke test: start the built server in each config against a replay fixture, list tools, run one pick.
// Usage: node spe/evals/smoke-client.mjs <fixture-dir>

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const fixture = process.argv[2];
let failures = 0;
for (const config of ["a", "b", "c", "d", "e"]) {
	const tmpRoot = mkdtempSync(join(tmpdir(), `smoke-${config}-`));
	const eventLog = join(tmpRoot, "events.jsonl");
	const transport = new StdioClientTransport({
		command: "node",
		args: ["dist/index.js"],
		env: {
			...process.env,
			GPHOTOS_CONFIG: config,
			GPHOTOS_SOURCE: `replay:${fixture}`,
			GPHOTOS_REPLAY_DELAY_MS: "500",
			GPHOTOS_TMP_ROOT: tmpRoot,
			GPHOTOS_EVENT_LOG: eventLog,
		},
		stderr: "ignore",
	});
	const client = new Client({ name: "smoke", version: "0" });
	await client.connect(transport);
	const tools = (await client.listTools()).tools.map((t) => t.name);
	const prompts = await client
		.listPrompts()
		.then((p) => p.prompts.map((x) => x.name))
		.catch(() => []);
	const instructions = client.getInstructions() ? "yes" : "no";
	let result;
	if (config === "a") {
		const created = await client.callTool({ name: "create_session", arguments: {} });
		const id = created.content[0].text.match(/session_id: (\S+)/)[1];
		await new Promise((r) => setTimeout(r, 700));
		await client.callTool({ name: "get_session", arguments: { session_id: id } });
		const listed = await client.callTool({ name: "list_items", arguments: { session_id: id } });
		const itemId = listed.content[0].text.split("\n")[3].split(" | ")[0];
		result = await client.callTool({ name: "download_item", arguments: { session_id: id, item_id: itemId } });
		await client.callTool({ name: "delete_session", arguments: { session_id: id } });
	} else if (config === "e") {
		const started = await client.callTool({ name: "start_pick", arguments: {} });
		const id = started.content[0].text.match(/session_id: (\S+)/)[1];
		result = await client.callTool({ name: "wait_for_pick", arguments: { session_id: id } });
	} else {
		result = await client.callTool({ name: "pick_photos", arguments: {} });
	}
	const texts = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = result.content.filter((c) => c.type === "image").length;
	const events = existsSync(eventLog)
		? readFileSync(eventLog, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l).event)
		: [];
	const ok = !result.isError && events.includes("session_deleted") && events.includes("picker_opened");
	if (!ok) failures++;
	console.log(
		`${ok ? "PASS" : "FAIL"} config=${config} tools=[${tools}] prompts=${prompts.length} instructions=${instructions} images=${images} events=[${events}]`,
	);
	if (!ok) console.log(texts);
	if (config === "c") console.log(texts.split("\n").slice(0, 7).join("\n"));
	await client.close();
}
process.exit(failures ? 1 : 0);
