import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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
