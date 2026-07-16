import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import SdPanel from '../../src/components/SdPanel.jsx';
import App from '../../src/App.jsx';
import { createMockApi } from './helpers/mock-api.js';

vi.mock('../../src/components/TerminalDock.jsx', () => ({ default: () => null }));

const noop = () => {};

describe('ComfyUI backend (video media)', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  it('media toggle swaps to video and renders manifest-driven controls', async () => {
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await waitFor(() => screen.getByRole('button', { name: 'Video' }));
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));

    // controls come from the mocked manifest, not from code; only
    // media=video workflows are offered (krea-image stays out)
    await waitFor(() => expect(screen.getByRole('option', { name: /Smoke test/ })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /Krea2/ })).not.toBeInTheDocument();
    expect(screen.getByText('Width')).toBeInTheDocument();
    expect(screen.getByText('Frames')).toBeInTheDocument();
    expect(screen.getByText('Fps')).toBeInTheDocument();
    expect(screen.getByText('Seed')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/what to generate/)).toBeInTheDocument();
    expect(screen.getByText(/ComfyUI stopped/)).toBeInTheDocument();

    // toggling back restores the Forge body (a checkpoint is selected)
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    await waitFor(() => expect(screen.getByText('Stable Diffusion')).toBeInTheDocument());
  });

  it('a dropped-in workflow appears with its own controls (data, not code)', async () => {
    mock.api.comfy.workflows = async () => ({
      ok: true,
      list: [{
        name: 'custom-model', label: 'Custom Model X',
        controls: {
          prompt: { node: '1', input: 'text', type: 'text' },
          motion: { node: '2', input: 'motion_strength', type: 'float', default: 0.5, min: 0, max: 1 }
        }
      }]
    });
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Video' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Custom Model X' })).toBeInTheDocument());
    expect(screen.getByText('Motion')).toBeInTheDocument();     // control invented by the manifest
    expect(screen.queryByText('Frames')).not.toBeInTheDocument();
  });

  it('generate sends workflow + values over comfy IPC with manifest defaults', async () => {
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    const got = [];
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={(r) => got.push(r)} convoImages={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Video' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'a fox clip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(got).toHaveLength(1));
    const call = mock.calls.find(c => c[0] === 'comfy:generate');
    expect(call[1].workflow).toBe('smoke-test');
    expect(call[1].values).toMatchObject({ prompt: 'a fox clip', width: 320, frames: 24, fps: 12, seed: -1 });
    expect(got[0].genParams.mode).toBe('video');
    expect(got[0].genParams.backend).toBe('comfy');
    expect(got[0].genParams.values.seed).toBe(99);   // realized seed stored for replay
  });
});

