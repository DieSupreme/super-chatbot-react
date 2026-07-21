# HANDOFF — Super Duper Lustify (Krea2) workflow registration (unattended run)

Task: register `workflows/Super_Duper_Lustify_Final.json` as an app workflow and
verify it end to end. Previous run's handoff (ComfyUI video backend) is in git
history at `1ebc604^..1ebc604` if you need it back.

## PART 0 — what the JSON actually is, and the resolved node ids

**The file is NOT an API-format export.** It is ComfyUI's default Ctrl+S
UI/graph export (`nodes[]` + `links[]` + `groups[]`, positional
`widgets_values`). The task brief said API format; the file on disk disagrees.
See judgment call #1 for how that was handled without touching the file.

Node ids, resolved by WIDGET VALUES as instructed:

| Role | id | Evidence (widgets_values) |
|---|---|---|
| BASE KSampler (user-facing seed) | **201** | `[0, "randomize", 8, 1, "euler", "simple", 1]` → 8 steps, denoise **1** |
| Refine KSampler stage 2 — NOT exposed | **207** | `[0, "randomize", 16, 1, "euler", "simple", 0.35]` → denoise **0.35** |
| Refine KSampler stage 3 — NOT exposed | **210** | `[0, "randomize", 10, 1, "euler", "simple", 0.2]` → denoise **0.2** |
| Prompt CLIPTextEncode | **198** | `["PASTE YOUR PROMPT HERE"]` |
| Size EmptySD3LatentImage | **200** | `[1216, 832, 1]` |
| SaveImage FINAL (must be surfaced) | **203** | `["krea2_final"]`, fed by stage-3 decode (node 208) |
| SaveImage base preview | **211** | `["krea2_base"]`, fed by stage-1 decode (node 202) |
| Bypassed edit-mode branch (mode 4, never executes) | **250** (LoadImage), **251** (VAEEncode) | greyed-out img2img branch |
| MarkdownNote (display only) | **259** | usage notes |
| ImageScale (baked 2x target) | **209** | `["lanczos", 2432, 1664, "disabled"]` |

Negative prompt: none by design — node **199** `ConditioningZeroOut` feeds all
three samplers' negative inputs. cfg is locked at 1 in all samplers (distilled
Krea2). Upscale chain: 202 decode → 204 `ImageUpscaleWithModel`
(4x_NMKD-Siax_200k) → 209 downscale to 2432x1664 → 206 re-encode → 207 → 210 →
208 decode → 203 save.

Stale-link note: the links table still contains link 501 (bypassed 251 → 201)
from the author's edit-mode rewiring, but node 201's own input record says
`latent_image ← link 398` (from 200). The converter trusts the per-node input
records, so this is harmless.

## What was built

- **`workflows/Super_Duper_Lustify_Final.manifest.json`** — label
  "Super Duper Lustify (Krea2, high quality)", `media: "image"`,
  `backend: "comfy"`, `output: "203"`, controls ONLY:
  `prompt → 198.text`, `seed → 201.seed`, `width → 200.width` (default 1216),
  `height → 200.height` (default 832). Nothing else is exposed.
- **`src/main/comfy-core.js` — `uiGraphToApi` (+ `isUiGraph`, `uiGraphTypes`)**:
  converts a UI/graph export to the API format `/prompt` expects, at generate
  time, using `/object_info` for the positional widget→input-name mapping.
  Handles: bypassed nodes (mode 4) dropped with link pass-through, muted
  (mode 2) dropped, notes dropped, seed `control_after_generate` slot skipped,
  widgets promoted to inputs, unknown node types → clear error. `_meta.title`
  is preserved so node-level progress shows real names.
- **`src/main/comfy-core.js` — `pickHistoryOutput`**: a manifest may pin the
  node whose files are THE result (`"output": "<id>"`). Without it, the old
  behavior (first media-matching file across all outputs) was only surfacing
  krea2_final by the accident of JS integer-key ordering (203 < 211). Now it
  is explicit; if the pinned node produced nothing it falls back to all
  outputs and logs a warning.
- **`src/main/comfy.js`** — in `comfy:generate`: detect UI-format graph →
  fetch `/object_info/<Type>` per distinct type (reusing the existing
  objectInfoCache, dropped on server restart) → convert → patch → POST.
  Output picking now goes through `pickHistoryOutput`.
- **Zero renderer changes.** The image-mode unified model list, manifest-driven
  controls, comfy routing, progress UI, Stop→/interrupt, and kind:'image' chat
  delivery were already generic (built last session); the manifest drop was
  enough to surface the workflow.

## Judgment calls

