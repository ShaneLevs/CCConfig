<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { Tooltip } from "tdesign-vue-next";
import { agentLabel } from "../../composables/agentMeta";
import { useUnitFormat } from "../../composables/useUnitFormat";

const { t, locale } = useI18n();
const { formatStat } = useUnitFormat();

// 月份 / 星期标签跟随当前语言（zh-CN: 1月/一，en-US: Jan/M）
const monthText = (month) =>
  new Date(2000, month, 1).toLocaleDateString(locale.value, { month: 'short' });
const weekdayLabels = computed(() => {
  const narrow = (offset) =>
    new Date(2024, 0, 1 + offset).toLocaleDateString(locale.value, { weekday: 'narrow' });
  return ['', narrow(0), '', narrow(2), '', narrow(4), ''];
});

const props = defineProps({
  contributions: { type: Array, default: () => [] },
});

// 单元格 tooltip 的位置自适应。
// 内容高度随当天命中的 agent / 模型数变化，固定 placement="top" 时，热力图正在页面上边缘或
// 下边缘的那几行会被顶出可视区。popper 自带的 flip 在 base placement（无 -start/-end 变体）下
// 兜底列表只有「对向」一个方向（top ↔ bottom），永远不会尝试左右，所以这里显式给出四向兜底
// 顺序；再用 preventOverflow 的 altAxis 在次轴上夹紧（例如翻到左右后仍贴着页面上下边界）。
const TOOLTIP_POPPER_OPTIONS = {
  modifiers: [
    {
      name: "flip",
      options: {
        fallbackPlacements: [
          "bottom",
          "right",
          "left",
          "bottom-start",
          "bottom-end",
          "top-start",
          "top-end",
          "right-start",
          "right-end",
          "left-start",
          "left-end",
        ],
        padding: 12,
      },
    },
    {
      name: "preventOverflow",
      options: { altAxis: true, padding: 12 },
    },
  ],
};

const CELL_SIZE = 12;
const CELL_GAP = 3;
const WEEK_WIDTH = CELL_SIZE + CELL_GAP;
const LABEL_WIDTH = 24;

const containerRef = ref(null);
const containerWidth = ref(700);

let resizeObserver = null;
const measureWidth = () => {
  const w = containerRef.value?.clientWidth || 0;
  // 面板隐藏（v-show display:none）或尚未完成布局时宽度为 0，不覆盖上一次有效值，
  // 否则 maxWeeks 会塌到最小 10 列，热力图只占一小截
  if (w > 0 && w !== containerWidth.value) containerWidth.value = w;
};