describe('ComfyUI backend (image media — backend and media are separate axes)', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  it('image mode offers ONE unified list: Forge checkpoints and ComfyUI image workflows', async () => {
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    const model = await screen.findByRole('combobox', { name: /Model/ });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Krea2 — LUSTIFY' })).toBeInTheDocument());
    // video-only workflows never appear in the image list
    expect(screen.queryByRole('option', { name: /Smoke test/ })).not.toBeInTheDocument();

    // picking the ComfyUI workflow swaps in the ComfyUI body with its
    // manifest controls — no Forge UI, no backend question asked
    fireEvent.change(model, { target: { value: 'comfy:krea-image' } });
    await waitFor(() => expect(screen.getByText('Image · ComfyUI')).toBeInTheDocument());
    expect(screen.getByText('Steps')).toBeInTheDocument();
    expect(screen.queryByText('Stable Diffusion')).not.toBeInTheDocument();

    // cfg is readonly: rendered locked with the manifest's tooltip
    const cfg = screen.getByText(/CFG/).querySelector('input');
    expect(cfg).toBeDisabled();
    expect(screen.getByTitle(/Locked at 1.0/)).toBeInTheDocument();

    // picking a checkpoint routes back to Forge
    fireEvent.change(screen.getByRole('combobox', { name: /Model/ }), { target: { value: 'forge:' } });
    await waitFor(() => expect(screen.getByText('Stable Diffusion')).toBeInTheDocument());
  });

  it('generating with a ComfyUI image workflow lands as an IMAGE result tagged backend comfy', async () => {
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    const images = [], videos = [];
    render(<SdPanel open onToast={noop} onImage={(r) => images.push(r)} onVideo={(r) => videos.push(r)} convoImages={[]} />);
    const model = await screen.findByRole('combobox', { name: /Model/ });
    await waitFor(() => screen.getByRole('option', { name: 'Krea2 — LUSTIFY' }));
    fireEvent.change(model, { target: { value: 'comfy:krea-image' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'an apple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(images).toHaveLength(1));
    expect(videos).toHaveLength(0);
    expect(images[0].genParams).toMatchObject({ workflow: 'krea-image', backend: 'comfy', mode: 'image' });
    expect(images[0].genParams.values.seed).toBe(77);
    // zero Forge traffic
    expect(mock.calls.filter(c => c[0] === 'sd:txt2img').length).toBe(0);
    // dropdown options came from /object_info, not from code
    expect(mock.calls.some(c => c[0] === 'comfy:objectInfo' && c[1] === 'KSampler' && c[2] === 'sampler_name')).toBe(true);
  });
});

describe('Super Duper Lustify workflow (the real shipped manifest)', () => {
  let mock;
  beforeEach(async () => {
    mock = createMockApi();
    // the workflow moved out of workflows/ — the frozen fixture keeps this
    // coverage of a real hand-written manifest driving the panel
    const manifest = (await import('../fixtures/Super_Duper_Lustify_Final.manifest.json')).default;
    const base = mock.api.comfy.workflows;
    mock.api.comfy.workflows = async () => {
      const r = await base();
      r.list.push({ name: 'Super_Duper_Lustify_Final', label: manifest.label, media: manifest.media, controls: manifest.controls });
      return r;
    };
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  it('appears in the IMAGE list, sends ONLY prompt/seed/width/height, zero Forge/OpenRouter', async () => {
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    const images = [];
    render(<SdPanel open onToast={noop} onImage={(r) => images.push(r)} onVideo={noop} convoImages={[]} />);
    const model = await screen.findByRole('combobox', { name: /Model/ });
    await waitFor(() => screen.getByRole('option', { name: 'Super Duper Lustify (Krea2, high quality)' }));
    fireEvent.change(model, { target: { value: 'comfy:Super_Duper_Lustify_Final' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());

    // exactly the four manifest controls — nothing about denoise/cfg/sampler
    expect(screen.queryByText('Steps')).not.toBeInTheDocument();
    expect(screen.queryByText(/CFG/)).not.toBeInTheDocument();
    expect(screen.queryByText('Denoise')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'test prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:generate')).toBe(true));

    const call = mock.calls.find(c => c[0] === 'comfy:generate');
    expect(call[1].workflow).toBe('Super_Duper_Lustify_Final');
    expect(Object.keys(call[1].values).sort()).toEqual(['height', 'prompt', 'seed', 'width']);
    expect(call[1].values).toMatchObject({ prompt: 'test prompt', seed: -1, width: 1216, height: 832 });
    expect(mock.calls.filter(c => c[0] === 'comfy:generate').length).toBe(1);
    expect(mock.calls.filter(c => c[0] === 'sd:txt2img').length).toBe(0);   // zero Forge
    expect(mock.calls.filter(c => c[0] === 'sd:img2img').length).toBe(0);
    expect(mock.calls.filter(c => c[0] === 'sendChat').length).toBe(0);     // zero OpenRouter
  });
});

describe('prompt presets (saved per workflow in workflows/prompt-presets.json)', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  const openVideo = async () => {
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Video' }));
    await waitFor(() => screen.getByRole('option', { name: /Smoke test/ }));
  };

  it('Save prompts captures the prompt text under a typed name — no seed while it randomizes', async () => {
    await openVideo();
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'a neon fox' } });
    fireEvent.click(screen.getByTitle('Save prompts'));
    const nameInput = await screen.findByPlaceholderText(/preset name/i);
    fireEvent.change(nameInput, { target: { value: 'fox set' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });

    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:presetSave')).toBe(true));
    const p = mock.calls.find(c => c[0] === 'comfy:presetSave')[1];
    expect(p.workflow).toBe('smoke-test');
    expect(p.name).toBe('fox set');
    expect(p.values.prompt).toBe('a neon fox');
    expect('seed' in p.values).toBe(false);            // seed -1 = randomize -> not stored
    // the new preset is now offered in the picker
    await waitFor(() => expect(screen.getByRole('option', { name: 'fox set' })).toBeInTheDocument());
  });

  it('a FIXED seed rides along with the saved preset', async () => {
    await openVideo();
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'x' } });
    fireEvent.change(screen.getByText('Seed').querySelector('input'), { target: { value: '4242' } });
    fireEvent.click(screen.getByTitle('Save prompts'));
    const nameInput = await screen.findByPlaceholderText(/preset name/i);
    fireEvent.change(nameInput, { target: { value: 'known good' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:presetSave')).toBe(true));
    expect(mock.calls.find(c => c[0] === 'comfy:presetSave')[1].values.seed).toBe(4242);
  });

  it('picking a preset populates the fields (still editable, never locked); list is per-workflow', async () => {
    mock.presetStore['smoke-test'] = [{ name: 'city', values: { prompt: 'neon city', seed: 7 } }];
    await openVideo();
    await waitFor(() => expect(screen.getByRole('option', { name: 'city' })).toBeInTheDocument());
    expect(mock.calls.some(c => c[0] === 'comfy:presets' && c[1] === 'smoke-test')).toBe(true);

    fireEvent.change(screen.getByTitle('Prompt presets'), { target: { value: 'city' } });
    const promptBox = screen.getByPlaceholderText(/what to generate/);
    await waitFor(() => expect(promptBox.value).toBe('neon city'));
    expect(screen.getByText('Seed').querySelector('input').value).toBe('7');
    // populated, not locked — the user keeps editing before generating
    fireEvent.change(promptBox, { target: { value: 'neon city at dawn' } });
    expect(promptBox.value).toBe('neon city at dawn');
  });

  it('rename and delete round-trip through the preset IPC', async () => {
    mock.presetStore['smoke-test'] = [{ name: 'old name', values: { prompt: 'p' } }];
    await openVideo();
    await waitFor(() => expect(screen.getByRole('option', { name: 'old name' })).toBeInTheDocument());
    fireEvent.change(screen.getByTitle('Prompt presets'), { target: { value: 'old name' } });

    fireEvent.click(screen.getByTitle('Rename preset'));
    const inp = await screen.findByPlaceholderText(/preset name/i);
    fireEvent.change(inp, { target: { value: 'new name' } });
    fireEvent.keyDown(inp, { key: 'Enter' });
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:presetRename')).toBe(true));
    expect(mock.calls.find(c => c[0] === 'comfy:presetRename')[1])
      .toMatchObject({ workflow: 'smoke-test', oldName: 'old name', newName: 'new name' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'new name' })).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Delete preset'));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:presetDelete')).toBe(true));
    expect(mock.calls.find(c => c[0] === 'comfy:presetDelete')[1])
      .toMatchObject({ workflow: 'smoke-test', name: 'new name' });
    await waitFor(() => expect(screen.queryByRole('option', { name: 'new name' })).not.toBeInTheDocument());
  });
});

