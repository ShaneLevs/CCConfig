<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { Tooltip } from "tdesign-vue-next";

const props = defineProps({
  contributions: { type: Array, default: () => [] },
});

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

const fmt = (num) => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
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
      modelLines: d
        ? Object.entries(d.models || {}).map(([name, data]) => ({
            name,
            input: fmt(data.inputTokens),
            output: fmt(data.outputTokens),
          }))
        : [],
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
      if (currentMonth !== -1) labels.push({ text: `${currentMonth + 1}月`, span });
      currentMonth = month; span = 1;
    } else { span++; }
  }
  if (currentMonth !== -1) labels.push({ text: `${currentMonth + 1}月`, span });
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
        <span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span>
      </div>
      <div class="contrib-grid" :style="{ width: gridWidth + 'px' }">
        <div v-for="(week, wi) in visibleWeeks" :key="wi" class="contrib-week">
          <template v-for="(day, di) in week" :key="di">
            <Tooltip
              v-if="day.date"
              placement="top"
              :show-arrow="true"
            >
              <template #content>
                <div class="tip-content">
                  <div class="tip-header">
                    <span class="tip-date">{{ day.date }}</span>
                    <span class="tip-total">{{ day.totalText || '0' }}</span>
                  </div>
                  <div v-for="m in day.modelLines" :key="m.name" class="tip-line">
                    <span class="tip-name">{{ m.name }}</span>
                    <span class="tip-detail">Input: {{ m.input }} Output: {{ m.output }}</span>
                  </div>
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

.tip-name {
  opacity: 0.7;
}

.tip-detail {
  opacity: 0.9;
}
</style>
