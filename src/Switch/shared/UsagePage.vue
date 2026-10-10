<script setup>
// 通用统计页：Claude Code / Pi Agent / OpenCode / DSH 与「通用配置」汇总统计共用同一页面，仅数据源与文案不同。
// - 热力图：固定展示最近 N 周（铺满整行，GitHub 风格）
// - 模型使用分布：进度条相对最大值（最多的模型整条满，其余按比例）
import { ref, computed, onMounted, nextTick } from "vue";
import { Card, Statistic, Empty, Button, DateRangePicker, Space, Tooltip } from "tdesign-vue-next";
import {
  RefreshIcon, ArrowDownIcon, ArrowUpIcon, SumIcon,
  ChevronUpIcon, ChevronDownIcon,
} from "tdesign-icons-vue-next";
import ContributionGrid from "./ContributionGrid.vue";
import "./styles/UsagePage.css";

const props = defineProps({
  // 头部提示文案
  tip: { type: String, default: "统计仅供参考" },
  // 数据加载函数：(force) => { summary, modelStats, contributions }（同步或 Promise 均可）
  fetcher: { type: Function, required: true },
  // 模型分布卡片右上角补充说明（如 Claude 的会话数口径说明）
  modelHint: { type: String, default: "" },
  // 完全无数据时的描述
  emptyDescription: { type: String, default: "暂无使用数据" },
  // 完全无数据时的补充提示（如 OpenCode 的 db 路径说明）
  emptyHint: { type: String, default: "" },
});

const loading = ref(false);
const showAllModels = ref(false);
const dateRange = ref([]);

const usageData = ref({
  summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
  modelStats: [],
  contributions: [],
});

const stats = [
  { key: "total", title: "总 Tokens", icon: SumIcon, colorClass: "stat-green", iconColor: "#52c41a" },
  { key: "input", title: "输入 Tokens（含缓存）", icon: ArrowUpIcon, colorClass: "stat-red", iconColor: "#f5222d" },
  { key: "output", title: "输出 Tokens", icon: ArrowDownIcon, colorClass: "stat-pink", iconColor: "#eb2f96" },
];

const displayLimit = 5;

const formatNumber = (num) => {
  if (!num || num === 0) return "0";
  const units = ["", "K", "M", "B", "T", "Q"];
  let tier = 0;
  while (num >= 1000 && tier < units.length - 1) {
    num /= 1000;
    tier++;
  }
  return tier === 0 ? num.toString() : num.toFixed(2) + units[tier];
};

const hasDateFilter = computed(() => dateRange.value.length === 2);

// 按日期区间过滤并重新计算统计（兼容三种数据形状：
// day 可能带 inputTokens（OpenCode）或只带 outputTokens（Claude/Pi，输入 = 总量 - 输出）；
// model 可能带 cacheReadTokens/cacheCreationTokens）
const filteredData = computed(() => {
  const raw = usageData.value;
  if (!hasDateFilter.value) return raw;

  const [from, to] = dateRange.value;
  const filteredContributions = raw.contributions.filter(c => c.date >= from && c.date <= to);

  let totalTokens = 0, inputTokens = 0, outputTokens = 0;
  const modelMap = new Map();

  for (const day of filteredContributions) {
    const dayTotal = day.tokens || 0;
    const dayOut = day.outputTokens || 0;
    totalTokens += dayTotal;
    outputTokens += dayOut;
    inputTokens += day.inputTokens != null ? day.inputTokens : dayTotal - dayOut;
    if (day.models) {
      for (const [modelName, modelData] of Object.entries(day.models)) {
        if (!modelMap.has(modelName)) {
          modelMap.set(modelName, { name: modelName, tokens: 0, inputTokens: 0, outputTokens: 0 });
        }
        const m = modelMap.get(modelName);
        const cacheR = modelData.cacheReadTokens || 0;
        const cacheC = modelData.cacheCreationTokens || 0;
        const inp = modelData.inputTokens || 0;
        const out = modelData.outputTokens || 0;
        m.tokens += inp + out + cacheR + cacheC;
        m.inputTokens += inp + cacheR + cacheC;
        m.outputTokens += out;
      }
    }
  }

  return {
    summary: { ...raw.summary, totalTokens, inputTokens, outputTokens },
    modelStats: Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens),
    contributions: filteredContributions,
  };
});

const displayedModelStats = computed(() => {
  if (showAllModels.value) return filteredData.value.modelStats;
  return filteredData.value.modelStats.slice(0, displayLimit);
});

const hasMoreModels = computed(() => filteredData.value.modelStats.length > displayLimit);

// 模型进度条相对最大值：使用最多的模型整条拉满，其余按比例
const maxModelTokens = computed(() => filteredData.value.modelStats[0]?.tokens || 1);