describe('control picker — Configure controls for generated manifests', () => {
  let mock;
  // a generated workflow: three visible controls + two hidden potentials, the
  // shape the schema-driven extractor now emits (node_type/node_title ride on
  // every control for the picker's grouping)
  const makeWf = () => ({
    name: 'smoke-test', label: 'Smoke test — solid-color clip (no model needed)', generated: true,
    controls: {
      prompt: { node: '9', input: 'text', type: 'text', node_type: 'CLIPTextEncode', node_title: 'Prompt' },
      width: { node: '1', input: 'width', type: 'int', default: 320, min: 64, max: 2048, node_type: 'EmptyLatentImage', node_title: '' },
      seed: { node: '3', input: 'noise_seed', type: 'seed', node_type: 'RandomNoise', node_title: '' },
      latent_batch_size: { node: '1', input: 'batch_size', type: 'int', default: 1, hidden: true, label: 'Batch size', node_type: 'EmptyLatentImage', node_title: '' },
      sampler_denoise: { node: '2', input: 'denoise', type: 'float', default: 1, hidden: true, label: 'Denoise', node_type: 'KSampler', node_title: 'Main Sampler' }
    }
  });
  let list;
  beforeEach(() => {
    mock = createMockApi();
    list = [makeWf()];
    mock.api.comfy.workflows = async () => ({ ok: true, list });
    // stateful override mock: mutates the list the way main's sidecar + reread does
    mock.api.comfy.setControlOverride = async (p) => {
      mock.calls.push(['comfy:setControlOverride', p]);
      const wf = list.find(w => w.name === p.workflow);
      for (const c of Object.values(wf.controls)) {
        const t = c.targets ? c.targets[0] : c;
        if (t.node + ':' + t.input !== p.id) continue;
        if (p.hidden === false) delete c.hidden;
        else if (p.hidden === true) c.hidden = true;
        if (typeof p.label === 'string') c.label = p.label;
      }
      list = [{ ...wf, controls: { ...wf.controls } }];
      return { ok: true, list };
    };
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  const openVideo = async () => {
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Video' }));
    await waitFor(() => screen.getByRole('option', { name: /Smoke test/ }));
  };

  it('hidden controls stay off the main panel; the picker lists everything grouped by node', async () => {
    await openVideo();
    expect(screen.queryByText('Denoise')).not.toBeInTheDocument();      // hidden -> not rendered
    expect(screen.getByText('Width')).toBeInTheDocument();              // visible as before

    fireEvent.click(screen.getByRole('button', { name: /Configure controls/ }));
    // grouped by node: title + type headers
    expect(screen.getByText(/Main Sampler/)).toBeInTheDocument();
    expect(screen.getByText(/KSampler/)).toBeInTheDocument();
    // checkbox state mirrors hidden
    expect(screen.getByRole('checkbox', { name: /denoise/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^text$/ })).toBeChecked();
  });

  it('checking a hidden control flips the override and it appears on the main panel', async () => {
    await openVideo();
    fireEvent.click(screen.getByRole('button', { name: /Configure controls/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /denoise/ }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:setControlOverride')).toBe(true));
    expect(mock.calls.find(c => c[0] === 'comfy:setControlOverride')[1])
      .toMatchObject({ workflow: 'smoke-test', id: '2:denoise', hidden: false });
    // back to the panel: the control now renders
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    await waitFor(() => expect(screen.getByText('Denoise')).toBeInTheDocument());
  });

  it('editing a label in the picker sends a label override', async () => {
    await openVideo();
    fireEvent.click(screen.getByRole('button', { name: /Configure controls/ }));
    const labelBox = screen.getByTitle(/Label for sampler_denoise/);
    fireEvent.change(labelBox, { target: { value: 'Detail strength' } });
    fireEvent.blur(labelBox);
    await waitFor(() => expect(mock.calls.some(c =>
      c[0] === 'comfy:setControlOverride' && c[1].label === 'Detail strength')).toBe(true));
    expect(mock.calls.find(c => c[0] === 'comfy:setControlOverride')[1].id).toBe('2:denoise');
  });

  it('the filter box narrows rows by node title, type, or input name', async () => {
    await openVideo();
    fireEvent.click(screen.getByRole('button', { name: /Configure controls/ }));
    fireEvent.change(screen.getByPlaceholderText(/filter controls/i), { target: { value: 'denoise' } });
    expect(screen.getByRole('checkbox', { name: /denoise/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /batch_size/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /^text$/ })).not.toBeInTheDocument();
  });

  it('Rescan workflow re-runs extraction through comfy:rebuildManifests', async () => {
    await openVideo();
    fireEvent.click(screen.getByRole('button', { name: /Configure controls/ }));
    fireEvent.click(screen.getByRole('button', { name: /Rescan workflow/ }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:rebuildManifests')).toBe(true));
  });

  it('non-generated (hand-authored) workflows get no Configure button', async () => {
    list = [{ ...makeWf(), generated: false }];
    await openVideo();
    expect(screen.queryByRole('button', { name: /Configure controls/ })).not.toBeInTheDocument();
  });
});

describe('working control values — the per-workflow draft (control-values.json)', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  const toVideo = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Video' }));
    await waitFor(() => screen.getByRole('option', { name: /Smoke test/ }));
  };

  it('typed values survive a tab switch away and back (unmount flushes, remount restores)', async () => {
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'my draft prompt' } });
    fireEvent.change(screen.getByText('Width').querySelector('input'), { target: { value: '640' } });

    // switching to Image unmounts the video body — the draft must flush to disk
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    await waitFor(() => expect((mock.valuesStore['smoke-test'] || {}).prompt).toBe('my draft prompt'), { timeout: 3000 });
    expect(mock.valuesStore['smoke-test'].width).toBe(640);

    // ...and coming back restores it
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    await waitFor(() => expect(screen.getByPlaceholderText(/what to generate/).value).toBe('my draft prompt'));
    expect(screen.getByText('Width').querySelector('input').value).toBe('640');
  });

  it('a stored draft wins over manifest defaults; untouched controls keep defaults; stale keys are dropped', async () => {
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    mock.valuesStore['smoke-test'] = { prompt: 'stored draft', width: 640, ghost: 42 };
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    await waitFor(() => expect(screen.getByPlaceholderText(/what to generate/).value).toBe('stored draft'));
    expect(screen.getByText('Width').querySelector('input').value).toBe('640');
    expect(screen.getByText('Fps').querySelector('input').value).toBe('12');   // untouched -> default

    // the stale key never reaches generation
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:generate')).toBe(true));
    const vals = mock.calls.find(c => c[0] === 'comfy:generate')[1].values;
    expect(vals.prompt).toBe('stored draft');
    expect(vals.width).toBe(640);
    expect('ghost' in vals).toBe(false);
  });

  it('edits save debounced while the panel stays mounted', async () => {
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'settling…' } });
    await waitFor(() => expect(mock.calls.some(c =>
      c[0] === 'comfy:valuesSave' && c[1].values.prompt === 'settling…')).toBe(true), { timeout: 3000 });
    expect(mock.calls.find(c => c[0] === 'comfy:valuesSave' && c[1].values.prompt === 'settling…')[1].workflow)
      .toBe('smoke-test');
  });

  it('Reset to defaults clears the stored draft and the panel returns to manifest defaults', async () => {
    mock.valuesStore['smoke-test'] = { prompt: 'old draft', width: 999 };
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    await waitFor(() => expect(screen.getByPlaceholderText(/what to generate/).value).toBe('old draft'));

    fireEvent.click(screen.getByRole('button', { name: /Reset to defaults/ }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:valuesClear' && c[1] === 'smoke-test')).toBe(true));
    await waitFor(() => expect(screen.getByPlaceholderText(/what to generate/).value).toBe(''));
    expect(screen.getByText('Width').querySelector('input').value).toBe('320');   // manifest default again
  });

  it('loading a preset writes into the working draft (persisted like any edit)', async () => {
    mock.presetStore['smoke-test'] = [{ name: 'city', values: { prompt: 'neon city' } }];
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    await waitFor(() => screen.getByRole('option', { name: 'city' }));
    fireEvent.change(screen.getByTitle('Prompt presets'), { target: { value: 'city' } });
    await waitFor(() => expect(screen.getByPlaceholderText(/what to generate/).value).toBe('neon city'));
    // the applied preset lands in the draft store via the debounced save
    await waitFor(() => expect((mock.valuesStore['smoke-test'] || {}).prompt).toBe('neon city'), { timeout: 3000 });
  });
});

