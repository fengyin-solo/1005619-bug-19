import type { EntryRow, ModuleMeta } from './types'

/**
 * 模块数据归一化：
 * 1. 同业务标识（或同编号）的重复台账只保留一条，清掉重复残留；
 * 2. 台账里冗余的状态字段与真实状态保持一致，避免页面显示移交前的旧值。
 * 在读取存储时统一跑一遍，列表和抽屉拿到的永远是同一份干净数据。
 */
export function normalizeRows(meta: ModuleMeta, rows: EntryRow[]): EntryRow[] {
  const keyOf = (row: EntryRow): string => {
    if (meta.identityField) {
      return `biz:${String(row[meta.identityField] ?? '').trim()}`
    }
    return `id:${Number(row.id)}`
  }

  const canonicalIndex = new Map<string, number>()
  rows.forEach((row, index) => {
    const key = keyOf(row)
    const existing = canonicalIndex.get(key)
    if (existing === undefined) {
      canonicalIndex.set(key, index)
    } else {
      canonicalIndex.set(key, preferIndex(existing, index, rows))
    }
  })
  const keep = new Set(canonicalIndex.values())

  return rows.filter((_, index) => keep.has(index)).map((row) => {
    if (!meta.statusField) {
      return row
    }
    if (String(row[meta.statusField] ?? '') === String(row.status)) {
      return row
    }
    return { ...row, [meta.statusField]: String(row.status) }
  })
}

// 重复记录里优先保留已走到最终态（已移交）的那条，其次编号最小、排得最靠前的那条；
// 同一座站连提两次移交时，认定第一次落库的结果。
function preferIndex(firstIndex: number, secondIndex: number, rows: EntryRow[]): number {
  const firstDone = rows[firstIndex].status === '已移交'
  const secondDone = rows[secondIndex].status === '已移交'
  if (firstDone !== secondDone) {
    return firstDone ? firstIndex : secondIndex
  }
  return Number(rows[firstIndex].id) <= Number(rows[secondIndex].id) ? firstIndex : secondIndex
}
