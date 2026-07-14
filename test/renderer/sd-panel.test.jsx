import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import SdPanel from '../../src/components/SdPanel.jsx';
import App from '../../src/App.jsx';
import { createMockApi } from './helpers/mock-api.js';
import { vi } from 'vitest';

vi.mock('../../src/components/TerminalDock.jsx', () => ({ default: () => null }));

const noop = () => {};

describe('SdPanel', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  it('mounts with Forge offline: shows the offline notice, Retry, and does not throw', async () => {
    render(<SdPanel open onToast={noop} onImage={noop} convoImages={[]} />);
    await waitFor(() => {
      expect(screen.getByText(/Forge not running at/)).toBeInTheDocument();
    });
    expect(screen.getByText('http://127.0.0.1:7860')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    // generation is blocked while stopped, but the form is still there
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });

  it('populates the checkpoint dropdown from the disk scan while Forge is stopped', async () => {
    mock.api.sd.scanCheckpoints = async () => ({
      ok: true,
      list: [
        { file: 'D:\\x\\models\\Stable-diffusion\\juggernautXL_ragnarok.safetensors', rel: 'juggernautXL_ragnarok.safetensors', name: 'juggernautXL_ragnarok' },
        { file: 'D:\\x\\models\\Stable-diffusion\\sub\\realvis.ckpt', rel: 'sub/realvis.ckpt', name: 'realvis' }
      ]
    });
    render(<SdPanel open onToast={noop} onImage={noop} convoImages={[]} />);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /juggernautXL_ragnarok \(on disk\)/ })).toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: /realvis \(on disk\)/ })).toBeInTheDocument();
  });

  it('mounts with a mocked /sd-models + /samplers response when running', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    mock.api.sd.models = async () => ({
      ok: true,
      data: [{ title: 'juggernautXL_ragnarok.safetensors [aabbcc]', model_name: 'juggernautXL_ragnarok', filename: 'D:\\x\\juggernautXL_ragnarok.safetensors' }]
    });
    mock.api.sd.samplers = async () => ({ ok: true, data: [{ name: 'Euler a' }, { name: 'DPM++ 2M Karras' }] });
    mock.api.sd.getOptions = async () => ({ ok: true, checkpoint: 'juggernautXL_ragnarok.safetensors [aabbcc]' });

    render(<SdPanel open onToast={noop} onImage={noop} convoImages={[]} />);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'juggernautXL_ragnarok' })).toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: 'DPM++ 2M Karras' })).toBeInTheDocument();
    expect(screen.queryByText(/Forge not running/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it('generates: sends the form payload and reports the saved file upward', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    const got = [];
    render(<SdPanel open onToast={noop} onImage={(r) => got.push(r)} convoImages={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());

    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'a red fox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(got).toHaveLength(1));
    expect(got[0].path).toMatch(/sd-1\.png$/);
    expect(got[0].seed).toBe(42);
    const call = mock.calls.find(c => c[0] === 'sd:txt2img');
    expect(call[1]).toMatchObject({ prompt: 'a red fox', steps: 25, cfg: 7, width: 1024, height: 1024, seed: -1 });
  });

  it('surfaces a Forge error string without blanking the panel', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    mock.api.sd.txt2img = async () => ({ ok: false, error: 'OutOfMemoryError: CUDA out of memory' });
    render(<SdPanel open onToast={noop} onImage={noop} convoImages={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(screen.getByText(/CUDA out of memory/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
  });
});

describe('App with SD panel', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  it('chat UI keeps working with the panel open and Forge offline', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    fireEvent.click(screen.getByRole('button', { name: /🎨 SD/ }));
    await waitFor(() => expect(screen.getByText(/Forge not running at/)).toBeInTheDocument());
    // the composer is still there and usable
    expect(screen.getByPlaceholderText(/Type a message/i)).toBeInTheDocument();
  });
});
