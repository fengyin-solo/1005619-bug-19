import { MODULE_BY_KEY } from './modules'
import { normalizeRows } from './normalize'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'district-heating:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 每个模块都过一遍归一化：清掉重复残留、同步冗余状态字段，结果一次性回写。
function normalizeModules(
  data: Record<string, EntryRow[]>,
): { data: Record<string, EntryRow[]>; touched: boolean } {
  let touched = false
  const next: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(data)) {
    const meta = MODULE_BY_KEY.get(key)
    if (!meta) {
      next[key] = rows
      continue
    }
    const cleaned = normalizeRows(meta, rows)
    if (cleaned.length !== rows.length || cleaned.some((row, i) => row !== rows[i])) {
      touched = true
    }
    next[key] = cleaned
  }
  return { data: next, touched }
}

function writeStorage(data: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return normalizeModules(fallback).data
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = normalizeModules(fallback).data
    writeStorage(seeded)
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    // 读取即归一化并回写：缓存里存的永远是干净数据，后续直接改缓存也绕不过去。
    const { data: normalized, touched } = normalizeModules(merged)
    if (touched) {
      writeStorage(normalized)
    }
    return normalized
  } catch {
    const seeded = normalizeModules(fallback).data
    writeStorage(seeded)
    return seeded
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveAll({ [key]: rows })
}

// 跨模块联动一次性落库：换热站移交和停暖通知待办在同一次写入里完成，
// 不会出现一边改了一边没改的半成品状态。落库前再归一化一次，调用方绕不开。
export function saveAll(patch: Record<string, EntryRow[]>): void {
  const normalized: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(patch)) {
    const meta = MODULE_BY_KEY.get(key)
    normalized[key] = meta ? normalizeRows(meta, rows) : rows
  }
  const next = { ...allRows(), ...normalized }
  cache = next
  writeStorage(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 丢掉内存缓存重新读盘：跨标签页改动或外部写入后重新归一化用。
export function reloadStorage(): Record<string, EntryRow[]> {
  cache = null
  return allRows()
}
