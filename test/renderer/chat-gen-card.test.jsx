// Live generation IN THE CHAT: a ComfyUI job appears as a kind:'gen' message
// whose preview image updates in place (one <img>, never a message per
// frame), carries the progress bar + pass label + Cancel, and is REPLACED by
// the final result message when the job lands (error -> error bubble).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import ChatLog from '../../src/components/ChatLog.jsx';
import SdPanel from '../../src/components/SdPanel.jsx';
import App from '../../src/App.jsx';
import { createMockApi } from './helpers/mock-api.js';

vi.mock('../../src/components/TerminalDock.jsx', () => ({ default: () => null }));

const noop = () => {};
const genMsg = { uid: 'g1', role: 'assistant', who: 'ComfyUI', kind: 'gen', content: '[generating video: x]' };
const logProps = {
  emptyVariant: 'welcome', onStarter: noop, isStreaming: false,
  onRetryLast: noop, onRegenerate: noop, onEditLast: noop, onImageAction: noop, onToast: noop
};

describe('GenCard: live preview streams into the chat message', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => { vi.restoreAllMocks(); cleanup(); });

  it('renders progress phase + updates ONE preview img in place (single buffer, no appended frames)', async () => {
    let previewCb = null, progressCb = null;
    mock.api.comfy.onPreview = (cb) => { previewCb = cb; return () => {}; };
    mock.api.comfy.onProgress = (cb) => { progressCb = cb; return () => {}; };
    render(<ChatLog messages={[genMsg]} {...logProps} />);

    expect(screen.getByText('queued…')).toBeInTheDocument();
    act(() => progressCb({ phase: 'Sampler MAIN (1st pass)', value: 3, max: 10, elapsed: 12 }));
    expect(screen.getByText('Sampler MAIN (1st pass)')).toBeInTheDocument();
    expect(screen.getByText(/30%/)).toBeInTheDocument();

    act(() => previewCb({ b64: 'AAAA', mime: 'image/jpeg' }));
    let imgs = screen.getAllByAltText('live preview');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');

    // the next frame REPLACES the src on the same element — never a new img
    act(() => previewCb({ b64: 'BBBB', mime: 'image/jpeg' }));
    imgs = screen.getAllByAltText('live preview');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('data:image/jpeg;base64,BBBB');
  });

  it('Cancel on the card interrupts via comfy:cancel behind the confirm', async () => {
    render(<ChatLog messages={[genMsg]} {...logProps} />);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(mock.calls.some(c => c[0] === 'comfy:cancel')).toBe(true));
  });

  it('gen cards carry no Copy/Retry tools', () => {
    render(<ChatLog messages={[genMsg]} {...logProps} />);
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });
});

describe('ComfyBody wiring: onGenStart / genUid / onGenFail', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    window.api = mock.api;
  });
  afterEach(() => { vi.restoreAllMocks(); cleanup(); });

  const toVideoAndGenerate = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Video' }));
    await waitFor(() => screen.getByRole('option', { name: /Smoke test/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'a fox clip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
  };

  it('success: card opens on generate and the delivered result carries its uid', async () => {
    const started = [], got = [];
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={(r) => got.push(r)}
      onGenStart={(p) => { started.push(p); return 'uid-1'; }} onGenFail={noop} convoImages={[]} />);
    await toVideoAndGenerate();
    await waitFor(() => expect(got).toHaveLength(1));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ media: 'video', prompt: 'a fox clip', workflow: 'smoke-test' });
    expect(got[0].genUid).toBe('uid-1');
  });

  it('failure: the card uid is failed with the error text', async () => {
    mock.api.comfy.generate = async () => ({ ok: false, error: 'CUDA out of memory' });
    const failed = [];
    render(<SdPanel open onToast={noop} onImage={noop} onVideo={noop}
      onGenStart={() => 'uid-2'} onGenFail={(uid, err) => failed.push([uid, err])} convoImages={[]} />);
    await toVideoAndGenerate();
    await waitFor(() => expect(failed).toHaveLength(1));
    expect(failed[0]).toEqual(['uid-2', 'CUDA out of memory']);
  });
});

