// Launcher menu config — the ONE place to edit the terminal's quick-launch
// buttons. Each entry becomes a button that writes `command + "\r"` into the
// active PTY session, so the CLI runs inline in the embedded terminal.
//
// `command` is sent verbatim followed by Enter. Add/remove/reorder freely.
export const LAUNCHERS = [
  { label: 'Claude', command: 'claude' },
  { label: 'Claude (skip perms)', command: 'claude --dangerously-skip-permissions' },
  { label: 'Cursor', command: 'cursor-agent' },
  { label: 'Grok',   command: 'grok' },
  { label: 'GPT',    command: 'sgpt' }
];
