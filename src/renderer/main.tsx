// MUST stay first: it has to run before `react-dom/client` is evaluated, not
// just before the first render — see that file's own doc comment for what it
// disables and why the renderer hangs without it.
import './devPerformanceTracks'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import favicon from '../../assets/build/icons/32.png?url'
import { App } from './App'
import { beginSessionRestore } from './session/sessionRestore'
import {
  listenForSystemOpens,
  openPathsFromSystem,
  rememberOpenedPath,
  takeLaunchPaths
} from './session/openFromSystem'
import './theme'
import './zoom'
import './commands/builtins'
import './styles/tokens.css'
import './styles/base.css'

// Set via a `?url` import rather than a `<link>` in index.html — a raw
// relative `href` there resolves against Vite's dev-server root
// (`src/renderer`), and `assets/build/` sits outside it, so it 404s under
// `npm run dev` despite working in a production build (Vite's static file
// serving enforces a root boundary that its module-graph asset imports do
// not). `?url` goes through that pipeline instead, so it resolves the same
// way in both.
const link = document.createElement('link')
link.rel = 'icon'
link.type = 'image/png'
link.href = favicon
document.head.appendChild(link)

const container = document.getElementById('root')
if (container === null) throw new Error('#root element is missing from index.html')

async function start(root: HTMLElement): Promise<void> {
  // R219 (`docs/plans/R219-open-with.md` §4): files the operating system
  // launched Klados with. Listening first costs nothing — main pushes only
  // after the launch paths are taken — and leaves no gap between the two.
  listenForSystemOpens()
  const launchPaths = await takeLaunchPaths()

  // R29 (`R24-tabs.md` §7): must run before the first render —
  // `session/sessionRestore.ts`'s own header explains why an effect would be
  // too late (a lazily-created empty tab would already exist by then). The
  // launch paths open after it for the same reason, and are matched against
  // its tabs so a file that was open last time is focused, not opened twice.
  for (const { id, path } of beginSessionRestore()) rememberOpenedPath(id, path)
  openPathsFromSystem(launchPaths)

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void start(container)
