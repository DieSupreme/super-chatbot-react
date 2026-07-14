import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import SdPanel from '../../src/components/SdPanel.jsx';
import App from '../../src/App.jsx';
import { createMockApi } from './helpers/mock-api.js';

vi.mock('../../src/components/TerminalDock.jsx', () => ({ default: () => null }));

const noop = () => {};

describe('Video backend (ComfyUI)', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  it('mode toggle swaps to the video backend and renders manifest-driven controls', async () => {
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop} convoImages={[]} />);
    await waitFor(() => screen.getByRole('button', { name: 'Video · ComfyUI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Video · ComfyUI' }));

    // controls come from the mocked manifest, not from code
    await waitFor(() => expect(screen.getByRole('option', { name: /Smoke test/ })).toBeInTheDocument());
    expect(screen.getByText('Width')).toBeInTheDocument();
    expect(screen.getByText('Frames')).toBeInTheDocument();
    expect(screen.getByText('Fps')).toBeInTheDocument();
    expect(screen.getByText('Seed')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/what to generate/)).toBeInTheDocument();
    expect(screen.getByText(/ComfyUI stopped/)).toBeInTheDocument();

    // toggling back restores the Forge body
    fireEvent.click(screen.getByRole('button', { name: 'Image · Forge' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Video · ComfyUI' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Custom Model X' })).toBeInTheDocument());
    expect(screen.getByText('Motion')).toBeInTheDocument();     // control invented by the manifest
    expect(screen.queryByText('Frames')).not.toBeInTheDocument();
  });

  it('generate sends workflow + values over comfy IPC with manifest defaults', async () => {
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    const got = [];
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={(r) => got.push(r)} convoImages={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Video · ComfyUI' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'a fox clip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(got).toHaveLength(1));
    const call = mock.calls.find(c => c[0] === 'comfy:generate');
    expect(call[1].workflow).toBe('smoke-test');
    expect(call[1].values).toMatchObject({ prompt: 'a fox clip', width: 320, frames: 24, fps: 12, seed: -1 });
    expect(got[0].genParams.mode).toBe('video');
    expect(got[0].genParams.values.seed).toBe(99);   // realized seed stored for replay
  });
});

describe('video message routing', () => {
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
});
