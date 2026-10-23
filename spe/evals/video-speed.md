# Video speed eval (2026-10-22)

## Goal

Make `watch_video` faster without losing quality. Quality was checked two ways. `spe/evals/video-compare.mjs` compares pipeline output against a baseline snapshot with code checks: transcript text, sound events, cuts, camera and subject labels per 0.5 s, keyframe count and shift, OCR recall and extra lines, people count, and result size. Paid headless trials scored the final build against the reference facts used in `video-eval.md`.

## Method

1. Profiled each stage on both fixtures. The serial stage sum for the selfie clip was 16 s, against a 21.6 s wall time. The extra came from motion strips, which no stage measured.
2. A workflow built 7 speedup packages in separate worktrees. Each package passed the tests and the compare gates. A completeness critic then listed missed ideas and weak gates.
3. Each package was benchmarked alone, serially, on a quiet machine. Agents' own timings were not used, because they ran under load averages of 12 to 75.
4. The winners were stacked one at a time, checking compare output and time after each step.
5. Three reviewers with distinct lenses checked the merged diff. Two skeptics per finding tried to refute each one. All 12 findings were fixed, and the crash finding was confirmed with a positive control.

## Packages, benchmarked alone (wall time, fresh folder)

| Package | Rain | Selfie | Kept |
|---|---|---|---|
| Baseline | 14.9 s | 21.6 s | |
| single-pass: one decode writes motion frames and 1280 px keyframe candidates | 8.4 s | 13.0 s | yes |
| drop-strips: no motion strips or trails in watch_video (never opened in 13 trials) | 8.6 s | 15.0 s | yes |
| hw-decode: VideoToolbox | 9.1 s | 13.5 s | yes, HEVC only |
| overlap: scheduling | 10.2 s | 15.4 s | rewritten on the merged code |
| flow-speed: optical flow across 3 helper processes | 15.3 s | 19.7 s | yes, it matters once decode is fast |
| ocr-speed: OCR across 4 helper processes | 15.0 s | 22.0 s | yes, worth 0.2 to 0.4 s on the stack |
| watch-cache: saved result for repeat calls | 15.4 s | 21.2 s | yes, rewritten |

## Stack (each row adds to the one above)

| Step | Rain | Selfie | Compare gate |
|---|---|---|---|
| single-pass + drop-strips + people fix | 5.0 s | 9.8 s | pass (people: see below) |
| + VideoToolbox, split before each branch's fps | 4.0 s | 7.6 s | identical |
| + parallel flow | 3.0 s | 5.3 s | identical |
| + parallel OCR | 2.8 s | 4.9 s | identical |
| + keyframes, OCR, and pose start when motion ends; boards built alongside OCR | 2.3 s | 4.3 s | identical digest |
| + watch cache, prefetch after pick, review fixes | 2.3 s | 4.4 s | identical |

Final, 3 runs each: rain 2.25 to 2.30 s (6.5x), selfie 4.30 to 4.33 s (5.0x). A repeat call takes about 1 ms (was 11.6 s and 14.0 s). inspect_video takes 2.4 s and 2.8 s (was 3.8 s and 4.4 s). A 15.7-minute 1080p H.264 screen recording takes 35 s (was 45 s), where whisper is now the slowest branch.

After a pick, up to 3 picked videos are watched in the background. When Claude calls watch_video a few seconds later, much or all of the work is already done.

## Quality

- Compare gates against baseline: the transcript, sounds, cuts, camera and subject labels, OCR, and size are identical. People changed on purpose. Body pose alone reported a person on the empty rain street (baseline f02) and missed the close selfie face. People now come from Vision human rectangles, or faces when no body box fits, and skeletons add posture only. Rain now reports nobody, and the selfie reports a person in 17 of 32 keyframes.
- Paid trials on the final build (2 per clip, $0.14 to $0.19 each, judge $0.07 to $0.08): selfie recall 1.00 and 0.97, rain 0.93 and 0.89, no truncation. Round 4 before the speedups: selfie 1.00 and 0.97, rain 0.93 and 0.82.

## Findings that changed the design

- A shared 8 fps stage before the 4 fps motion branch picked different source frames and broke cuts and camera labels (camera agreement 0.51). Splitting first, then running each branch's own fps on the GPU, kept motion byte-identical.
- VideoToolbox was 2x faster than software for HEVC, 1.5x slower for H.264 at 1080p and 4K, and 14x slower for a long 1080p H.264 recording sampled at 1.3 fps. It is used for HEVC only, with a logged software retry if it fails.
- A storyboard job left un-awaited during OCR crashed the server on cancel (Node exits on unhandled rejections), and the exit handler then deleted the picked sets. It was found in review, reproduced, and fixed. Removing the fix made the cancel test exit with code 1.

## Rejected

- Lower flow resolution, `.low` accuracy, and flow revision 1: camera agreement fell to 0.15 to 0.74.
- OCR fast level, language settings, and skipping similar frames: these lost text or saved nothing.
- A GPU rotate (transpose_vt): its pixels were not byte-identical.

## Not covered

- Long videos were timed but not quality-scored. There was no clip with no audio and lots of motion, no text-heavy screen recording scored for OCR, and no edit with many cuts.
- The rain clip's fast opening whip is labeled "pans right" in both the baseline and the new build. One trial repeated that label. Whether it is right was not settled.
