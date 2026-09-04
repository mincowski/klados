/**
 * The status bar's own registry entry (M5f-PLAN.md §3). Palette-reachable
 * per invariant 10 — the `ⓘ` item is a second surface for this command,
 * never its only home.
 */
import { registerCommand } from '../../commands/registry'
import { openStatisticsPanel } from './statisticsPanelStore'

registerCommand({
  id: 'klados.document.statistics',
  title: 'Document Statistics',
  category: 'View',
  when: 'format',
  surfaces: ['palette'],
  run: () => openStatisticsPanel()
})
