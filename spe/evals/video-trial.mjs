// One trial of the video tools in a real headless Claude Code session, then a text-only judge.
// Usage: node spe/evals/video-trial.mjs <round label> <video key> [trial number]
// Reads spe/evals/fixtures/video/refs.json (gitignored: personal videos and facts about them).
// Writes spe/evals/runs/video/<round>/<video>-<n>/ with the stream, the answer, and score.json.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [round, key, n = "1"] = process.argv.slice(2);
const root = resolve(".");
const refs = JSON.parse(readFileSync(join(root, "spe/evals/fixtures/video/refs.json"), "utf8"));
const ref = refs[key];
if (!ref) throw new Error(`No reference for ${key}`);
const video = join(root, "spe/evals/fixtures/video", ref.file);
const out = join(root, "spe/evals/runs/video", round, `${key}-${n}`);
mkdirSync(out, { recursive: true });

const mcpConfig = join(out, "mcp.json");
writeFileSync(
	mcpConfig,
	JSON.stringify({
		mcpServers: {
			gphotos: {
				command: process.execPath,
				args: [join(root, "dist/index.js")],
				env: { GPHOTOS_SOURCE: "picker", GPHOTOS_TMP_ROOT: join(out, "tmp") },
			},
		},
	}),
);

// The prompt a user would type, with a path instead of the picker so trials need no clicks.
const prompt = `I want you to watch the video at ${video} and tell me what you see`;

function claude(args, input) {
	return new Promise((res, rej) => {
		const p = spawn("claude", args, { cwd: out, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => {
			stdout += d;
		});
		p.stderr.on("data", (d) => {
			stderr += d;
		});
		p.on("close", (code) =>
			code === 0 ? res(stdout) : rej(new Error(`claude exited ${code}: ${stderr.slice(-500)}`)),
		);
		if (input) p.stdin.end(input);
		else p.stdin.end();
	});
}

const t0 = Date.now();
// JUDGE_ONLY=1 regrades a finished trial from its saved stream without running the session again.
const streamFile = join(out, "stream.jsonl");
const stream =
	process.env.JUDGE_ONLY && existsSync(streamFile)
		? readFileSync(streamFile, "utf8")
		: await claude([
				"-p",
				prompt,
				"--output-format",
				"stream-json",
				"--verbose",
				"--mcp-config",
				mcpConfig,
				"--strict-mcp-config",
				"--allowedTools",
				"mcp__gphotos__watch_video,mcp__gphotos__inspect_video,mcp__gphotos__list_picked,Read",
			]);
writeFileSync(join(out, "stream.jsonl"), stream);
const events = stream
	.trim()
	.split("\n")
	.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	})
	.filter(Boolean);

const toolUses = [];
const toolResults = new Map();
let model;
for (const e of events) {
	if (e.type === "system" && e.subtype === "init") model = e.model;
	for (const c of e.message?.content ?? []) {
		if (c.type === "tool_use") toolUses.push({ id: c.id, name: c.name, input: c.input });
		if (c.type === "tool_result") toolResults.set(c.tool_use_id, c.content);
	}
}
const final = events.findLast((e) => e.type === "result");
const answer = final?.result ?? "";
writeFileSync(join(out, "answer.md"), answer);

// Size of each video tool result the way Claude Code estimates it: text by length, 1600 per image.
const sizes = toolUses
	.filter((u) => u.name.includes("video"))
	.map((u) => {
		const content = toolResults.get(u.id);
		const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
		const chars = blocks.filter((b) => b.type === "text").reduce((s, b) => s + b.text.length, 0);
		const images = blocks.filter((b) => b.type === "image").length;
		const text = blocks
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		return {
			tool: u.name.replace("mcp__gphotos__", ""),
			chars,
			images,
			estTokens: Math.round(chars / 4) + images * 1600,
			truncated: /OUTPUT TRUNCATED|left out: they did not fit|Image left out/.test(text),
		};
	});

const judgePrompt = `<task>Grade a description of a video against reference facts. You did not see the video. The reference facts were written by a person who watched it.</task>
<reference_facts>
${ref.facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}
</reference_facts>
<description>
${answer}
</description>
<methodology>For each reference fact, answer "present" if the description states it or something equivalent, "partial" if it states part of it, "absent" if it does not mention it, or "contradicted" if it says something incompatible. Then list claims in the description that clearly conflict with the reference facts (not claims the facts simply do not cover).</methodology>
<outputs>Only JSON: {"facts":[{"n":1,"verdict":"present|partial|absent|contradicted"}],"conflicts":["..."]}</outputs>`;
const judged = await claude(["-p", "--model", "opus", "--output-format", "json", "--strict-mcp-config"], judgePrompt);
// --output-format json prints a list of events in this Claude Code version, or one result object in others.
const parsed = JSON.parse(judged);
const judgeEnvelope = Array.isArray(parsed) ? parsed.findLast((e) => e.type === "result") : parsed;
const judgeText = String(judgeEnvelope.result ?? "").replace(/^```(json)?|```$/gm, "");
const verdict = JSON.parse(judgeText.slice(judgeText.indexOf("{"), judgeText.lastIndexOf("}") + 1));
const credit = { present: 1, partial: 0.5, absent: 0, contradicted: 0 };
const recall = verdict.facts.reduce((s, f) => s + (credit[f.verdict] ?? 0), 0) / ref.facts.length;

const score = {
	round,
	video: key,
	trial: Number(n),
	model,
	recall: Math.round(recall * 1000) / 1000,
	contradicted: verdict.facts.filter((f) => f.verdict === "contradicted").length,
	conflicts: verdict.conflicts,
	toolCalls: toolUses.map((u) => u.name.replace("mcp__gphotos__", "")),
	videoResults: sizes,
	maxEstTokens: Math.max(0, ...sizes.map((s) => s.estTokens)),
	anyTruncated: sizes.some((s) => s.truncated),
	costUsd: final?.total_cost_usd,
	judgeCostUsd: judgeEnvelope.total_cost_usd,
	durationS: Math.round((Date.now() - t0) / 1000),
	turns: final?.num_turns,
	facts: verdict.facts,
};
writeFileSync(join(out, "score.json"), JSON.stringify(score, null, 2));
console.log(
	JSON.stringify({
		round,
		video: key,
		trial: n,
		recall: score.recall,
		contradicted: score.contradicted,
		maxEstTokens: score.maxEstTokens,
		anyTruncated: score.anyTruncated,
		tools: score.toolCalls.join(","),
		cost: score.costUsd,
		judge: score.judgeCostUsd,
		s: score.durationS,
	}),
);
