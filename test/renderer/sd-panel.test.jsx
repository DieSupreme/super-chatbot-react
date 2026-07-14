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

  it('populates every dropdown from the consolidated sd:lists call when running', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    mock.api.sd.lists = async () => ({
      ok: true,
      samplers: [{ name: 'Euler a' }, { name: 'DPM++ 2M Karras' }],
      schedulers: [{ name: 'automatic', label: 'Automatic' }, { name: 'karras', label: 'Karras' }],
      upscalers: [{ name: 'Lanczos' }],
      latentUpscaleModes: [{ name: 'Latent' }],
      models: [{ title: 'juggernautXL_ragnarok.safetensors [aabbcc]', model_name: 'juggernautXL_ragnarok', filename: 'D:\\x\\juggernautXL_ragnarok.safetensors' }],
      styles: [{ name: 'cinematic' }]
    });
    mock.api.sd.getOptions = async () => ({ ok: true, checkpoint: 'juggernautXL_ragnarok.safetensors [aabbcc]', vae: 'Automatic', clipSkip: 1 });

    render(<SdPanel open onToast={noop} onImage={noop} convoImages={[]} />);
    await waitFor(() => {
      // checkpoint shows up in the Basic + Refiner selects (Hires fields render only when enabled)
      expect(screen.getAllByRole('option', { name: 'juggernautXL_ragnarok' }).length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getAllByRole('option', { name: 'DPM++ 2M Karras' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'Karras' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('option', { name: 'cinematic' })).toBeInTheDocument();
    expect(screen.queryByText(/Forge not running/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it('generates: opens on the shipped preset, untouched sections stay omitted', async () => {
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
    // first open = the shipped Default (DPM++ 2M Karras) preset, auto-applied
    expect(call[1]).toMatchObject({
      prompt: 'a red fox', steps: 25, cfg: 7, width: 1024, height: 1024, seed: -1,
      sampler: 'DPM++ 2M', scheduler: 'karras'
    });
    expect(call[1].enable_hr).toBeUndefined();     // untouched sections stay omitted
    expect(call[1].override_settings).toBeUndefined();
  });

  it('parameter sections are collapsed by default and toggle open', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    const { container } = render(<SdPanel open onToast={noop} onImage={noop} convoImages={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    const secs = container.querySelectorAll('details.sd-sec');
    expect(secs.length).toBeGreaterThanOrEqual(4);  // Seed, Hires, Refiner, Advanced, Overrides
    for (const s of secs) expect(s.open).toBe(false);
    fireEvent.click(screen.getByText('Advanced'));
    await waitFor(() => expect(screen.getByText('Restore faces')).toBeVisible());
    expect(screen.getByText('CLIP skip')).toBeInTheDocument();   // Overrides section rendered
  });

  it('applying the shipped preset changes the outgoing payload', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    const { container } = render(<SdPanel open onToast={noop} onImage={noop} convoImages={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    fireEvent.change(container.querySelector('.sd-preset-row select'), { target: { value: 'Default (DPM++ 2M Karras)' } });
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'sd:txt2img')).toBe(true));
    const call = mock.calls.find(c => c[0] === 'sd:txt2img');
    expect(call[1]).toMatchObject({ steps: 25, cfg: 7, width: 1024, height: 1024, sampler: 'DPM++ 2M', scheduler: 'karras' });
  });

  it('ADetailer: off by default and absent from the payload; enabling defaults unit 1 to face_yolov8n', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    const { container } = render(<SdPanel open onToast={noop} onImage={noop} convoImages={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());

    // collapsed section, summary says off
    const sec = [...container.querySelectorAll('.sd-sec')].find(s => s.textContent.includes('ADetailer'));
    expect(sec.open).toBe(false);
    expect(sec.querySelector('summary').textContent).toMatch(/off/);

    // disabled -> no adetailer key in the outgoing params
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'sd:txt2img')).toBe(true));
    expect(mock.calls.find(c => c[0] === 'sd:txt2img')[1].adetailer).toBeUndefined();

    // enable: unit 1 defaults to face_yolov8n.pt / 0.4 and the summary updates
    fireEvent.click(sec.querySelector('summary'));
    fireEvent.click(sec.querySelector('.sd-check input'));
    await waitFor(() => expect(sec.querySelector('summary').textContent).toMatch(/face_yolov8n, 0\.4/));
    expect([...sec.querySelectorAll('select')][0].value).toBe('face_yolov8n.pt');

    mock.calls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'sd:txt2img')).toBe(true));
    const p = mock.calls.find(c => c[0] === 'sd:txt2img')[1];
    expect(p.adetailer.enabled).toBe(true);
    expect(p.adetailer.units[0].ad_model).toBe('face_yolov8n.pt');
    expect(p.adetailer.units[0].ad_denoising_strength).toBe(0.4);
  });

  it('dropping a Forge PNG on the panel imports its parameters into the controls', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    mock.api.sd.pngInfo = async () => ({
      ok: true,
      info: 'a fox on a hill\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 5.5, Seed: 77, Size: 768x512, Clip skip: 2',
      items: {}
    });
    const { container } = render(<SdPanel open onToast={noop} onImage={noop} convoImages={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    const png = new File([Uint8Array.from([137, 80, 78, 71])], 'gen.png', { type: 'image/png' });
    fireEvent.drop(container.querySelector('.sd-panel'), { dataTransfer: { files: [png], types: ['Files'] } });
    await waitFor(() => expect(screen.getByPlaceholderText(/what to generate/).value).toBe('a fox on a hill'));
    expect(screen.getByPlaceholderText(/what to avoid/).value).toBe('blurry');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'sd:txt2img')).toBe(true));
    const call = mock.calls.find(c => c[0] === 'sd:txt2img');
    expect(call[1]).toMatchObject({ steps: 30, cfg: 5.5, width: 768, height: 512, seed: 77, sampler: 'DPM++ 2M', scheduler: 'karras' });
    expect(call[1].override_settings).toMatchObject({ CLIP_stop_at_last_layers: 2 });
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

  it('Regenerate on an image message fires Forge and NEVER the chat completion', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    mock.savedConvos['c1'] = {
      id: 'c1', title: 'fox pics', model: '', cost: 0, updated: Date.now(),
      messages: [
        { role: 'user', content: 'make a fox' },
        { role: 'assistant', kind: 'image', content: '[SD image: fox] (seed 42)',
          imagePath: 'D:\\Devlopment\\AI\\IMG\\sd-1.png',
          genParams: { prompt: 'fox', steps: 25, cfg: 7, width: 512, height: 512, seed: 42, mode: 'txt2img' } }
      ]
    };
    render(<App />);
    await waitFor(() => screen.getByText('fox pics'));
    fireEvent.click(screen.getByText('fox pics'));
    await waitFor(() => screen.getByRole('button', { name: '↻ Regenerate' }));

    fireEvent.click(screen.getByRole('button', { name: '↻ Regenerate' }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'sd:txt2img')).toBe(true), { timeout: 4000 });
    const call = mock.calls.find(c => c[0] === 'sd:txt2img');
    expect(call[1].seed).toBe(-1);                 // fresh seed on regenerate
    expect(call[1].prompt).toBe('fox');
    expect(mock.calls.some(c => c[0] === 'sendChat')).toBe(false);   // zero OpenRouter calls
  });

  it('Reuse seed replays with the ORIGINAL seed; chat regenerate still goes to OpenRouter', async () => {
    mock.api.sd.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:7860', managed: false, log: [] });
    mock.savedConvos['c2'] = {
      id: 'c2', title: 'mixed', model: '', cost: 0, updated: Date.now(),
      messages: [
        { role: 'user', content: 'make a fox' },
        { role: 'assistant', kind: 'image', content: '[SD image: fox] (seed 42)',
          imagePath: 'D:\\Devlopment\\AI\\IMG\\sd-1.png',
          genParams: { prompt: 'fox', steps: 25, seed: 42, mode: 'txt2img' } },
        { role: 'user', content: 'now explain foxes' },
        { role: 'assistant', content: 'Foxes are small canids.' }
      ]
    };
    render(<App />);
    await waitFor(() => screen.getByText('mixed'));
    fireEvent.click(screen.getByText('mixed'));
    await waitFor(() => screen.getByRole('button', { name: '♻ Reuse seed' }));

    // latest assistant message is chat -> its Regenerate (the untitled one;
    // the image message carries its own titled Regenerate) goes to OpenRouter
    const chatRegen = screen.getAllByRole('button', { name: '↻ Regenerate' }).find(b => !b.title);
    fireEvent.click(chatRegen);
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'sendChat')).toBe(true), { timeout: 4000 });
    expect(mock.calls.some(c => c[0] === 'sd:txt2img')).toBe(false);

    // Reuse seed on the image -> Forge with the ORIGINAL seed
    // (image actions reappear once the chat stream settles)
    await waitFor(() => screen.getByRole('button', { name: '♻ Reuse seed' }), { timeout: 4000 });
    mock.calls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: '♻ Reuse seed' }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'sd:txt2img')).toBe(true), { timeout: 4000 });
    expect(mock.calls.find(c => c[0] === 'sd:txt2img')[1].seed).toBe(42);   // exact repro seed
    expect(mock.calls.some(c => c[0] === 'sendChat')).toBe(false);
  });

  it('legacy conversation (no kind, no genParams) loads and routes correctly', async () => {
    mock.savedConvos['old'] = {
      id: 'old', title: 'pre-kind convo', model: '', cost: 0, updated: Date.now(),
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello there' },
        { role: 'assistant', content: '[SD image: sunset] (seed 7)', imagePath: 'D:\\Devlopment\\AI\\IMG\\sd-9.png' }
      ]
    };
    render(<App />);
    await waitFor(() => screen.getByText('pre-kind convo'));
    fireEvent.click(screen.getByText('pre-kind convo'));
    await waitFor(() => screen.getByText('hello there'));
    // imagePath infers kind:'image': send-to actions exist, replay actions
    // (which need stored params) do not, and no chat Regenerate is offered on it
    expect(screen.getByRole('button', { name: '→ img2img' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '↻ Regenerate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '♻ Reuse seed' })).not.toBeInTheDocument();
  });
});
