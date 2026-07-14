import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import App from '../../src/App.jsx';
import { createMockApi } from './helpers/mock-api.js';

vi.mock('../../src/components/TerminalDock.jsx', () => ({
  default: () => null
}));

const pngFile = (name = 'shot.png') =>
  new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });

const imageClipboard = () => ({
  items: [{ kind: 'file', type: 'image/png', getAsFile: () => pngFile() }]
});

const fileDrag = () => ({ types: ['Files'], files: [] });

describe('attachments: paste and drag-drop overlay', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });
  afterEach(() => cleanup());

  it('pasting an image adds a pending attachment chip', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    fireEvent.paste(document.body, { clipboardData: imageClipboard() });
    await waitFor(() => expect(screen.getByText(/pasted-1\.png/)).toBeInTheDocument());
  });

  it('drop overlay shows on file dragenter and hides on drop', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    fireEvent.dragEnter(window, { dataTransfer: fileDrag() });
    expect(document.getElementById('dropZone').classList.contains('show')).toBe(true);
    fireEvent.drop(window, { dataTransfer: fileDrag() });
    expect(document.getElementById('dropZone').classList.contains('show')).toBe(false);
  });

  it('overlay still hides when a child swallows the drop (stopPropagation)', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    fireEvent.dragEnter(window, { dataTransfer: fileDrag() });
    expect(document.getElementById('dropZone').classList.contains('show')).toBe(true);
    // SdPanel's source box and the terminal dock both stopPropagation() on
    // drop/dragover so their drops stay out of the chat attach bar — the
    // overlay must not depend on those events reaching window bubble phase.
    const swallower = document.querySelector('.composer') || document.body.firstElementChild;
    const stop = (e) => e.stopPropagation();
    swallower.addEventListener('drop', stop);
    fireEvent.drop(swallower, { dataTransfer: fileDrag() });
    swallower.removeEventListener('drop', stop);
    expect(document.getElementById('dropZone').classList.contains('show')).toBe(false);
  });

  it('image paste goes to the SD source, not chat, when the panel is open in Image mode', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    fireEvent.click(screen.getByText('🎨 SD'));
    fireEvent.click(await screen.findByRole('button', { name: 'Image' }));
    fireEvent.paste(document.body, { clipboardData: imageClipboard() });
    // the panel claims the paste (capture phase); the chat attach bar must stay empty
    await new Promise(r => setTimeout(r, 80));
    expect(screen.queryByText(/pasted-1\.png/)).not.toBeInTheDocument();
  });

  it('overlay hides on dragend (cancelled drag / missed final dragleave)', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    fireEvent.dragEnter(window, { dataTransfer: fileDrag() });
    expect(document.getElementById('dropZone').classList.contains('show')).toBe(true);
    // Esc-cancelled drags and fast window exits can skip the final dragleave
    // (Chromium quirk); dragend / a null-relatedTarget leave must clean up.
    fireEvent.dragEnd(window, { dataTransfer: fileDrag() });
    expect(document.getElementById('dropZone').classList.contains('show')).toBe(false);
  });
});
