import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import { normalizeRows } from '@/data/normalize'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  TransferPayload,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const HEATSTATION_KEY = 'heatstation'
const HEATNOTICE_KEY = 'heatnotice'
const TRANSFER_STATUS = '已移交'

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

export function listEntries(
  key: string,
  filters: Record<string, string> = {},
  options: { includeTransferred?: boolean } = {},
): PageResult {
  const meta = moduleMeta(key)
  let rows = normalizeRows(meta, listRows(key))
  // 换热站办完移交就退出当前清单；勾选「含已移交」时才把档案翻出来。
  if (key === HEATSTATION_KEY && !options.includeTransferred) {
    rows = rows.filter((row) => String(row.status) !== TRANSFER_STATUS)
  }
  const matched = filterRows(rows, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 列表和详情抽屉共用这一个取数口：抽屉按编号直接拿台账里的最新值，
// 不会自己缓存一份，也就不会退回列表时状态又变回旧值。
export function getEntry(key: string, id: number): EntryRow | undefined {
  const meta = moduleMeta(key)
  return normalizeRows(meta, listRows(key)).find((row) => Number(row.id) === id)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = normalizeRows(meta, listRows(key))
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 台账里冗余的状态列同步成最新值，兼容既有站点字段结构。
  if (meta.statusField) {
    updated[meta.statusField] = target
  }
  const next = normalizeRows(
    meta,
    rows.map((row, rowIndex) => (rowIndex === index ? updated : row)),
  )
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function todayString(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 办理换热站移交：
 * - 所属片区缺失（含空串）不予受理；
 * - 一次落库：站点状态、片区、站长与停暖通知待办在同一次写入里完成；
 * - 重复提交按第一次认：已移交的站点幂等返回成功，不再生成任何记录；
 * - 归一化顺手清掉同站残留的重复记录。
 */
export function transferStation(id: number, payload: TransferPayload): ActionResult {
  const meta = moduleMeta(HEATSTATION_KEY)
  const area = payload.area.trim()
  if (!area) {
    return { ok: false, message: '所属片区缺失，移交不予受理，请先补齐交接片区' }
  }

  const stations = normalizeRows(meta, listRows(HEATSTATION_KEY))
  const index = stations.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的换热站` }
  }
  const current = stations[index]

  // 同一座站连着点两次移交：第二次直接认第一次的结果，不再动数据、不重复出通知。
  if (String(current.status) === TRANSFER_STATUS) {
    return { ok: true, message: `「${current['站名']}」已办理移交，按第一次移交结果为准` }
  }

  const manager = payload.manager?.trim() || String(current['站长'] ?? '')
  const today = todayString()
  const updated: EntryRow = {
    ...current,
    所属片区: area,
    站长: manager,
    status: TRANSFER_STATUS,
    pending: false,
    abnormal: false,
    移交日期: today,
  }
  if (meta.statusField) {
    updated[meta.statusField] = TRANSFER_STATUS
  }

  // 映射后再过一遍归一化：同站残留的重复记录在这里合并掉，只留第一次落库的那条。
  const nextStations = normalizeRows(
    meta,
    stations.map((row, rowIndex) => (rowIndex === index ? updated : row)),
  )

  // 移交结果落到停暖通知的待办理清单：一座站一张待发布通知，按通知编号幂等。
  const noticeMeta = moduleMeta(HEATNOTICE_KEY)
  let notices = normalizeRows(noticeMeta, listRows(HEATNOTICE_KEY))
  const noticeNo = `YJ-${String(id).padStart(4, '0')}`
  let noticeCreated = false
  if (!notices.some((row) => String(row['通知编号']) === noticeNo)) {
    const nextId = notices.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    notices = [
      ...notices,
      {
        id: nextId,
        status: '待发布',
        pending: true,
        abnormal: false,
        通知编号: noticeNo,
        影响片区: area,
        停暖原因: `换热站【${updated['站名']}】移交，需核对停暖范围`,
        计划开始: today,
        计划恢复: '待对方单位确认',
        通知方式: '待补发',
        发布人: manager,
        通知状态: '待发布',
      },
    ]
    noticeCreated = true
  }

  saveAll({ [HEATSTATION_KEY]: nextStations, [HEATNOTICE_KEY]: notices })
  return {
    ok: true,
    message: `「${updated['站名']}」已移交至${area}，当前状态「${TRANSFER_STATUS}」${
      noticeCreated ? '，停暖通知待办理清单已新增待发布通知' : ''
    }`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of normalizeRows(meta, listRows(key))) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
