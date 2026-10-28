import type { StatusSnapshot } from '../types/runtime.js'
import { buildAgentPanels } from './displayAgents.js'
import { reconcileProjectOrder } from './projectOrder.js'
import { reconcileTaskOrder } from './taskOrder.js'

/** Host-owned first-seen positions shared by HUD, its preview and the device API. */
export interface WorkPresentationOrder { projects: string[]; tasks: string[] }
export function buildWorkPresentation(snapshot: Pick<StatusSnapshot, 'agents' | 'workOrder'>) {
  const projects = reconcileProjectOrder(buildAgentPanels(snapshot.agents, { perTask: true }), snapshot.workOrder?.projects ?? [])
  const tasks = reconcileTaskOrder(projects.panels, snapshot.workOrder?.tasks ?? [])
  return { panels: tasks.panels, order: { projects: projects.order, tasks: tasks.order } }
}
