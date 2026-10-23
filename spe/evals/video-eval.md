# Video tool eval (2026-10-22)

## Why

In the first live run, `watch_video` returned about 16,500 estimated tokens. Claude Code showed its large-response warning and then truncated the result at its 25,000-token limit. The loop's goal was to stay under the warning without losing description quality.

## How Claude Code sizes an MCP result (2.1.308, read from the binary)

- Text counts as `round(characters / 4)`. Each image counts as 1,600 tokens, whatever its size.
- Above 10,000 it shows "Large MCP response". Above 12,500 it asks the API for a real count, and it truncates above 25,000 (`MAX_MCP_OUTPUT_TOKENS`).
- The model API scales images down to about 1.15 megapixels and 1568 px on a side. A larger image costs upload time and adds nothing.

## Harness

- `spe/evals/video-trial.mjs <round> <video> <n>` runs one headless `claude -p` session against the built server with the prompt "I want you to watch the video at <path> and tell me what you see". It records the tool calls, the size of each video result, and whether it was truncated.
- A text-only Opus judge grades the answer against reference facts that were written from 1 fps contact sheets before any trial ran. Each fact is present (1), partial (0.5), absent, or contradicted. The judge also lists conflicts.
- Fixtures: two Pixel 10 Pro XL clips from Google Photos (a 26 s portrait selfie with speech, a 13 s landscape rain clip with no speech), with 16 and 14 facts. They live in the gitignored `spe/evals/fixtures/video/`.

## Results

| Round | Change | Selfie recall | Rain recall | Largest result (est. tokens) | Truncated | Cost per run |
|---|---|---|---|---|---|---|
| r0 (1 trial each) | Baseline: up to 6 storyboards, 4 motion strips, spectrogram inline | 0.94 | 0.82 | 16,577 | yes | $0.15 to $0.27 |
| r1 (2 each) | Budget under 10k: 3 boards of 12, spectrogram, images sized to 1.15 MP, weak poses dropped | 0.86 | 0.75 | 8,006 | no | $0.13 to $0.16 |
| r2 (2 each) | Up to 4 boards of 9 | 0.89 | 0.88 | 9,671 | no | $0.14 to $0.16 |
| r3 (3 each) | Server instructions list what a description covers and say to open keyframes for small details | 0.97 | 0.93 | 9,671 | no | $0.18 to $0.19 |
| r4 (2 each) | Digest path counted in the budget and moved to the top, overview boards for long videos | 0.98 | 0.88 | 9,673 | no | $0.17 to $0.19 |
| e2e (1) | r3 code through the real picker, selected with Playwright | 1.00 | | 9,717 | no | $0.21 |

Total spend: $5.04 (trials and judge).

## Findings

- Images drive the size. Nine portrait storyboards were 14,400 of the 16,577 baseline tokens.
- Packing 12 frames per board lost small details, such as the chest gesture, the fan blades, and the balcony decoration. Nine per board brought them back.
- The biggest quality gain came from the instructions. When told what to cover, Claude opened 2 to 4 keyframes and sometimes called `inspect_video` on its own.
- The rain clip's only conflict, in r1 and r4, is the judge marking "gray house" against a reference that says "white". The siding is a very pale gray-white. The reference was left unchanged so rounds stay comparable.
- A 15.7-minute screen recording took 45 s and returned 9,200 estimated tokens: one 12-frame overview board, the spectrogram, and the first 24,000 characters of the digest, with its file path at the top.

## Not covered

- Only two short clips. Long videos were checked for size and time only, not for answer quality.
- One judge model and no human calibration of the judge.
