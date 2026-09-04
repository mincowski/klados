/**
 * M0a / A2 — Electron main process.
 *
 * THROWAWAY SPIKE CODE.
 *
 * Measures exactly one fixture and exits, so each measurement gets a clean
 * process and the RSS numbers are not contaminated by the previous fixture.
 *
 * Usage: electron main.cjs <fixturePath> <fixtureName> <outJsonPath> <capMs>
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const [fixturePath, fixtureName, outPath, capMsRaw] = process.argv.slice(2);
const capMs = Number(capMsRaw || 300000);

// Needed for the forced-GC sampling in the renderer.
app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=8192');
// Otherwise an unfocused window throttles rAF and every timing is garbage.
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

  win.loadFile(path.join(__dirname, 'index.html'), {
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
