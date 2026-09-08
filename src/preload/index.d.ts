import type { KladosApi } from './api'

declare global {
  interface Window {
    api: KladosApi
  }
}