onMounted(() => {
  measureWidth();
  // 首次进入统计页时组件可能在 v-show 尚未生效的同一帧挂载（clientWidth=0），
  // 下一帧再补测一次
  requestAnimationFrame(measureWidth);
  window.addEventListener("resize", measureWidth);
  // 监听容器自身尺寸：uTools 窗口重新唤起、面板 0→非 0 都不会触发 window.resize，
  // ResizeObserver 能捕获这些变化
  if (window.ResizeObserver && containerRef.value) {
    resizeObserver = new ResizeObserver(measureWidth);
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", measureWidth);
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
});

const maxWeeks = computed(() => {
  const available = containerWidth.value - LABEL_WIDTH;
  return Math.max(Math.floor(available / WEEK_WIDTH), 10);
});

const fmt = (num) => formatStat(num, { decimals: 1 });

// tooltip 里的模型行：按当天该模型用量降序（input/output 展示为格式化文本）
const modelLinesOf = (models) =>
  Object.entries(models || {})
    .map(([name, data]) => ({
      name,
      input: fmt(data.inputTokens || 0),
      output: fmt(data.outputTokens || 0),
      tokens:
        (data.inputTokens || 0) + (data.outputTokens || 0) +
        (data.cacheReadTokens || 0) + (data.cacheCreationTokens || 0),
    }))
    .sort((a, b) => b.tokens - a.tokens);

// 按 agent 分组的 tooltip 数据：通用统计页的每日贡献带 agentModels（各 agent 当天的归属与模型明细），
// 按当天用量降序分组；单 agent 统计页没有该字段 → 返回空数组，tooltip 走未分组的平铺渲染
const buildAgentGroups = (day) => {
  const entries = Object.entries(day.agentModels || {});
  if (!entries.length) return [];
  return entries
    .map(([agent, group]) => ({
      agent,
      label: agentLabel(agent),
      tokens: group.tokens || 0,
      totalText: fmt(group.tokens || 0),
      lines: modelLinesOf(group.models),
    }))
    .filter((g) => g.lines.length > 0)
    .sort((a, b) => b.tokens - a.tokens);
};

const allWeeks = computed(() => {
  const contribs = props.contributions || [];
  if (!contribs.length) return [];
  const maxTokens = Math.max(...contribs.map((d) => d.tokens), 1);
  const byDate = new Map(contribs.map((d) => [d.date, d]));

  const pad2 = (n) => String(n).padStart(2, "0");
  const keyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  // GitHub 风格：固定展示最近 maxWeeks 周（截止到今天），数据不足的早期周补空单元格，保证铺满整行
  // 起点回退到上一个周日对齐，因此列数恒为 maxWeeks（最多 +1 列，由 visibleWeeks 截断最左侧）
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (maxWeeks.value * 7 - 1));
  start.setDate(start.getDate() - start.getDay()); // 对齐到周日

  const result = [];
  let currentWeek = [];
  const lastKey = keyOf(today); // 用日期字符串比较，避开 Date 对象携带的时分判（跨夏令时会漏掉今天那一格）
  const cursor = new Date(start);
  while (keyOf(cursor) <= lastKey) {
    const key = keyOf(cursor);
    const d = byDate.get(key);
    let level = 0;
    if (d && d.tokens > 0) {
      const ratio = d.tokens / maxTokens;
      level = ratio <= 0.1 ? 1 : ratio <= 0.3 ? 2 : ratio <= 0.6 ? 3 : 4;
    }
    currentWeek.push({
      date: key,
      tokens: d ? d.tokens : 0,
      models: d ? d.models : undefined,
      level,
      totalText: d ? fmt(d.tokens) : "0",
      modelLines: d ? modelLinesOf(d.models) : [],
      agentGroups: d ? buildAgentGroups(d) : [],
    });
    if (currentWeek.length === 7) { result.push(currentWeek); currentWeek = []; }
    cursor.setDate(cursor.getDate() + 1);
  }
  // 本周未过完：最后一列补不可见占位格（.level--1 为 visibility:hidden），保持列宽稳定
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push({ date: "", level: -1 });
    result.push(currentWeek);
  }
  return result;
});

const visibleWeeks = computed(() => {
  const all = allWeeks.value;
  return all.slice(Math.max(0, all.length - maxWeeks.value));
});

const gridWidth = computed(() => {
  const count = visibleWeeks.value.length;
  if (!count) return 0;
  return count * CELL_SIZE + (count - 1) * CELL_GAP;
});

const monthLabels = computed(() => {
  const weeks = visibleWeeks.value;
  if (!weeks.length) return [];
  const labels = [];
  let currentMonth = -1, span = 0;
  for (const week of weeks) {
    const validDay = week.find((d) => d.date);
    if (!validDay) { span++; continue; }
    const month = new Date(validDay.date + "T00:00:00").getMonth();
    if (month !== currentMonth) {
      if (currentMonth !== -1) labels.push({ text: monthText(currentMonth), span });
      currentMonth = month; span = 1;
    } else { span++; }
  }
  if (currentMonth !== -1) labels.push({ text: monthText(currentMonth), span });
  return labels;
});
</script>