const getStatValue = (key) => {
  const data = filteredData.value.summary;
  switch (key) {
    case "total": return data.totalTokens;
    case "input": return data.inputTokens;
    case "output": return data.outputTokens;
    default: return 0;
  }
};

const hasAnyData = computed(() =>
  usageData.value.contributions.length > 0 || usageData.value.modelStats.length > 0
);

const loadData = async (forceRefresh = false) => {
  loading.value = true;
  await nextTick();
  setTimeout(() => {
    try {
      const result = props.fetcher(forceRefresh);
      Promise.resolve(result).then((r) => {
        usageData.value = {
          summary: r?.summary || { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
          modelStats: r?.modelStats || [],
          contributions: r?.contributions || [],
        };
        loading.value = false;
      });
    } catch (e) {
      console.error("加载用量统计失败:", e);
      loading.value = false;
    }
  }, 50);
};

const handleRefresh = () => {
  dateRange.value = [];
  loadData(true);
};

onMounted(() => loadData(true));

defineExpose({ loadData });
</script>

<template>
  <div class="usage-page">
    <div class="usage-header">
      <span class="usage-tip">{{ tip }}</span>
      <div class="usage-actions">
        <DateRangePicker
          v-model="dateRange"
          mode="date"
          allow-input
          clearable
          size="small"
          :enable-time-picker="false"
          :presets="[
            { label: '近 7 天', value: [new Date(Date.now() - 6 * 864e5), new Date()] },
            { label: '近 30 天', value: [new Date(Date.now() - 29 * 864e5), new Date()] },
          ]"
          class="usage-date-picker"
          placeholder="选择日期区间"
        />
        <Tooltip content="刷新" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="handleRefresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="!loading && !hasAnyData && emptyHint" class="usage-empty-hint">{{ emptyHint }}</div>

    <!-- 统计卡片 -->
    <div class="stat-cards-row">
      <div v-for="s in stats" :key="s.key" class="stat-card" :class="s.colorClass">
        <Statistic :value="getStatValue(s.key)" :format="formatNumber">
          <template #title>
            <span class="stat-title-row">
              <span class="stat-icon-wrap" :style="{ background: s.iconColor + '20', color: s.iconColor }">
                <component :is="s.icon" size="14px" />
              </span>
              <span>{{ s.title }}</span>
            </span>
          </template>
        </Statistic>
      </div>
    </div>

    <!-- 贡献墙（铺满最近 N 周） -->
    <Card title="热力图">
      <div v-if="loading" class="empty-small">
        <Empty description="加载中..." size="small" />
      </div>
      <div v-else-if="filteredData.contributions.length === 0" class="empty-small">
        <Empty :description="emptyDescription" size="small" />
      </div>
      <ContributionGrid v-else :contributions="filteredData.contributions" />
    </Card>

    <!-- 模型使用分布（进度条相对最大值） -->
    <Card title="模型使用分布" class="usage-model-card">
      <template #actions>
        <span v-if="modelHint" class="model-hint">{{ modelHint }}</span>
        <Button v-if="hasMoreModels" size="small" variant="text" @click="showAllModels = !showAllModels">
          <template #icon>
            <component :is="showAllModels ? ChevronUpIcon : ChevronDownIcon" size="14px" />
          </template>
          {{ showAllModels ? '收起' : `查看更多 (${filteredData.modelStats.length - displayLimit})` }}
        </Button>
      </template>
      <div v-if="loading" class="empty-small">
        <Empty description="加载中..." size="small" />
      </div>
      <div v-else-if="filteredData.modelStats.length === 0" class="empty-small">
        <Empty :description="emptyDescription" size="small" />
      </div>
      <div v-else class="usage-model-list">
        <div v-for="model in displayedModelStats" :key="model.name" class="usage-model-row">
          <div class="usage-model-bar-track">
            <div class="usage-model-bar" :style="{ width: (model.tokens / maxModelTokens * 100) + '%' }"></div>
          </div>
          <div class="usage-model-row-content">
            <span class="usage-model-row-name">{{ model.name }}</span>
            <Space size="small" class="usage-model-row-stats">
              <span class="usage-model-stat">{{ formatNumber(model.tokens) }} tokens</span>
              <span class="usage-model-stat-divider">|</span>
              <span class="usage-model-stat">in {{ formatNumber(model.inputTokens) }}</span>
              <span class="usage-model-stat-divider">|</span>
              <span class="usage-model-stat">out {{ formatNumber(model.outputTokens) }}</span>
              <template v-if="model.sessions">
                <span class="usage-model-stat-divider">|</span>
                <span class="usage-model-stat">{{ model.sessions }} 次会话</span>
              </template>
            </Space>
          </div>
        </div>
      </div>
    </Card>
  </div>
</template>