describe('live-job controls: cancel, preview frames, free VRAM, start-image upload', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    window.api = mock.api;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  const toVideo = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Video' }));
    await waitFor(() => screen.getByRole('option', { name: /Smoke test/ }));
  };
  // a generation that stays running until the test resolves it
  const hangGeneration = () => {
    let resolveGen;
    mock.api.comfy.generate = (p) => {
      mock.calls.push(['comfy:generate', p]);
      return new Promise(res => { resolveGen = res; });
    };
    return () => resolveGen && resolveGen({ ok: true, files: [{ path: 'D:\\x\\vid-1.mp4', name: 'vid-1.mp4' }], seed: 1, elapsed: 1 });
  };
  const startJob = async () => {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled());
  };

  it('Cancel is disabled when idle; confirm=yes interrupts + clears via comfy:cancel', async () => {
    const finish = hangGeneration();
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeDisabled();   // nothing running

    await startJob();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:cancel')).toBe(true));
    expect(confirmSpy).toHaveBeenCalled();
    finish();
  });

  it('confirm=no leaves the job alone', async () => {
    const finish = hangGeneration();
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    await startJob();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await new Promise(r => setTimeout(r, 50));
    expect(mock.calls.some(c => c[0] === 'comfy:cancel')).toBe(false);
    finish();
  });

  it('binary preview frames render during the job and clear on completion', async () => {
    let previewCb = null, progressCb = null;
    mock.api.comfy.onPreview = (cb) => { previewCb = cb; return () => {}; };
    mock.api.comfy.onProgress = (cb) => { progressCb = cb; return () => {}; };
    const finish = hangGeneration();
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    await startJob();

    act(() => previewCb({ b64: 'AAECAw==', mime: 'image/jpeg' }));
    const img = await screen.findByAltText('live preview');
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,AAECAw==');

    // newer frame replaces the old one
    act(() => previewCb({ b64: 'BBBB', mime: 'image/png' }));
    await waitFor(() => expect(screen.getByAltText('live preview').getAttribute('src')).toBe('data:image/png;base64,BBBB'));

    // completion clears the preview — the final output message takes over
    act(() => progressCb({ done: true }));
    await waitFor(() => expect(screen.queryByAltText('live preview')).not.toBeInTheDocument());
    finish();
  });

  it('no preview frames = plain progress bar, no image element', async () => {
    let progressCb = null;
    mock.api.comfy.onProgress = (cb) => { progressCb = cb; return () => {}; };
    const finish = hangGeneration();
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    await startJob();
    act(() => progressCb({ phase: 'sampling', value: 3, max: 10, elapsed: 5 }));
    await waitFor(() => expect(screen.getByText(/sampling/)).toBeInTheDocument());
    expect(screen.queryByAltText('live preview')).not.toBeInTheDocument();
    finish();
  });

  it('Free VRAM posts /free while idle-and-running, disabled when the server is down', async () => {
    const toasts = [];
    render(<SdPanel open onToast={(m, k) => toasts.push([m, k])} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    const btn = await screen.findByRole('button', { name: /Free VRAM/ });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:free')).toBe(true));
    await waitFor(() => expect(toasts.some(([m]) => /VRAM freed/i.test(m))).toBe(true));
  });

  it('Free VRAM is disabled when ComfyUI is stopped', async () => {
    mock.api.comfy.status = async () => ({ ok: true, status: 'stopped', url: 'http://127.0.0.1:8188', managed: false, log: [] });
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    expect(screen.getByRole('button', { name: /Free VRAM/ })).toBeDisabled();
  });
});