1. **The workflow JSON is a UI export, but the constraint said "do not modify
   the workflow JSON."** Options were (a) hand-write a parallel API-format
   file and register that, or (b) teach the app to accept UI exports. Chose
   (b): the file ships byte-identical to how it was given, and the app gains
   the ability to swallow ComfyUI's DEFAULT export format — every future
   workflow drop no longer requires the "Save (API format)" dance. Conversion
   needs `/object_info` (widget order is positional), which is why it happens
   at generate time when the server is up anyway.
2. **`output` manifest field added** rather than relying on key order or
   filename sniffing to pick krea2_final over krea2_base. Data-driven, matches
   the existing manifest vocabulary, backward compatible (older manifests have
   no `output` → old behavior).
3. **Seed exposed only for the base sampler (201).** The refine samplers keep
   their exported seeds; their noise contribution at denoise 0.35/0.2 is part
   of the tuned look. (They also had `control_after_generate: "randomize"` in
   the editor, but API-format execution does not apply that — fixed values.)
4. **Width/height ranges 256–2048 step 16**, same as the krea2-lustify
   manifest, defaults 1216/832 per the task.
5. **HANDOFF.md replaced** — the previous run's video-backend handoff is fully
   preserved in git history (`git show 1ebc604:HANDOFF.md`).

## Validation results — ALL PASS

Live runs were driven through the REAL app: built renderer, real Electron
main, real IPC, real ComfyUI — automated over CDP (`--remote-debugging-port`),
clicking the same buttons you would.

| # | Check | Result |
|---|---|---|
| 1 | Workflow appears in IMAGE mode | **PASS** — "Super Duper Lustify (Krea2, high quality)" listed in the unified image model dropdown next to Forge checkpoints; selecting it mounted the ComfyUI image body. Visible controls were exactly `["Prompt","Seed","Width","Height"]`. |
| 2 | Routing counts | **PASS** — ComfyUI `/history` shows exactly **2 prompts** for the 2 Generate clicks (POST /prompt = 1 per generation). **Forge: 0 calls** (port 7860 had no listener the entire run — nothing to receive a call). **OpenRouter: 0 calls** (no chat turn ever initiated; renderer test additionally asserts comfy:generate=1, sd:txt2img=0, sd:img2img=0, sendChat=0 for this workflow). |
| 3 | Chat image is krea2_final | **PASS** — run A: `img-20260714-215757-12345.png` at **2432×1664** (not 1216×832), 496 s. ComfyUI history confirms node 203 (krea2_final) and node 211 (krea2_base) both produced files and the app saved the final. Chat shows the image inline with Regenerate / Reuse seed / Reuse settings / img2img / inpaint actions. |
| 4 | Seed change → different image | **PASS** — run B (seed 54321): `img-20260714-221125-54321.png`, also **2432×1664**, 807 s. sha256 `649a13c0…` (A) vs `b3570497…` (B) — different images. |
| 5 | Progress UI | **PASS** — node-level phases streamed the whole time (CLIPTextEncode → KSampler 13→100% → VAEDecode → ImageUpscaleWithModel → VAEEncode → refine KSampler 6→100% → cleanup KSampler 10→90%), elapsed counter ticking; never froze during the ~3 min gap where the Siax model loaded (elapsed kept counting). Stop button wired to /interrupt (not exercised against a paid run). |
| 6 | Existing paths unchanged | **PASS** — full suite green: **63 unit** (incl. 6 new) + 21 terminal + **38 renderer** (incl. 1 new). Old "testing" conversation from Jul 3 opened live in the app: 6 messages render, no crash. Forge/OpenRouter code untouched (`git diff 1ebc604..HEAD -- src/main/sd.js src/main/sse.js` is empty). |
| 7 | Cleanup | **PASS** — ComfyUI stopped through the app's own Stop button; after app quit: no python.exe, no electron.exe, no listeners on 8188/7860. |

### The exact /prompt body (run A, seed 12345), as ComfyUI recorded it

17 nodes — bypassed 250/251 and note 259 correctly absent; only
198.text / 201.seed / 200.width / 200.height differ from the exported file
(201.seed realized by the app; run B identical except seed 54321):