describe('App integration: the card lives in the conversation and becomes the result', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    mock.api.comfy.status = async () => ({ ok: true, status: 'running', url: 'http://127.0.0.1:8188', managed: true, log: [] });
    window.api = mock.api;
  });
  afterEach(() => { vi.restoreAllMocks(); cleanup(); });

  const openPanelToVideo = async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    fireEvent.click(screen.getByRole('button', { name: /🎨 SD/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Video' }));
    await waitFor(() => screen.getByRole('option', { name: /Smoke test/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled());
  };

  it('generate -> gen card appears in the chat log; completion replaces it with the video message', async () => {
    let resolveGen;
    mock.api.comfy.generate = (p) => {
      mock.calls.push(['comfy:generate', p]);
      return new Promise(res => { resolveGen = res; });
    };
    await openPanelToVideo();
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'a fox clip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    // the running job is a message in the conversation area (#log)
    const log = document.getElementById('log');
    await waitFor(() => expect(log.querySelector('.gen-live')).toBeTruthy());
    expect(log.textContent).toContain('queued…');

    // completion: the card is REPLACED by the final video message in place
    act(() => resolveGen({ ok: true, files: [{ path: 'D:\\x\\vid-1.mp4', name: 'vid-1.mp4' }], seed: 9, elapsed: 2 }));
    await waitFor(() => expect(log.querySelector('.gen-live')).toBeFalsy());
    await waitFor(() => expect(log.querySelector('video.gen-vid')).toBeTruthy());
    // exactly one assistant message came out of the run — swap, not append
    expect(log.querySelectorAll('.msg').length).toBe(1);
    // transient cards never persist: the saved convo holds only the result
    const convo = Object.values(mock.savedConvos)[0];
    expect(convo.messages.filter(m => m.kind === 'gen')).toHaveLength(0);
    expect(convo.messages.some(m => m.kind === 'video')).toBe(true);
  });

  it('a failed job turns the card into an error bubble in the chat', async () => {
    mock.api.comfy.generate = async () => ({ ok: false, error: 'CUDA out of memory' });
    await openPanelToVideo();
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    const log = document.getElementById('log');
    await waitFor(() => expect(log.textContent).toContain('Generation failed: CUDA out of memory'));
    expect(log.querySelector('.gen-live')).toBeFalsy();
  });

  it('a running generation pins the conversation: switching is blocked and the result lands where it started', async () => {
    // A pre-existing OTHER conversation the user might try to switch to mid-job.
    mock.savedConvos['other'] = { id: 'other', title: 'Other chat', model: 'm', messages: [{ role: 'user', content: 'hi' }], cost: 0, updated: 1 };

    let resolveGen;
    mock.api.comfy.generate = (p) => {
      mock.calls.push(['comfy:generate', p]);
      return new Promise(res => { resolveGen = res; });
    };
    await openPanelToVideo();
    fireEvent.change(screen.getByPlaceholderText(/what to generate/), { target: { value: 'a fox clip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    const log = document.getElementById('log');
    await waitFor(() => expect(log.querySelector('.gen-live')).toBeTruthy());

    // Try to leave the conversation while the job runs — must be blocked, and
    // the live gen card must still be present (not stranded/vanished).
    fireEvent.click(await screen.findByText('Other chat'));
    // the "New chat" affordance too
    const newBtn = screen.queryByRole('button', { name: /New chat|＋ New/i });
    if (newBtn) fireEvent.click(newBtn);
    expect(log.querySelector('.gen-live')).toBeTruthy();

    // Completion delivers the result into the SAME (originating) conversation.
    act(() => resolveGen({ ok: true, files: [{ path: 'D:\\x\\vid-1.mp4', name: 'vid-1.mp4' }], seed: 9, elapsed: 2 }));
    await waitFor(() => expect(log.querySelector('video.gen-vid')).toBeTruthy());

    // The originating conversation got the video; the untouched 'other' convo
    // still has only its original single user message (no leaked video).
    const originating = Object.values(mock.savedConvos).find(c => c.id !== 'other');
    expect(originating.messages.some(m => m.kind === 'video')).toBe(true);
    expect(mock.savedConvos['other'].messages.some(m => m.kind === 'video')).toBe(false);
    expect(mock.savedConvos['other'].messages).toHaveLength(1);
  });
});
