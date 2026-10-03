import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const meta = moduleMeta(key)
  const exited = new Set(meta.exitStatuses ?? [])
  const seenIds = new Set<number>()
  const matched = filterRows(listRows(key), filters).filter((row) => {
    if (exited.has(String(row.status))) {
      return false // 已办结退出（如换热站「已移交」）的记录不进当前清单
    }
    const id = Number(row.id)
    if (seenIds.has(id)) {
      return false // 同编号的残留重复记录不进清单
    }
    seenIds.add(id)
    return true
  })
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 单条读取：详情抽屉和列表走同一份数据，不允许另起副本。
export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === id) ?? null
}

// 模块台账里承担「业务状态」的字段（如换热站的站点状态），流转时与当前状态一起更新。
function statusFieldOf(meta: ModuleMeta): string | null {
  for (let i = meta.fields.length - 1; i >= 0; i -= 1) {
    if (meta.fields[i].endsWith('状态')) {
      return meta.fields[i]
    }
  }
  return null
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === 'heatstation' && action === '办理移交') {
    return transferStation(id)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const statusField = statusFieldOf(meta)
  const updated: EntryRow = {
    ...rows[index],
    ...(statusField ? { [statusField]: target } : {}),
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

const TRANSFERRED_STATUS = '已移交'

// 换热站移交：只落库一次。重复提交按第一次的结果认；同一座站的残留重复记录一并清掉；
// 办结后记录退出当前清单，并在停暖通知里生成一条待办理记录。
export function transferStation(id: number): ActionResult {
  const meta = moduleMeta('heatstation')
  const rows = listRows('heatstation')
  const station = rows.find((row) => Number(row.id) === id)
  if (!station) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const name = String(station['站名'] ?? '').trim()
  const area = String(station['所属片区'] ?? '').trim()

  // 同一座站（同编号或同站名）只留一条，其余残留重复记录清掉
  const deduped: EntryRow[] = []
  let kept = false
  for (const row of rows) {
    const sameStation =
      Number(row.id) === id || (name !== '' && String(row['站名'] ?? '').trim() === name)
    if (sameStation) {
      if (!kept) {
        deduped.push(station)
        kept = true
      }
      continue
    }
    deduped.push(row)
  }

  if (String(station.status) === TRANSFERRED_STATUS) {
    // 重复提交：第一次的结果已经落库，只顺手清理残留，不再重复办理
    if (deduped.length !== rows.length) {
      saveRows('heatstation', deduped)
    }
    return { ok: true, message: `${meta.entity}「${name}」首次移交已办结，重复提交按第一次认` }
  }

  if (area === '') {
    return { ok: false, message: `${meta.entity}「${name}」所属片区缺失，移交不予受理` }
  }

  const statusField = statusFieldOf(meta)
  const updated: EntryRow = {
    ...station,
    ...(statusField ? { [statusField]: TRANSFERRED_STATUS } : {}),
    status: TRANSFERRED_STATUS,
    pending: false,
    abnormal: false,
  }
  saveRows('heatstation', deduped.map((row) => (Number(row.id) === id ? updated : row)))
  recordTransferNotice(updated, name, area)
  return { ok: true, message: `${meta.entity}「${name}」移交已落库，当前状态「${TRANSFERRED_STATUS}」` }
}

// 移交办结后在停暖通知里生成一条待办理记录；通知编号按站编号生成，重复提交不会再加。
function recordTransferNotice(station: EntryRow, name: string, area: string): void {
  const code = `YJ-${String(Number(station.id)).padStart(4, '0')}`
  const notices = listRows('heatnotice')
  if (notices.some((row) => String(row['通知编号']) === code)) {
    return
  }
  const nextId = notices.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const notice: EntryRow = {
    id: nextId,
    status: '待拟稿',
    pending: true,
    abnormal: false,
    通知编号: code,
    影响片区: area,
    停暖原因: `换热站「${name}」办理移交`,
    计划开始: new Date().toISOString().slice(0, 10),
    计划恢复: '',
    通知方式: '系统生成',
    发布人: String(station['站长'] ?? ''),
    通知状态: '待拟稿',
  }
  saveRows('heatnotice', [...notices, notice])
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
