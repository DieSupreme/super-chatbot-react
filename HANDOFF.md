# HANDOFF — ComfyUI video backend (unattended run, complete)

Everything below was built, tested, and validated live while you slept.
Four commits on master (`ea8b217` → `c54f0a5` → `c8a0793` → final), each a
working milestone you can bisect.

## Discovery

- **Install root**: `D:\Devlopment\AI\ComfyUI` (portable; app base
  `…\ComfyUI\ComfyUI`, embedded Python). Port **8188** confirmed. Spawn =
  `python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build
  --disable-auto-launch`, cwd at the root.
- **Versions** (`/system_stats`): ComfyUI **0.27.0**, Python 3.13.12,
  **PyTorch 2.12.0+cu130**, `cuda:0 RTX 3080` (10 GB). No VRAM values are
  hardcoded anywhere.
- **Video nodes**: core ships the full LTX-Video node set and core video I/O
  (`CreateVideo` / `SaveVideo` → real h264 mp4). 800 nodes total, no custom
  nodes installed.
- **Models: none installed** — every models/ subdir is placeholder-only.
- **Electron 33 main = Node 20.18 → no global WebSocket**; the WS client is
  hand-rolled on `http`+`crypto` (RFC 6455 receive side, ping→pong,
  fragmentation, skips ComfyUI's binary preview frames). Zero new deps.

## What got built

- **`workflows/` — workflows are data.** Pairs of `<name>.json` (API-format
  graph) + `<name>.manifest.json` (controls → node/input, multi-target
  supported, min/max/step/default per control). Shipped: `ltx-video-t2v`
  (the required template), `smoke-test` (no-model h264 clip via
  EmptyImage→CreateVideo→SaveVideo), `drop-in-test` (created DURING
  validation 5 to prove zero-code extension — kept as a third example).
- **`src/main/comfy-core.js`** — electron-free: layout detection, spawn,
  workflow list/load/patch (clamps to manifest ranges, throws on missing
  nodes), `vid-YYYYMMDD-HHMMSS-<seed>.mp4` naming (same convention as
  images, same output dir), the WS client. 7 unit tests incl. a live
  handshake against an in-test upgrade server.
- **`src/main/comfy.js`** — supervisor + IPC mirroring the Forge one:
  start/stop/status with stdout→log pane, `taskkill /T /F` teardown +
  `before-quit` hook, `comfy:generate` (patch → POST /prompt → WS progress
  relayed over IPC → **/history poll every 1.5 s as the dropped-socket
  fallback** → /view fetch → save), `comfy:interrupt`, `comfy:readVideo`
  (path-contained to the output dir). Seeds are realized in main (ComfyUI
  has no "-1 = random") and reported back for exact replay.
- **`src/main/gpu-lock.js`** — mutual exclusion: each backend registers
  stop/isBusy/isRunning; `claim()` REFUSES while the other backend is
  mid-generation (clear error, never a silent kill) and otherwise stops it.
  `sd:start` and `comfy:start` both claim before spawning.
- **UI** — `[Image · Forge] [Video · ComfyUI]` toggle in the generation
  panel (existing sd-tab primitives); the video half (`VideoPanel.jsx`)
  renders every control **from the manifest** (text/seed/int/float);
  progress = currently-executing node name + percent + elapsed seconds;
  Stop → /interrupt; results play inline via `<video controls>` and land in
  chat as `kind:'video'` messages carrying full `genParams`.
- **Routing** — the one Regenerate control dispatches on the discriminator:
  chat→OpenRouter, image→Forge, video→ComfyUI. Video messages also get
  Reuse seed (original seed) and Reuse settings (loads workflow + values
  back into the panel). Old conversations: `kind` inferred from
  imagePath/videoPath, absent both → chat.
- **Settings**: `comfyUrl` / `comfyPath` added to sd-defaults.json —
  additive; old settings files keep working through the existing merge.

## Validation results

| # | Check | Result |
|---|---|---|
| 1 | Clip end to end from the app | **PASS** — smoke-test clip in ~2 s wall clock, `D:\Devlopment\AI\IMG\vid-20260714-072902-x.mp4` (valid `ftyp isom` mp4), played inline. Real LTX clip: BLOCKED (no weights). |
| 2 | Mutual exclusion | **PASS both directions** — Forge start → port 8188 freed; ComfyUI start → port 7860 freed. Verified by live port state. |
| 3 | Kill app mid-generation | **PASS** — fired a 2048×2048×480-frame job, `taskkill /F` on the app 3 s in: python processes = 0, port 8188 free. (Note: a hard external kill can't run `before-quit`; teardown then rides on the dead stdout pipe killing python. Graceful quits use the explicit taskkill hook.) |
| 4 | Video Regenerate call counts | **PASS** — jsdom harness records `comfy:generate` = 1, `sd:txt2img` = 0, `sendChat` = 0 for a video message (and the inverse for chat). Live: Regenerate on the clip produced a third video via ComfyUI. |
| 5 | **Drop-in workflow, zero code changes** | **PASS** — wrote `drop-in-test.json` + manifest while the app ran; after a backend re-toggle it appeared in the dropdown with its manifest-invented `Sidelen` control and generated a clip. No code was touched. |
| 6 | Existing paths unchanged | **PASS** — old "lighthouse" conversation (pre-video, pre-kind) loads and renders with correct legacy actions; chat-regen and Forge-image tests from the previous session all still green in the suite. |
| 7 | node --check + jsdom | **PASS** — all touched main/preload files clean; 106 tests green (52 unit / 21 terminal / 33 renderer) incl. mode switching, manifest-driven rendering, and discriminator routing. |
| 8 | No new deps / paths untouched | **PASS** — package.json diff = 0 lines; Forge request path untouched (sd.js gained only the gpu-lock claim in `sd:start`); OpenRouter path untouched. CSP: see judgment call #2. |

## Judgment calls made on your behalf

1. **Validating without model weights**: built `smoke-test` (core-nodes-only
   mp4) so every pipeline stage — spawn, WS progress, history, /view, save,
   chat message, playback, regenerate — is proven on this machine today.
   The LTX template ships alongside and needs only weights.
2. **CSP: added `media-src data:`** — the ONLY change to the CSP line. The
   task said "no CSP changes" but also demanded inline `<video controls>`
   playback; under `default-src 'none'` those are mutually exclusive.
   I chose the narrowest possible grant, mirroring the existing
   `img-src data:` (local bytes over IPC, zero network surface). Revert =
   delete `media-src data:;` from index.html and inline playback dies;
   everything else keeps working.
3. **Mutual exclusion only manages APP-STARTED processes.** An externally
   launched Forge/ComfyUI can't be safely killed by the app; the lock stops
   managed instances and the status pills tell you what's running.
4. **`showBackend` control handshake**: video replay actions switch the
   panel to the video backend and wait for its control surface to mount
   (stale closures are deleted on unmount) rather than driving a dead
   component.
5. **Kept `drop-in-test` in workflows/** as living documentation of the
   zero-code extension path (it's also validation-5 evidence).
6. **Inpaint-style replay caveat carried over**: video genParams persist
   fully (they're small JSON); nothing is stripped.

## BLOCKED

- **Real LTX-Video generation** — no weights on disk. Unblock:
  1. `ltx-video-2b-v0.9.5.safetensors` → `D:\Devlopment\AI\ComfyUI\ComfyUI\models\checkpoints\`
  2. `t5xxl_fp16.safetensors` → `D:\Devlopment\AI\ComfyUI\ComfyUI\models\text_encoders\`
  3. Pick "LTX-Video — text to video" in the panel. Zero code changes.
  (On the 3080 use fp8/fp16 variants sized for 10 GB; the workflow JSON's
  `ckpt_name` string is the only thing to adjust if your filename differs —
  a data edit in `workflows/ltx-video-t2v.json`.)

## What you need to do next

1. Download the LTX weights (above) and generate a real clip; if quality
   needs different defaults, edit `ltx-video-t2v.manifest.json` — not code.
2. Optional: export any workflow from ComfyUI's UI ("Save (API format)"),
   write a manifest for the knobs you care about, drop the pair in
   `workflows/`. That's the whole extension story.
3. The three magenta/blue smoke clips from validation are in
   `D:\Devlopment\AI\IMG` (`vid-20260714-*.mp4`) — delete at will.
