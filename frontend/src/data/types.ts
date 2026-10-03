/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 业务标识字段：同一标识视为同一条台账，归一化时用于清理重复残留。 */
  identityField?: string
  /** 台账里冗余存放状态的字段：状态流转后同步成最新值，避免列表显示旧状态。 */
  statusField?: string
}

/** 办理移交时需要随单一并落库的交接信息。 */
export type TransferPayload = {
  area: string
  manager?: string
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
