# Video spike findings (2026-10-22)

## Setup

- `brew install whisper-cpp` gives `/opt/homebrew/bin/whisper-cli`. Flags used: `-m`, `--vad -vm`, `-l auto`, `-oj -of`, `-np`.
- Models: `ggml-large-v3-turbo.bin` (1.62 GB, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin`) and `ggml-silero-v5.1.2.bin` (0.9 MB, `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin`).
- CLAP: `laion/larger_clap_general` through `uv run` with `transformers==5.20.2`. In transformers 5, `get_text_features` and `get_audio_features` return a `BaseModelOutputWithPooling`. The projected 512-d embedding is `pooler_output`. The processor argument is `audio=`, not `audios=`.
- The Swift helper builds with the Command Line Tools only (Swift 6.1.2, macOS SDK 15.5) in about 4 s.

## Test video

30 s, 1280x720. Scene 1 (0 to 10 s) is still color bars with `say` speech from 1.0 s. Scene 2 (10 to 20 s) is a white box moving right at 100 px/s, with a 440 Hz tone from 12 to 15 s. Scene 3 (20 to 30 s) is a pan over a still image at 100 px/s, with a 0.15 s noise burst at 24.0 s.

## Results

| Stage | Result |
|---|---|
| whisper-cli | All four sentences exact, segment times within 0.1 s. 5 min of real meeting audio in 9 s (33x real time). |
| ffmpeg scene score at 4 fps, 160 px | Cuts at 10.0 s (0.88) and 20.0 s (0.66). The small box scores only 0.001, so scene score cannot measure motion. |
| Vision optical flow at 4 fps, 320 px | Box: subject moving right, region and y center correct. Pan: uniform median flow, no subject. Flow magnitude reads about half the true value at medium accuracy. Direction is right. 32 real frames took 1 s. Featureless black frames add noise to the median. |
| Vision translational registration | Exact 6 px shift on the pan. On the box scene it locks onto the box, so it is only trusted when the median flow agrees. |
| Vision homography scale | Noise of about ±2% on still frames. Zoom needs more than 3% per step. |
| SoundAnalysis | Speech, and the tone as tuning fork and synthesizer, are right. Digital silence reads as "music 0.336", so the floor must be 0.5 or more. The 0.15 s burst is missed. On a real galloping-horse clip it said "firecracker". |
| ebur128 momentary loudness | The burst shows as a jump from -149 to -11.5 LUFS. Digital silence prints as -inf or nan. |
| CLAP | Real horse clip: "a horse galloping" 0.27 to 0.33, "a dog barking" -0.10. Brass peaks where SoundAnalysis also found brass. On the synthetic audio it scores digital silence high and misses the short burst, so silent windows must be skipped and short sounds left to onsets. CLAP is weak on speech, which whisper covers. |
| Vision OCR | Exact on a rendered slide and on a real video watermark. 2 images in 0.45 s. |
| Vision body pose | Finds a person in each frame of two real clips that show one. |
| `showspectrumpic` | Clear picture of speech, tone, and burst with a time axis. |
| `tmix` motion trail | A flat average is too faint. Weighted onion skin works. ffmpeg applies the first weight to the newest frame. |
| Frame strip (`tile`) | Clearly shows the gallop sequence. Reads better than the trail. |

## Gates

- whisper faster than real time: pass (33x).
- Swift helper builds with only the Command Line Tools: pass.
- CLAP separates a present phrase from an absent one: pass on real audio, fail on the synthetic 0.15 s burst. Onsets cover that case.

## Design changes from the spike

- Motion comes from Vision optical flow, not scene score.
- The SoundAnalysis floor is 0.5, and windows the loudness track marks silent are dropped.
- CLAP skips silent windows and reports scores in bands instead of a yes or no.
- Motion images are weighted onion-skin trails plus frame strips.

## Calibration on real phone video (Pixel 10 Pro XL, 4K, 13 s landscape and 26 s portrait)

- Translational registration was dropped. On featureless frames it locked onto the moving box. On a tracking shot it locked onto the horse.
- Median flow plus a radial zoom fit read handheld roll as subject motion over 90 to 99% of the frame. A robust affine fit replaced both. It refits 4 times without outliers and uses a residual cut of 2.5 times the median residual. Subject area in the selfie clip fell to 0 to 27%. The box and the horse's legs are still found.
- Homography scale was noisy, so zoom is now the divergence of the affine fit.
- Per-pair camera labels flipped between up and down with hand shake. Labels now come from a window of about 1.75 s. A direction counts only when its net movement is at least half the total movement. Still is below 0.04 frame widths per second, a pan needs 0.04, and a zoom needs 0.08.
- Loudness onsets carry no lag correction. The meter crossed the jump within 0.1 s of the true start. Onsets inside speech are dropped.
- A fast phone swing scores above the cut threshold, so the digest says "shot" and explains that a fast move can start one.
