import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import App from '../../src/App.jsx';
import { createMockApi } from './helpers/mock-api.js';

vi.mock('../../src/components/TerminalDock.jsx', () => ({
  default: () => null
}));

describe('App smoke', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });

  afterEach(() => cleanup());

  it('boots and shows key chip', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Key ✓/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Write a debounce/i })).toBeInTheDocument();
  });

  it('sends a message and renders markdown + edit card + citations', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    const input = screen.getByPlaceholderText(/Type a message/i);
    fireEvent.change(input, { target: { value: 'hello world test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText(/hello world test/)).toBeInTheDocument(), { timeout: 3000 });
    await waitFor(() => expect(screen.getByText('bold')).toBeInTheDocument());
    expect(screen.getByText(/Sources/i)).toBeInTheDocument();
    expect(screen.getAllByText(/proposed edit/i).length).toBeGreaterThanOrEqual(1);
    expect(mock.calls.some(c => c[0] === 'sendChat')).toBe(true);
    const convo = Object.values(mock.savedConvos)[0];
    expect(convo?.messages?.length).toBe(2);
  });

  it('opens and closes settings with keyboard', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    expect(await screen.findByText('Settings')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Done')).not.toBeInTheDocument());
  });
});
