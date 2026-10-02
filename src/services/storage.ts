import type { WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'
import { migrateWorkspace } from './migrate'
import { refreshFindings } from './rules'
import { syncAllReservations } from './quota'

const STORAGE_KEY = 'export-control-review-v1'

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  try {
    const state = JSON.parse(raw) as WorkspaceState
    // 旧数据升级：回填缺失的额度预占，无法回填的标记待人工核对。
    const migrated = migrateWorkspace(state)
    // 规则集或申报内容变化后，让失效预占立即重算，保持额度口径一致。
    const synced = syncAllReservations(state, (packageItem, detail) => {
      state.audit.unshift({
        id: `audit-${crypto.randomUUID()}`,
        packageId: packageItem.id,
        action: '预占失效重算',
        target: packageItem.code,
        operator: '系统',
        detail,
        createdAt: new Date().toISOString(),
      })
    })
    if (migrated || synced) {
      refreshFindings(state)
      saveWorkspace(state)
    }
    return state
  } catch {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  saveWorkspace(initial)
  return initial
}
