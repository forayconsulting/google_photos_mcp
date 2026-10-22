// Phase 0 spike: a dependency-free MCP stdio server with one tool that blocks.
// Tests whether Claude Code waits for a long tool call. Throwaway.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
	const req = JSON.parse(line);
	if (req.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: req.id,
			result: {
				protocolVersion: req.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "block-spike", version: "0.0.1" },
			},
		});
	} else if (req.method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id: req.id,
			result: {
				tools: [
					{
						name: "wait_seconds",
						description: "Blocks for the given number of seconds, sending progress if a token is given, then returns.",
						inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
					},
				],
			},
		});
	} else if (req.method === "tools/call") {
		const seconds = req.params.arguments.seconds;
		const token = req.params._meta?.progressToken;
		const started = Date.now();
		console.error(`[block] start ${seconds}s progressToken=${token ?? "none"}`);
		for (let i = 0; i < seconds; i += 30) {
			await new Promise((r) => setTimeout(r, Math.min(30, seconds - i) * 1000));
			if (token !== undefined)
				send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: i + 30, total: seconds } });
		}
		const elapsed = Math.round((Date.now() - started) / 1000);
		console.error(`[block] done after ${elapsed}s`);
		send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `waited ${elapsed}s` }] } });
	} else if (req.id !== undefined) {
		send({ jsonrpc: "2.0", id: req.id, result: {} });
	}
});
