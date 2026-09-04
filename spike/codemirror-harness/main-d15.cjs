/**
 * M1 D15 — Electron main process, generic over the two harness pages.
 *
 * THROWAWAY MEASUREMENT HARNESS.
 *
 * Usage: electron main-d15.cjs <mode> <fixturePath> <fixtureName> <outJsonPath> <capMs> [workerPath]
 *   mode: "open" | "scroll"
 *
 * One fixture/config per process, same reasoning as the M0a spikes: a
 * clean process per measurement keeps RSS numbers uncontaminated by
 * whatever ran before it.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const [mode, fixturePath, fixtureName, outPath, capMsRaw, workerPath, windowBytesRaw] =
  process.argv.slice(2);
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

  const page = mode === 'open' ? 'index-d15-open.html' : 'index-d15-scroll.html';
  const query = { fixture: fixturePath, name: fixtureName };
  if (workerPath) query.workerUrl = pathToFileURL(workerPath).href;
  if (windowBytesRaw) query.windowBytes = windowBytesRaw;

  win.loadFile(path.join(__dirname, page), { query });

  setTimeout(() => {
    finish({ fixture: fixtureName, ok: false, error: `timeout after ${capMs} ms` });
  }, capMs);
});

ipcMain.on('result', (_e, result) => finish(result));

app.on('window-all-closed', () => {
  finish({ fixture: fixtureName, ok: false, error: 'window closed before reporting' });
});
