/**
 * M0a / A6b — Electron main process.
 *
 * THROWAWAY SPIKE CODE.
 *
 * One process runs both parts: Part 1 needs cars-500mb.xml, Part 2 needs
 * cars-100mb.min.json plus the same cars-500mb.xml for its sanity check, so
 * both fixture paths are passed in and read once each inside the renderer.
 *
 * Usage: electron main-a6b.cjs <fixture500Path> <fixtureMinPath> <outJsonPath> <capMs>
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const [fixture500Path, fixtureMinPath, outPath, capMsRaw] = process.argv.slice(2);
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
    finish({ ok: false, error: `render-process-gone: ${details.reason} (exitCode ${details.exitCode})` });
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });

  win.loadFile(path.join(__dirname, 'index-a6b.html'), {
    query: { fixture500: fixture500Path, fixtureMin: fixtureMinPath },
  });

  setTimeout(() => {
    finish({ ok: false, error: `timeout after ${capMs} ms` });
  }, capMs);
});

ipcMain.on('result', (_e, result) => finish(result));

app.on('window-all-closed', () => {
  finish({ ok: false, error: 'window closed before reporting' });
});
