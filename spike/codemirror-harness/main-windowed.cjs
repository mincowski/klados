/**
 * M0a / A6 — Electron main process for the windowed harness.
 *
 * THROWAWAY SPIKE CODE.
 *
 * Measures all three window sizes for exactly one fixture per process (the
 * file and its line index are expensive to build for the 500 MB fixture, so
 * they are built once and reused across window sizes inside the renderer).
 *
 * Usage: electron main-windowed.cjs <fixturePath> <fixtureName> <outJsonPath> <capMs>
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const [fixturePath, fixtureName, outPath, capMsRaw] = process.argv.slice(2);
const capMs = Number(capMsRaw || 600000);

app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=8192');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  try {
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('write failed', e);
  }
  setTimeout(() => app.exit(0), 50);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      v8CacheOptions: 'none',
    },
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    finish({
      fixture: fixtureName,
      ok: false,
      error: `render-process-gone: ${details.reason} (exitCode ${details.exitCode})`,
    });
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });

  win.loadFile(path.join(__dirname, 'index-windowed.html'), {
    query: { fixture: fixturePath, name: fixtureName },
  });

  setTimeout(() => {
    finish({ fixture: fixtureName, ok: false, error: `timeout after ${capMs} ms` });
  }, capMs);
});

ipcMain.on('result', (_e, result) => finish(result));

app.on('window-all-closed', () => {
  finish({ fixture: fixtureName, ok: false, error: 'window closed before reporting' });
});