describe('start-image upload — the workflow image control talks to /upload/image', () => {
  let mock;
  const wfWithImage = {
    name: 'smoke-test', label: 'Smoke test — i2v', media: 'video', generated: true,
    controls: {
      prompt: { node: '9', input: 'text', type: 'text' },
      image: { node: '5', input: 'image', type: 'select', options_from: 'object_info:LoadImage:image', default: '', label: 'Start image' },
      seed: { node: '3', input: 'noise_seed', type: 'seed' }
    }
  };
  beforeEach(() => {
    mock = createMockApi();
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    mock.api.comfy.workflows = async () => ({ ok: true, list: [wfWithImage] });
    // faithful LoadImage list: empty server input folder (a generic sampler
    // list here would make the DOM select adopt its first option)
    mock.api.comfy.objectInfo = async (t, i) => {
      mock.calls.push(['comfy:objectInfo', t, i]);
      return { ok: true, options: t === 'LoadImage' ? [] : ['euler'] };
    };
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  const toVideo = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Video' }));
    await waitFor(() => screen.getByRole('option', { name: /Smoke test/ }));
  };

  it('the picker button uploads the chosen file and sets the control to the server name', async () => {
    mock.api.pickFiles = async () => ({ ok: true, files: [{ name: 'pic.png', path: 'C:\\pics\\pic.png', kind: 'image' }] });
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    fireEvent.click(await screen.findByTitle(/Upload an image/));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:uploadImage' && c[1] === 'C:\\pics\\pic.png')).toBe(true));
    // control now points at the uploaded server-side file
    const select = screen.getByText('Start image').querySelector('select');
    await waitFor(() => expect(select.value).toBe('up.png'));
  });

  it('a failed upload toasts the error and leaves the control untouched', async () => {
    const toasts = [];
    mock.api.pickFiles = async () => ({ ok: true, files: [{ name: 'pic.png', path: 'C:\\pics\\pic.png', kind: 'image' }] });
    mock.api.comfy.uploadImage = async (p) => { mock.calls.push(['comfy:uploadImage', p]); return { ok: false, error: 'disk full' }; };
    render(<SdPanel open onToast={(m, k) => toasts.push([m, k])} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    fireEvent.click(await screen.findByTitle(/Upload an image/));
    await waitFor(() => expect(toasts.some(([m, k]) => /disk full/.test(m) && k === 'warn')).toBe(true));
    expect(screen.getByText('Start image').querySelector('select').value).toBe('');
  });

  it('dropping an image file on the control uploads it (webUtils path)', async () => {
    mock.api.getPathForFile = () => 'C:\\pics\\dropped.png';
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await toVideo();
    const row = (await screen.findByText('Start image')).closest('label');
    const file = new File(['x'], 'dropped.png', { type: 'image/png' });
    fireEvent.drop(row, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:uploadImage' && c[1] === 'C:\\pics\\dropped.png')).toBe(true));
  });

  it('"→ start image" on a gallery image uploads it and fills the video workflow image control', async () => {
    mock.savedConvos['g1'] = {
      id: 'g1', title: 'gallery', model: '', cost: 0, updated: Date.now(),
      messages: [
        { role: 'assistant', kind: 'image', content: '[image: a still] (seed 5)',
          imagePath: 'D:\\Devlopment\\AI\\IMG\\img-5.png',
          genParams: { workflow: 'krea-image', backend: 'comfy', mode: 'image', values: { prompt: 'a still', seed: 5 } } }
      ]
    };
    render(<App />);
    fireEvent.click(await screen.findByText('gallery'));
    await waitFor(() => screen.getByRole('button', { name: /start image/ }));
    fireEvent.click(screen.getByRole('button', { name: /start image/ }));

    await waitFor(() => expect(mock.calls.some(c =>
      c[0] === 'comfy:uploadImage' && c[1] === 'D:\\Devlopment\\AI\\IMG\\img-5.png')).toBe(true), { timeout: 5000 });
    // the video panel's image control now points at the uploaded file
    await waitFor(() => {
      const select = screen.getByText('Start image').querySelector('select');
      expect(select.value).toBe('up.png');
    });
  });
});

describe('result message routing (backend recorded on the message)', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  it('Regenerate on a video message fires ComfyUI only — zero Forge, zero OpenRouter', async () => {
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    mock.savedConvos['v1'] = {
      id: 'v1', title: 'clips', model: '', cost: 0, updated: Date.now(),
      messages: [
        { role: 'user', content: 'make a clip' },
        { role: 'assistant', kind: 'video', content: '[video: fox clip] (seed 7)',
          videoPath: 'D:\\Devlopment\\AI\\IMG\\vid-7.mp4',
          genParams: { workflow: 'smoke-test', values: { prompt: 'fox clip', width: 320, frames: 24, fps: 12, seed: 7 }, mode: 'video' } }
      ]
    };
    render(<App />);
    fireEvent.click(await screen.findByText('clips'));
    await waitFor(() => screen.getByRole('button', { name: '↻ Regenerate' }));
    fireEvent.click(screen.getByRole('button', { name: '↻ Regenerate' }));

    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:generate')).toBe(true), { timeout: 5000 });
    const call = mock.calls.find(c => c[0] === 'comfy:generate');
    expect(call[1].values.seed).toBe(-1);                                  // fresh seed
    expect(mock.calls.filter(c => c[0] === 'comfy:generate').length).toBe(1);
    expect(mock.calls.filter(c => c[0] === 'sd:txt2img').length).toBe(0);   // zero Forge
    expect(mock.calls.filter(c => c[0] === 'sendChat').length).toBe(0);     // zero OpenRouter
  });

  it('Reuse seed on a video replays with the original seed', async () => {
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    mock.savedConvos['v2'] = {
      id: 'v2', title: 'clips2', model: '', cost: 0, updated: Date.now(),
      messages: [
        { role: 'assistant', kind: 'video', content: '[video: x] (seed 1234)',
          videoPath: 'D:\\Devlopment\\AI\\IMG\\vid-x.mp4',
          genParams: { workflow: 'smoke-test', values: { prompt: 'x', seed: 1234 }, mode: 'video' } }
      ]
    };
    render(<App />);
    fireEvent.click(await screen.findByText('clips2'));
    await waitFor(() => screen.getByRole('button', { name: '♻ Reuse seed' }));
    fireEvent.click(screen.getByRole('button', { name: '♻ Reuse seed' }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:generate')).toBe(true), { timeout: 5000 });
    expect(mock.calls.find(c => c[0] === 'comfy:generate')[1].values.seed).toBe(1234);
  });

  it('Regenerate on a kind:image message with backend comfy replays via ComfyUI, not Forge', async () => {
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    mock.savedConvos['i1'] = {
      id: 'i1', title: 'krea pics', model: '', cost: 0, updated: Date.now(),
      messages: [
        { role: 'assistant', kind: 'image', content: '[image: an apple] (seed 5)',
          imagePath: 'D:\\Devlopment\\AI\\IMG\\img-5.png',
          genParams: { workflow: 'krea-image', backend: 'comfy', mode: 'image',
            values: { prompt: 'an apple', steps: 8, width: 1024, height: 1024, seed: 5 } } }
      ]
    };
    render(<App />);
    fireEvent.click(await screen.findByText('krea pics'));
    await waitFor(() => screen.getByRole('button', { name: '↻ Regenerate' }));
    fireEvent.click(screen.getByRole('button', { name: '↻ Regenerate' }));

    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:generate')).toBe(true), { timeout: 5000 });
    const call = mock.calls.find(c => c[0] === 'comfy:generate');
    expect(call[1].workflow).toBe('krea-image');
    expect(call[1].values.seed).toBe(-1);
    expect(mock.calls.filter(c => c[0] === 'sd:txt2img').length).toBe(0);   // zero Forge
    expect(mock.calls.filter(c => c[0] === 'sd:img2img').length).toBe(0);
    expect(mock.calls.filter(c => c[0] === 'sendChat').length).toBe(0);     // zero OpenRouter
  });

  it('Regenerate on a legacy kind:image message (no backend) still replays via Forge', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: true, log: [] });
    mock.savedConvos['i2'] = {
      id: 'i2', title: 'old pics', model: '', cost: 0, updated: Date.now(),
      messages: [
        { role: 'assistant', kind: 'image', content: '[SD image: a cat] (seed 9)',
          imagePath: 'D:\\Devlopment\\AI\\IMG\\sd-9.png',
          genParams: { prompt: 'a cat', steps: 20, seed: 9, mode: 'txt2img' } }
      ]
    };
    render(<App />);
    fireEvent.click(await screen.findByText('old pics'));
    await waitFor(() => screen.getByRole('button', { name: '↻ Regenerate' }));
    fireEvent.click(screen.getByRole('button', { name: '↻ Regenerate' }));

    await waitFor(() => expect(mock.calls.some(c => c[0] === 'sd:txt2img')).toBe(true), { timeout: 5000 });
    expect(mock.calls.filter(c => c[0] === 'comfy:generate').length).toBe(0);
  });
});
