# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["torch>=2.5", "transformers==5.20.2", "soundfile", "numpy"]
# ///
"""Scores free-text sound descriptions against an audio file with the open CLAP model.

Usage: uv run clap.py <16 kHz mono wav> <phrases json array> [window_s] [hop_s]
Prints JSON to stdout: {"windows": [[start, end], ...], "scores": {phrase: [cosine per window]}}.
Logs go to stderr.
"""

import json
import sys

import numpy as np
import soundfile as sf
import torch
from transformers import ClapModel, ClapProcessor

MODEL = "laion/larger_clap_general"
RATE = 48000  # CLAP expects 48 kHz input.


def log(*parts):
    print("clap:", *parts, file=sys.stderr, flush=True)


def features(out):
    # transformers 5 wraps projected embeddings in a BaseModelOutputWithPooling.
    return out if isinstance(out, torch.Tensor) else out.pooler_output


def main():
    path, phrases = sys.argv[1], json.loads(sys.argv[2])
    window = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
    hop = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    if not phrases:
        raise SystemExit("clap: no phrases given")

    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if rate != RATE:
        # Linear resampling is enough for an embedding model that already smooths over seconds.
        n = int(len(audio) * RATE / rate)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)

    duration = len(audio) / RATE
    starts = np.arange(0, max(duration - window, 0) + 1e-6, hop)
    windows = [(float(s), float(min(s + window, duration))) for s in starts]
    clips = [audio[int(s * RATE) : int(e * RATE)] for s, e in windows]

    log(f"loading {MODEL}")
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = ClapModel.from_pretrained(MODEL).to(device).eval()
    processor = ClapProcessor.from_pretrained(MODEL)

    with torch.no_grad():
        t = processor(text=phrases, return_tensors="pt", padding=True)
        text_emb = features(model.get_text_features(**{k: v.to(device) for k, v in t.items()}))
        text_emb = torch.nn.functional.normalize(text_emb, dim=-1)
        audio_embs = []
        for i in range(0, len(clips), 16):
            a = processor(audio=clips[i : i + 16], sampling_rate=RATE, return_tensors="pt")
            emb = features(model.get_audio_features(**{k: v.to(device) for k, v in a.items()}))
            audio_embs.append(torch.nn.functional.normalize(emb, dim=-1))
        audio_emb = torch.cat(audio_embs)
        sims = (audio_emb @ text_emb.T).cpu().numpy()

    out = {
        "windows": [[round(s, 3), round(e, 3)] for s, e in windows],
        "scores": {p: [round(float(v), 4) for v in sims[:, j]] for j, p in enumerate(phrases)},
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
