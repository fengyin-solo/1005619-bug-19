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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
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
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detailRow" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer" role="dialog" aria-label="换热站详情">
        <header class="drawer-head">
          <h3>换热站详情</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="drawer-body">
          <div v-for="column in columns" :key="column" class="drawer-item">
            <dt>{{ column }}</dt>
            <dd>{{ detailRow[column] ?? '—' }}</dd>
          </div>
          <div class="drawer-item">
            <dt>当前状态</dt>
            <dd>{{ detailRow.status }}</dd>
          </div>
        </dl>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('heatstation')
const columns = ["站名", "所属片区", "供热面积", "换热机组数", "投运日期", "站长", "设计负荷", "站点状态"]
const actions = ["提交投运", "登记停运", "办理移交"]
const statuses = ["待投运", "运行中", "已停运", "已移交"]
const stats = [{"label": "运行中站点", "value": 0}, {"label": "待投运站点", "value": 0}, {"label": "累计供热面积", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const detailRow = ref<EntryRow | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '换热站登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  // 抽屉和列表取同一份数据：打开时按编号重新读，不沿用行里的旧快照
  const fresh = getEntry(meta.key, Number(row.id))
  if (!fresh) {
    errorMessage.value = '该换热站记录已不在台账中'
    return
  }
  errorMessage.value = ''
  infoMessage.value = ''
  detailRow.value = fresh
}

function closeDetail() {
  detailRow.value = null
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  if (action === '办理移交') {
    closeDetail()
  } else if (detailRow.value && Number(detailRow.value.id) === Number(row.id)) {
    detailRow.value = getEntry(meta.key, Number(row.id))
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '换热站台账列表读取失败'
  }
}

onMounted(reload)
</script>
