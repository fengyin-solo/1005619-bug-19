<template>
  <section class="page" data-module="heatstation">
    <header class="page-head">
      <div>
        <h2>换热站台账管理</h2>
        <p class="page-desc">维护换热站，围绕站名、所属片区、供热面积、换热机组数做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记换热站</button>
        <button class="btn" type="button" @click="exportRows">导出换热站台账清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      <label class="filter-item archive-toggle">
        <input v-model="includeTransferred" type="checkbox" @change="reload" />
        <span>含已移交站点（已退出当前清单）</span>
      </label>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <button v-if="column === '站名'" class="link" type="button" @click="openDetail(row.id)">
              {{ row[column] ?? '—' }}
            </button>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无换热站台账数据，可先登记换热站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条换热站台账记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="detail-drawer" role="dialog" aria-modal="true" aria-label="换热站详情">
        <header class="drawer-head">
          <h3>换热站详情</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <dl class="detail-grid">
          <div v-for="field in detailFields" :key="field" class="detail-item">
            <dt>{{ field }}</dt>
            <dd>{{ detail[field] ?? '—' }}</dd>
          </div>
          <div class="detail-item">
            <dt>当前状态</dt>
            <dd>{{ detail.status }}</dd>
          </div>
        </dl>

        <section v-if="detail.status !== '已移交'" class="transfer-panel">
          <h4>办理移交</h4>
          <p class="panel-hint">一次落库：更新所属片区、站长与站点状态，并在停暖通知待办理清单生成待发布通知。</p>
          <form class="transfer-form" @submit.prevent="submitTransfer">
            <label class="filter-item">
              <span>移交后所属片区 <em>*</em></span>
              <input v-model="transferForm.area" placeholder="必填，缺失不予受理" />
            </label>
            <label class="filter-item">
              <span>移交后站长</span>
              <input v-model="transferForm.manager" placeholder="留空则保持原站长" />
            </label>
            <div class="transfer-actions">
              <button class="btn primary" type="submit">确认移交</button>
              <button
                v-for="action in nonTransferActions"
                :key="action"
                class="btn"
                type="button"
                @click="runAction(action, detail)"
              >
                {{ action }}
              </button>
            </div>
          </form>
        </section>
        <p v-else class="panel-hint">该站点已办理移交并退出当前清单；重复提交按第一次移交结果为准。</p>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  transferStation,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('heatstation')
const columns = ["站名", "所属片区", "供热面积", "换热机组数", "投运日期", "站长", "设计负荷", "站点状态"]
const allActions = ["提交投运", "登记停运", "办理移交"]
const nonTransferActions = allActions.filter((action) => action !== '办理移交')
const statuses = ["待投运", "运行中", "已停运", "已移交"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const includeTransferred = ref(false)

const detailId = ref<number | null>(null)
// 抽屉数据来自统一取数口 getEntry：每次重取台账最新值，列表与抽屉同一份数据。
const detail = ref<EntryRow | null>(null)
const detailFields = ["站名", "所属片区", "供热面积", "换热机组数", "投运日期", "站长", "设计负荷", "移交日期"]
const transferForm = reactive({ area: '', manager: '' })

const stats = computed(() => [
  { label: "运行中站点", value: rows.value.filter((row) => String(row.status) === "运行中").length },
  { label: "待投运站点", value: rows.value.filter((row) => String(row.status) === "待投运").length },
  {
    label: "累计供热面积",
    value: rows.value.reduce((sum, row) => sum + (Number(row["供热面积"]) || 0), 0),
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function setMessage(text: string, ok = false) {
  message.value = text
  messageOk.value = ok
}

function availableActions(row: EntryRow): string[] {
  // 已移交站点不再展示任何状态动作，重复移交只能在第一次被认定。
  if (String(row.status) === '已移交') {
    return []
  }
  return allActions
}

function refreshDetail() {
  if (detailId.value === null) {
    detail.value = null
    return
  }
  detail.value = getEntry(meta.key, detailId.value) ?? null
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  setMessage('换热站登记入口尚未接入审批流')
}

function openDetail(id: number) {
  detailId.value = id
  const current = getEntry(meta.key, id)
  // 预填现有片区、站长；所属片区本来就缺失的留空，提交时会被拦下不予受理。
  transferForm.area = current ? String(current['所属片区'] ?? '') : ''
  transferForm.manager = current ? String(current['站长'] ?? '') : ''
  setMessage('')
  refreshDetail()
}

function closeDetail() {
  detailId.value = null
  detail.value = null
  // 关闭抽屉不触发任何写操作，回到列表重新读台账，状态不会被打回待投运。
  reload()
}

function runAction(action: string, row: EntryRow) {
  // 移交必须在详情抽屉里补齐交接片区，列表上的入口直接打开抽屉，不走通用动作。
  if (action === '办理移交') {
    openDetail(Number(row.id))
    return
  }
  setMessage('')
  const result = applyAction(meta.key, Number(row.id), action)
  setMessage(result.message, result.ok)
  if (!result.ok) {
    return
  }
  reload()
  refreshDetail()
}

function submitTransfer() {
  if (detailId.value === null) {
    return
  }
  const result = transferStation(detailId.value, { ...transferForm })
  setMessage(result.message, result.ok)
  if (!result.ok) {
    return
  }
  transferForm.area = ''
  transferForm.manager = ''
  reload()
  refreshDetail()
  // 办完自动退出当前清单：移交成功后抽屉自动关闭。
  if (detail.value && String(detail.value.status) === '已移交') {
    closeDetail()
  }
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value, {
      includeTransferred: includeTransferred.value,
    })
    rows.value = payload.items
    total.value = payload.total
    refreshDetail()
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '换热站台账列表读取失败')
  }
}

onMounted(reload)
</script>

<style scoped>
.archive-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
}
.archive-toggle input {
  margin: 0;
}
.ok-text {
  color: #067647;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 20;
}
.detail-drawer {
  width: 480px;
  max-width: 92vw;
  height: 100%;
  background: #fff;
  padding: 18px 20px;
  overflow-y: auto;
  box-shadow: -8px 0 24px rgba(15, 23, 42, 0.18);
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.drawer-head h3 {
  margin: 0;
  font-size: 16px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 16px;
  margin: 0 0 18px;
}
.detail-item dt {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 2px;
}
.detail-item dd {
  margin: 0;
  font-size: 14px;
}
.transfer-panel {
  border-top: 1px solid var(--border);
  padding-top: 14px;
}
.transfer-panel h4 {
  margin: 0 0 4px;
  font-size: 14px;
}
.panel-hint {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 10px;
}
.transfer-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.transfer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.transfer-form em {
  color: #b42318;
  font-style: normal;
}
</style>