<template>
  <div ref="containerRef" class="contrib-wrapper" v-if="visibleWeeks.length">
    <div class="contrib-months">
      <div class="contrib-label-space"></div>
      <div class="contrib-month-row" :style="{ width: gridWidth + 'px' }">
        <div v-for="(label, i) in monthLabels" :key="i" class="contrib-month" :style="{ flex: label.span }">
          {{ label.text }}
        </div>
      </div>
    </div>
    <div class="contrib-body">
      <div class="contrib-day-labels">
        <span v-for="(label, i) in weekdayLabels" :key="i">{{ label }}</span>
      </div>
      <div class="contrib-grid" :style="{ width: gridWidth + 'px' }">
        <div v-for="(week, wi) in visibleWeeks" :key="wi" class="contrib-week">
          <template v-for="(day, di) in week" :key="di">
            <Tooltip
              v-if="day.date"
              placement="top"
              :show-arrow="true"
              :popper-options="TOOLTIP_POPPER_OPTIONS"
            >
              <template #content>
                <div class="tip-content">
                  <div class="tip-header">
                    <span class="tip-date">{{ day.date }}</span>
                    <span class="tip-total">{{ day.totalText || '0' }}</span>
                  </div>
                  <!-- 通用统计页：按 agent 分组（标题 + 该 agent 的模型明细） -->
                  <template v-if="day.agentGroups.length">
                    <div v-for="group in day.agentGroups" :key="group.agent" class="tip-group">
                      <div class="tip-group-header">
                        <span class="tip-agent">{{ group.label }}</span>
                        <span class="tip-group-total">{{ group.totalText }}</span>
                      </div>
                      <div v-for="m in group.lines" :key="m.name" class="tip-line tip-line-grouped">
                        <span class="tip-name">{{ m.name }}</span>
                        <span class="tip-detail">{{ t('usage.tooltipLine', { input: m.input, output: m.output }) }}</span>
                      </div>
                    </div>
                  </template>
                  <!-- 单 agent 统计页：不分组，直接平铺 -->
                  <template v-else>
                    <div v-for="m in day.modelLines" :key="m.name" class="tip-line">
                      <span class="tip-name">{{ m.name }}</span>
                      <span class="tip-detail">{{ t('usage.tooltipLine', { input: m.input, output: m.output }) }}</span>
                    </div>
                  </template>
                </div>
              </template>
              <div :class="['contrib-cell', `level-${day.level}`]"></div>
            </Tooltip>
            <div v-else :class="['contrib-cell', `level-${day.level}`]"></div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.contrib-wrapper {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.contrib-months {
  display: flex;
  align-items: center;
}

.contrib-label-space {
  width: 24px;
  flex-shrink: 0;
}

.contrib-month-row {
  display: flex;
}

.contrib-month {
  font-size: 11px;
  color: var(--td-text-color-placeholder);
  overflow: hidden;
  white-space: nowrap;
}

.contrib-body {
  display: flex;
  gap: 4px;
  align-items: flex-start;
}

.contrib-day-labels {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 20px;
  flex-shrink: 0;
}

.contrib-day-labels span {
  height: 12px;
  line-height: 12px;
  font-size: 10px;
  color: var(--td-text-color-placeholder);
  display: flex;
  align-items: center;
}

.contrib-grid {
  display: flex;
  gap: 3px;
}

.contrib-week {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex-shrink: 0;
}

.contrib-cell {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  cursor: default;
  box-sizing: border-box;
  transition: outline 0.1s;
}

.contrib-cell.level--1 {
  visibility: hidden;
}

.contrib-cell.level-0 {
  background: var(--td-bg-color-component);
}

/* 浅色模式贡献墙颜色 */
.contrib-cell.level-1 {
  background: #9be9a8;
}

.contrib-cell.level-2 {
  background: #40c463;
}

.contrib-cell.level-3 {
  background: #30a14e;
}

.contrib-cell.level-4 {
  background: #216e39;
}

/* 深色模式贡献墙颜色 */
:root[theme-mode="dark"] .contrib-cell.level-1 {
  background: #0e4429;
}

:root[theme-mode="dark"] .contrib-cell.level-2 {
  background: #006d32;
}

:root[theme-mode="dark"] .contrib-cell.level-3 {
  background: #26a641;
}

:root[theme-mode="dark"] .contrib-cell.level-4 {
  background: #39d353;
}

.contrib-cell:hover {
  outline: 1px solid var(--td-text-color-primary);
  outline-offset: 1px;
}

/* Tooltip content */
.tip-content {
  min-width: 160px;
  /* 四向 flip 只决定「往哪边弹」，解决不了「弹出来比视口还高」：agent 很多的极端日期仍会
     超出一屏。这里把高度上限压到视口的一部分，超出部分在弹窗内部滚动。 */
  max-height: 70vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.tip-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.tip-date {
  font-weight: 600;
  font-size: 12px;
}

.tip-total {
  font-size: 11px;
  font-weight: 500;
}

.tip-line {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 12px;
  line-height: 1.8;
}

/* 按 agent 分组：组间细分隔线，组内模型行缩进 */
.tip-group + .tip-group {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed rgba(255, 255, 255, 0.14);
}

.tip-group-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.8;
}

.tip-agent {
  opacity: 0.95;
}

.tip-group-total {
  opacity: 0.7;
  font-weight: 500;
  font-size: 11px;
}

.tip-line-grouped {
  padding-left: 10px;
}

.tip-name {
  opacity: 0.7;
}

.tip-detail {
  opacity: 0.9;
}
</style>
