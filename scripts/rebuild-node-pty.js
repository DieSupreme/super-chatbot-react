// Rebuild node-pty against Electron's ABI (ConPTY on Windows).
//
// This wrapper exists to work around a machine-level setting: when the env var
// NoDefaultCurrentDirectoryInExePath is set, cmd.exe won't run a batch file from
// the current directory. node-pty's bundled winpty build shells out to
//   cmd /c "cd shared && GetCommitHash.bat"
// (no ".\" prefix), so that step fails with "not recognized as a command".
// Clearing the var for the child build process fixes it, with no other effect.
//
// (Separately, node-pty requires the MSVC "Spectre-mitigated libraries" VS
// component — install it via the Visual Studio Installer if the build reports
// MSB8040. That is an environment prerequisite, not something this script can do.)
const { spawnSync } = require('child_process');

delete process.env.NoDefaultCurrentDirectoryInExePath;

// Invoke @electron/rebuild's CLI via node directly (not the .bin/.cmd shim) so a
// space in the project path (e.g. "super chat bot 5") can't break the command.
const cli = require.resolve('@electron/rebuild/lib/cli.js');

const r = spawnSync(process.execPath, [cli, '-f', '-w', 'node-pty'], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
