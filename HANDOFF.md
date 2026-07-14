# HANDOFF — ComfyUI video backend (unattended run)

Status: IN PROGRESS — this file is updated per milestone; if you're reading a
partial version, the last section tells you where work stopped.

## Discovery (logged, no gate)

- **Install root**: `D:\Devlopment\AI\ComfyUI` (portable build; `run_nvidia_gpu.bat`
  runs `.\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build`).
  App base: `D:\Devlopment\AI\ComfyUI\ComfyUI`. Port: default **8188** confirmed.
- **Versions** (from `/system_stats`): ComfyUI **0.27.0**, Python 3.13.12 embedded,
  **PyTorch 2.12.0+cu130**, device `cuda:0 RTX 3080` (10 GB, cudaMallocAsync).
- **Video nodes**: modern core ships LTX-Video nodes (`EmptyLTXVLatentVideo`,
  `LTXVConditioning`, `LTXVScheduler`, `LTXVImgToVideo`, …) plus core video I/O
  (`CreateVideo`, `SaveVideo` — mp4/h264, `SaveWEBM`, `LoadVideo`). 800 nodes total.
  No third-party custom nodes installed (stock `custom_nodes/`).
- **Models: NONE installed.** Every `models/` subdir contains only placeholder
  files. LTX-Video weights (`ltx-video-2b-*.safetensors` + `t5xxl` text encoder)
  are absent → real LTX generation is BLOCKED (see BLOCKED section).
- **Electron main = Node 20.18.3 → no global WebSocket.** The WS client is
  hand-rolled on `http` + `crypto` builtins (receive text frames, answer pings;
  ComfyUI's binary preview frames are skipped). Zero new dependencies.

## What got built

(filled in per milestone below)

## Judgment calls made on your behalf

1. **Validation without model weights**: shipped TWO workflow pairs —
   `ltx-video-t2v` (the required LTX template; structurally valid, cannot run
   without weights) and `smoke-test` (EmptyImage → CreateVideo → SaveVideo,
   zero models needed, produces a real h264 mp4). The smoke pair lets every
   pipeline stage be validated end-to-end today on this machine.

## BLOCKED

- **LTX-Video real generation**: no model weights on disk. To unblock, download
  `ltx-video-2b-v0.9.5.safetensors` → `ComfyUI\models\checkpoints\` and
  `t5xxl_fp16.safetensors` → `ComfyUI\models\text_encoders\`, then pick
  "LTX-Video — text to video" in the panel. No code changes needed.

## What you need to do next

(filled in at the end)
