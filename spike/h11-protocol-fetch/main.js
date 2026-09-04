// M5-PLAN.md H11 spike — standalone Electron harness, not part of the app.
// Registers a custom scheme, serves a fixture file through it via a
// fs.ReadStream (never materializing the whole file in main), opens a
// hidden BrowserWindow, and has a Worker inside it fetch the URL and call
// arrayBuffer(). Reports renderer-process RSS before/after via
// app.getAppMetrics(), with and without Content-Length set, which is the
// one thing the plan says decides go/no-go.
//
// Run: electron main.js <fixture-path> [no-content-length]
const { app, protocol, BrowserWindow, ipcMain } = require('electron')
const { createReadStream, statSync } = require('fs')
const { Readable } = require('stream')
const path = require('path')

const FIXTURE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'fixtures', 'cars-200mb.xml'))
const SET_CONTENT_LENGTH = process.argv[3] !== 'no-content-length'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nodepad-spike',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
])

app.whenReady().then(() => {
  protocol.handle('nodepad-spike', (request) => {
    try {
      const url = new URL(request.url)
      console.log('protocol.handle request', request.url, 'pathname=', url.pathname)
      if (url.pathname !== '/fixture') return new Response('not found', { status: 404 })
      const size = statSync(FIXTURE).size
      const stream = createReadStream(FIXTURE)
      const headers = { 'content-type': 'application/octet-stream' }
      if (SET_CONTENT_LENGTH) headers['content-length'] = String(size)
      const webStream = Readable.toWeb(stream)
      return new Response(webStream, { headers })
    } catch (err) {
      console.error('protocol.handle error', err)
      return new Response(String(err && err.stack), { status: 500 })
    }
  })

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  function rssOfRenderer() {
    const metrics = app.getAppMetrics()
    const pid = win.webContents.getOSProcessId()
    const target = metrics.find((m) => m.pid === pid)
    return target ? target.memory.workingSetSize : null // KB
  }

  let beforeKb = null
  ipcMain.once('spike:before', () => {
    beforeKb = rssOfRenderer()
  })
  ipcMain.once('spike:result', (_event, result) => {
    const afterKb = rssOfRenderer()
    console.log(
      'SPIKE_RESULT ' +
        JSON.stringify({
          ...result,
          fixture: FIXTURE,
          setContentLength: SET_CONTENT_LENGTH,
          rendererRssBeforeKb: beforeKb,
          rendererRssAfterKb: afterKb,
          rendererRssDeltaKb: beforeKb != null && afterKb != null ? afterKb - beforeKb : null
        })
    )
    app.quit()
  })
  ipcMain.once('spike:error', (_event, message) => {
    console.error('SPIKE_ERROR ' + message)
    app.exit(1)
  })

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('did-fail-load', code, desc)
    app.exit(1)
  })

  win.loadFile(path.join(__dirname, 'index.html'))
})
