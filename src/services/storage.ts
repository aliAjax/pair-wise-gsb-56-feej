import type { WorkspaceState } from '@/types/domain'
import { createInitialState, createLegacyV1State } from './mockData'
import { migrateWorkspace, needsMigration } from './migration'

const STORAGE_KEY = 'export-control-review-v1'
const LOCK_KEY = 'export-control-review-lock'
const CLIENT_KEY = 'export-control-client-id'
const LOCK_TTL_MS = 5_000

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  if (needsMigration(parsed)) {
    const migrated = migrateWorkspace(parsed)
    saveWorkspace(migrated)
    return migrated
  }
  return parsed as WorkspaceState
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  saveWorkspace(initial)
  return initial
}

/**
 * 恢复成升级前的 v1 演示数据并立即触发迁移，用于演示旧数据回填与待人工核对。
 */
export function simulateLegacyUpgrade(): WorkspaceState {
  const legacy = createLegacyV1State()
  saveWorkspace(legacy)
  return loadWorkspace()
}

/* -------------------------------- 客户端标识 ------------------------------- */

/** 每个浏览器标签页一个客户端 ID，用于识别并发提交是否来自同一操作者 */
export function getClientId(): string {
  const existing = window.sessionStorage.getItem(CLIENT_KEY)
  if (existing) return existing
  const clientId = `client-${crypto.randomUUID()}`
  window.sessionStorage.setItem(CLIENT_KEY, clientId)
  return clientId
}

/* -------------------------------- 跨标签互斥锁 ------------------------------ */

interface LockPayload {
  owner: string
  acquiredAt: number
}

/**
 * localStorage 级写锁：同一时刻只允许一个标签页执行占用/扣减类操作。
 * 持锁标签页崩溃时锁会在 TTL 后自动失效。
 */
export function acquireMutationLock(owner: string): boolean {
  const raw = window.localStorage.getItem(LOCK_KEY)
  if (raw) {
    try {
      const lock = JSON.parse(raw) as LockPayload
      if (lock.owner !== owner && Date.now() - lock.acquiredAt < LOCK_TTL_MS) {
        return false
      }
    } catch {
      // 损坏的锁直接覆盖
    }
  }
  const payload: LockPayload = { owner, acquiredAt: Date.now() }
  window.localStorage.setItem(LOCK_KEY, JSON.stringify(payload))
  // 再次读回确认写入未被其他标签页抢占
  const confirmed = window.localStorage.getItem(LOCK_KEY)
  return confirmed === JSON.stringify(payload)
}

export function releaseMutationLock(owner: string): void {
  const raw = window.localStorage.getItem(LOCK_KEY)
  if (!raw) return
  try {
    const lock = JSON.parse(raw) as LockPayload
    if (lock.owner === owner) window.localStorage.removeItem(LOCK_KEY)
  } catch {
    window.localStorage.removeItem(LOCK_KEY)
  }
}
