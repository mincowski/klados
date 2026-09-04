// MUST stay first: it has to run before `react-dom/client` is evaluated, not
// just before the first render — see that file's own doc comment for what it
// disables and why the renderer hangs without it.
import './devPerformanceTracks'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import favicon from '../../assets/build/icons/32.png?url'
import { App } from './App'
import { beginSessionRestore } from './session/sessionRestore'
import './theme'
import './zoom'
import './commands/builtins'
import './styles/tokens.css'
import './styles/base.css'

// R29 (`R24-tabs.md` §7): must run before the first render —
// `session/sessionRestore.ts`'s own header explains why an effect would be
// too late (a lazily-created empty tab would already exist by then).
beginSessionRestore()

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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