```json
{"195":{"inputs":{"unet_name":"lustifyNSFWCheckpoint_v10Krea2.safetensors","weight_dtype":"default"},"class_type":"UNETLoader"},
 "196":{"inputs":{"clip_name":"qwen3vl_4b_fp8_scaled.safetensors","type":"krea2","device":"default"},"class_type":"CLIPLoader"},
 "197":{"inputs":{"vae_name":"qwen_image_vae.safetensors"},"class_type":"VAELoader"},
 "198":{"inputs":{"text":"a lighthouse on a rocky coast at golden hour, dramatic clouds, photorealistic","clip":["196",0]},"class_type":"CLIPTextEncode"},
 "199":{"inputs":{"conditioning":["198",0]},"class_type":"ConditioningZeroOut"},
 "200":{"inputs":{"width":1216,"height":832,"batch_size":1},"class_type":"EmptySD3LatentImage"},
 "201":{"inputs":{"model":["195",0],"seed":12345,"steps":8,"cfg":1,"sampler_name":"euler","scheduler":"simple","positive":["198",0],"negative":["199",0],"latent_image":["200",0],"denoise":1},"class_type":"KSampler"},
 "202":{"inputs":{"samples":["201",0],"vae":["197",0]},"class_type":"VAEDecode"},
 "203":{"inputs":{"images":["208",0],"filename_prefix":"krea2_final"},"class_type":"SaveImage"},
 "204":{"inputs":{"upscale_model":["205",0],"image":["202",0]},"class_type":"ImageUpscaleWithModel"},
 "205":{"inputs":{"model_name":"4x_NMKD-Siax_200k.pth"},"class_type":"UpscaleModelLoader"},
 "206":{"inputs":{"pixels":["209",0],"vae":["197",0]},"class_type":"VAEEncode"},
 "207":{"inputs":{"model":["195",0],"seed":0,"steps":16,"cfg":1,"sampler_name":"euler","scheduler":"simple","positive":["198",0],"negative":["199",0],"latent_image":["206",0],"denoise":0.35},"class_type":"KSampler"},
 "208":{"inputs":{"samples":["210",0],"vae":["197",0]},"class_type":"VAEDecode"},
 "209":{"inputs":{"image":["204",0],"upscale_method":"lanczos","width":2432,"height":1664,"crop":"disabled"},"class_type":"ImageScale"},
 "210":{"inputs":{"model":["195",0],"seed":0,"steps":10,"cfg":1,"sampler_name":"euler","scheduler":"simple","positive":["198",0],"negative":["199",0],"latent_image":["207",0],"denoise":0.2},"class_type":"KSampler"},
 "211":{"inputs":{"images":["202",0],"filename_prefix":"krea2_base"},"class_type":"SaveImage"}}
```

(`_meta.title` fields omitted above for brevity; they are present and drive the
progress labels.)

### The manifest, verbatim

```json
{
  "label": "Super Duper Lustify (Krea2, high quality)",
  "backend": "comfy",
  "media": "image",
  "output": "203",
  "controls": {
    "prompt": { "node": "198", "input": "text", "type": "textarea", "group": "Basic" },
    "seed":   { "node": "201", "input": "seed", "type": "seed", "group": "Basic" },
    "width":  { "node": "200", "input": "width",  "type": "int", "default": 1216, "min": 256, "max": 2048, "step": 16, "group": "Basic" },
    "height": { "node": "200", "input": "height", "type": "int", "default": 832, "min": 256, "max": 2048, "step": 16, "group": "Basic" }
  }
}
```

## BLOCKED

Nothing. Every check ran to completion on this machine.

## What you do next

- Nothing required — the workflow is live. The two verification images
  (lighthouse, seeds 12345/54321) are in `D:\Devlopment\AI\IMG` as
  `img-20260714-215757-12345.png` / `img-20260714-221125-54321.png`; the
  corresponding krea2_final/krea2_base copies also sit in ComfyUI's own
  output folder. Delete at will.
- To tweak quality, the knobs are data: refine denoise in the workflow JSON
  (nodes 207/210), ImageScale target (node 209), or expose more controls by
  adding manifest entries. If the 2432×1664 refine ever OOMs, the workflow's
  own note says drop node 209 to 2048×1400.
- New capability you now have for free: `workflows/` accepts ComfyUI's
  DEFAULT Ctrl+S export (UI/graph format) — no more "Save (API format)"
  dance. Any `<name>.json` + manifest pair works in either format.

---

## CORRECTION (2026-07-21, audit-fix run)

The `Super_Duper_Lustify_Final` workflow described above is **no longer a
registered app workflow.** The `workflows/` library was swapped to the current
Lustify* / DR34ML* set in commit `b018876` ("feat(comfy): workflow library
swap"). The `Super_Duper_Lustify_Final.json` + `.manifest.json` pair now lives
ONLY under `test/fixtures/` (consumed by `test/unit/comfy-core.test.js` and
`test/renderer/video-panel.test.jsx`); no runtime code or sidecar references it.
Do not go looking for it in `workflows/` — the app does not offer it.
Everything above about the conversion pipeline, seeds, and manifest vocabulary
still holds; only the specific file registration is stale.
