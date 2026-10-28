<script setup>
// Token 柱状图：按时间堆叠展示各「模型」/ 各「Agent」的 Token 用量。
// 只吃统计页已有的 contributions 派生数据（每天带 models / agentModels），不新增采集，
// 也不展示我们没落库的口径（价格 / 速度 / 命中率 / 请求数）。
// - 分桶随时段自适应：跨度 ≤ 30 天按天（每根柱一天），> 30 天按周（周日为起点，与热力图对齐）
// - 分类：按区间总量降序，前 MAX_SEGMENTS 个单独着色，其余合并成「其他」
// - 叠放顺序固定按全局排名（颜色在各柱间对得上），柱高以该柱自身合计为分母
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Empty } from "tdesign-vue-next";
import { agentLabel } from "../../composables/agentMeta";

const { t, locale } = useI18n();

const props = defineProps({
  // [{ date: 'YYYY-MM-DD', models: { name: tokens }, agents: { id: tokens } }]，按日期升序
  days: { type: Array, default: () => [] },
  // 'model' | 'agent'
  dimension: { type: String, default: "model" },
  emptyDescription: { type: String, default: "" },
});

const MAX_SEGMENTS = 6;
// 分桶粒度分界：区间跨度 ≤ 30 天按天统计，超过才按周
const DAY_THRESHOLD_DAYS = 30;
const MAX_X_LABELS = 10;

const PALETTE = ["#8b8bf5", "#58c4f2", "#4dd0a5", "#f5c542", "#f2789f", "#f79a5b"];
const OTHER_COLOR = "#8a8a95";
const OTHER_KEY = "__other";

const pad2 = (n) => String(n).padStart(2, "0");
const parseDate = (dateStr) => new Date(`${dateStr}T00:00:00`);

// 轴刻度用紧凑写法（1B / 750M），图例 / tooltip 用完整数字
const formatCompact = (num) => {
  if (!num) return "0";
  const units = ["", "K", "M", "B", "T"];
  let tier = 0;
  let value = num;
  while (value >= 1000 && tier < units.length - 1) {
    value /= 1000;
    tier++;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))}${units[tier]}`;
};

const formatExact = (num) =>
  (num || 0).toLocaleString(locale.value, { maximumFractionDigits: 0 });

const categoryLabel = (key) => (props.dimension === "agent" ? agentLabel(key) : key);

// ==================== 时间分桶 ====================
const weekKeyOf = (dateStr) => {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() - d.getDay());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

// 当前维度在某天的分类合计（柱高与分段之和必须同源，否则会出现「柱子有高度但没有颜色」）
const catsOf = (day) => {
  const raw = (props.dimension === "agent" ? day.agents : day.models) || {};
  return Object.entries(raw).filter(([, tokens]) => tokens > 0);
};

// 只以「当前维度有用量」的日期确定区间：contributions 会被补齐成 365 天零值，
// 直接按长度判断会让跨度永远算成 365 天，粒度恒为按周
const dataRange = computed(() => {
  const withData = props.days.filter((d) => catsOf(d).length > 0);
  if (!withData.length) return null;
  return { from: withData[0].date, to: withData[withData.length - 1].date };
});

// 'day' | 'week'：按「有用量日期」的天数判断，日期筛选后自动切换（近 7 天 = 7 根柱子）。
// 用含首尾的天数比较：选 30 天 → 30 根日柱，选 31 天 → 改按周
const granularity = computed(() => {
  const range = dataRange.value;
  if (!range) return "day";
  const days = (parseDate(range.to) - parseDate(range.from)) / 864e5 + 1;
  return days > DAY_THRESHOLD_DAYS ? "week" : "day";
});

const bucketKeyOf = (dateStr) =>
  granularity.value === "day" ? dateStr : weekKeyOf(dateStr);

const shortDate = (date) => `${date.getMonth() + 1}/${date.getDate()}`;

// x 轴：单日就是当天，周桶取起始日（与热力图的周对齐一致）
const axisLabel = (key) => shortDate(parseDate(key));

// tooltip 标题：单日显示「日期 + 星期」，周桶显示「起 – 止」
const bucketLabel = (key) => {
  const start = parseDate(key);
  if (granularity.value === "day") {
    const weekday = start.toLocaleDateString(locale.value, { weekday: "short" });
    return `${start.toLocaleDateString(locale.value, { month: "short", day: "numeric" })} ${weekday}`;
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${shortDate(start)} – ${shortDate(end)}`;
};

// 区间内连续的桶（中间没数据也留空柱，避免时间轴被压缩失真）
const rawBuckets = computed(() => {
  const range = dataRange.value;
  if (!range) return [];
  const map = new Map();
  const ensure = (key) => {
    if (!map.has(key)) map.set(key, { key, total: 0, cats: {} });
    return map.get(key);
  };
  const cursor = parseDate(range.from);
  const end = parseDate(range.to);
  const perDay = granularity.value === "day";
  if (!perDay) cursor.setDate(cursor.getDate() - cursor.getDay()); // 周桶对齐到周日
  while (cursor <= end) {
    ensure(`${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`);
    if (perDay) cursor.setDate(cursor.getDate() + 1);
    else cursor.setDate(cursor.getDate() + 7);
  }

  for (const day of props.days) {
    const entries = catsOf(day);
    if (!entries.length) continue;
    const bucket = ensure(bucketKeyOf(day.date));
    for (const [key, tokens] of entries) {
      bucket.cats[key] = (bucket.cats[key] || 0) + tokens;
      bucket.total += tokens;
    }
  }
  return Array.from(map.values());
});

// ==================== 分类排名与图例 ====================
const categoryRank = computed(() => {
  const totals = new Map();
  for (const bucket of rawBuckets.value) {
    for (const [key, tokens] of Object.entries(bucket.cats)) {
      totals.set(key, (totals.get(key) || 0) + tokens);
    }
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, tokens]) => ({ key, tokens, label: categoryLabel(key) }));
});

// 排名 → 颜色 / 叠放次序；超出 MAX_SEGMENTS 的并入「其他」
const rankIndexOf = (key) => categoryRank.value.findIndex((r) => r.key === key);

const segmentOf = (key, tokens) => {
  const index = rankIndexOf(key);
  const isOther = index < 0 || index >= MAX_SEGMENTS;
  return {
    key: isOther ? OTHER_KEY : key,
    order: isOther ? MAX_SEGMENTS + 1 : index,
    tokens,
    color: isOther ? OTHER_COLOR : PALETTE[index % PALETTE.length],
    label: isOther ? t("usage.chartOther") : categoryLabel(key),
  };
};

const maxBucketTotal = computed(() =>
  rawBuckets.value.reduce((max, bucket) => Math.max(max, bucket.total), 0)
);

const niceStep = (value) => {
  if (!(value > 0)) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const ratio = value / base;
  const multipliers = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const pick = multipliers.find((m) => ratio <= m) || 10;
  return pick * base;
};

const yAxis = computed(() => {
  const step = niceStep(maxBucketTotal.value / 4);
  const top = step * 4;
  return {
    top,
    ticks: [0, 1, 2, 3, 4].map((i) => ({
      value: step * i,
      text: formatCompact(step * i),
      pct: (step * i) / top * 100,
    })),
  };
});

// 柱：叠放段高度按该柱自身合计分摊，柱高按纵轴上限换算
const columns = computed(() => {
  const top = yAxis.value.top || 1;
  return rawBuckets.value.map((bucket) => {
    const merged = new Map();
    for (const [key, tokens] of Object.entries(bucket.cats)) {
      const seg = segmentOf(key, tokens);
      const current = merged.get(seg.key);
      if (current) current.tokens += seg.tokens;
      else merged.set(seg.key, seg);
    }
    const segments = Array.from(merged.values())
      .filter((seg) => seg.tokens > 0)
      .sort((a, b) => a.order - b.order);
    const segTotal = segments.reduce((sum, seg) => sum + seg.tokens, 0) || 1;
    return {
      key: bucket.key,
      total: bucket.total,
      totalText: formatExact(bucket.total),
      label: bucketLabel(bucket.key),
      axisLabel: axisLabel(bucket.key),
      heightPct: bucket.total / top * 100,
      segments: segments.map((seg) => ({ ...seg, heightPct: seg.tokens / segTotal * 100 })),
    };
  });
});

// x 轴文字抽稀：最多 MAX_X_LABELS 个，保留最后一列
const xLabelStep = computed(() => Math.max(1, Math.ceil(columns.value.length / MAX_X_LABELS)));
const showXLabel = (index) =>
  index === columns.value.length - 1 || index % xLabelStep.value === 0;

const legendRows = computed(() => {
  const rows = categoryRank.value
    .slice(0, MAX_SEGMENTS)
    .map((row, index) => ({ ...row, color: PALETTE[index % PALETTE.length] }));
  const rest = categoryRank.value.slice(MAX_SEGMENTS);
  if (rest.length) {
    rows.push({
      key: OTHER_KEY,
      label: t("usage.chartOther"),
      tokens: rest.reduce((sum, row) => sum + row.tokens, 0),
      color: OTHER_COLOR,
    });
  }
  return rows;
});

const legendTotal = computed(() =>
  legendRows.value.reduce((sum, row) => sum + row.tokens, 0)
);
const legendMax = computed(() => legendRows.value[0]?.tokens || 1);

const legendValue = (tokens) => formatExact(tokens);
const legendShare = (tokens) =>
  legendTotal.value > 0 ? `${Math.round((tokens / legendTotal.value) * 100)}%` : "0%";

// ==================== 悬浮提示 ====================
// 不用 TDesign Tooltip：它的参考元素是整列（全高），浮层会被顶到绘图区顶部，跟鼠标位置脱节。
// 这里按鼠标位置自己算：横向对准所在柱并夹在绘图区内，纵向贴指针，上下放不下时翻转。
const TIP_WIDTH = 230;
const TIP_PADDING_Y = 8;
const TIP_LINE_HEIGHT = 21.6;
const TIP_HEADER_HEIGHT = 30;

// 浮层高度按行数估（行数固定，误差小）：标题 + 每个分类一行
const tipHeightOf = (col) =>
  TIP_PADDING_Y * 2 + TIP_HEADER_HEIGHT + col.segments.length * TIP_LINE_HEIGHT;

const plotRef = ref(null);
const hover = ref(null); // { col, x, y }

const showTip = (col, event) => {
  if (!col.segments.length) {
    hover.value = null;
    return;
  }
  const plotRect = plotRef.value?.getBoundingClientRect();
  if (!plotRect) return;
  const colRect = event.currentTarget.getBoundingClientRect();
  const half = TIP_WIDTH / 2;
  const centerX = colRect.left - plotRect.left + colRect.width / 2;
  const tipHeight = tipHeightOf(col);
  // 纵向夹在绘图区内：优先放指针上方，上方不够就压到指针下方，仍超出则整体上移
  const pointerY = Math.min(Math.max(event.clientY - plotRect.top, 4), plotRect.height - 4);
  const placeBelow = pointerY - tipHeight - 10 < 0;
  const top = placeBelow
    ? Math.min(pointerY, Math.max(plotRect.height - tipHeight - 8, 4))
    : pointerY - tipHeight - 10;
  hover.value = {
    col,
    x: Math.min(Math.max(centerX, half + 4), plotRect.width - half - 4),
    y: top,
  };
};

const hideTip = () => {
  hover.value = null;
};
</script>

<template>
  <div v-if="!columns.length" class="token-chart-empty">
    <Empty :description="emptyDescription || t('usage.emptyDescription')" size="small" />
  </div>
  <div v-else class="token-chart">
    <div class="token-chart-canvas">
      <div ref="plotRef" class="token-chart-plot" @mouseleave="hideTip">
        <!-- 纵轴网格：底部对齐，标签浮在网格线左端 -->
        <div
          v-for="tick in yAxis.ticks"
          :key="tick.text + tick.pct"
          class="token-chart-gridline"
          :style="{ bottom: tick.pct + '%' }"
        >
          <span class="token-chart-gridlabel">{{ tick.text }}</span>
        </div>
        <div class="token-chart-columns">
          <div
            v-for="(col, index) in columns"
            :key="col.key + index"
            class="token-chart-col"
            @mouseenter="showTip(col, $event)"
          >
            <div class="token-chart-stack" :style="{ height: col.heightPct + '%' }">
              <div
                v-for="seg in col.segments"
                :key="seg.key"
                class="token-chart-seg"
                :style="{ height: seg.heightPct + '%', background: seg.color }"
              ></div>
            </div>
          </div>
        </div>

        <!-- 悬浮提示：跟随鼠标所在柱，纵向已算好位置（不做 translate） -->
        <div
          v-if="hover"
          class="token-chart-tip"
          :style="{
            left: hover.x + 'px',
            top: hover.y + 'px',
            width: TIP_WIDTH + 'px',
          }"
        >
          <div class="token-chart-tip-header">
            <span>{{ hover.col.label }}</span>
            <span>{{ hover.col.totalText }}</span>
          </div>
          <div
            v-for="seg in hover.col.segments"
            :key="seg.key"
            class="token-chart-tip-line"
          >
            <span class="token-chart-tip-dot" :style="{ background: seg.color }"></span>
            <span class="token-chart-tip-name">{{ seg.label }}</span>
            <span class="token-chart-tip-value">{{ formatExact(seg.tokens) }}</span>
          </div>
        </div>
      </div>

      <div class="token-chart-xaxis">
        <span
          v-for="(col, index) in columns"
          :key="col.key + index"
          class="token-chart-xlabel"
        >{{ showXLabel(index) ? col.axisLabel : "" }}</span>
      </div>
    </div>

    <div class="token-chart-legend">
      <div v-for="row in legendRows" :key="row.key" class="token-chart-legend-row">
        <span class="token-chart-legend-dot" :style="{ background: row.color }"></span>
        <div class="token-chart-legend-main">
          <div class="token-chart-legend-head">
            <span class="token-chart-legend-name" :title="row.label">{{ row.label }}</span>
            <span class="token-chart-legend-value">
              {{ legendValue(row.tokens) }}
              <span class="token-chart-legend-share">{{ legendShare(row.tokens) }}</span>
            </span>
          </div>
          <div class="token-chart-legend-track">
            <div
              class="token-chart-legend-fill"
              :style="{ width: (row.tokens / legendMax * 100) + '%', background: row.color }"
            ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.token-chart-empty {
  padding: 20px 0;
}

/* 左：柱状图（固定高度） 右：图例（可滚动） */
.token-chart {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(200px, 300px);
  gap: 20px;
  align-items: stretch;
}

@media (max-width: 860px) {
  .token-chart {
    grid-template-columns: 1fr;
  }
}

.token-chart-canvas {
  min-width: 0;
}

.token-chart-plot {
  position: relative;
  height: 280px;
  padding-left: 52px;
}

.token-chart-gridline {
  position: absolute;
  left: 52px;
  right: 0;
  border-top: 1px dashed var(--td-component-stroke);
}

.token-chart-gridlabel {
  position: absolute;
  left: -52px;
  top: -8px;
  width: 46px;
  text-align: right;
  font-size: 11px;
  line-height: 16px;
  color: var(--td-text-color-placeholder);
}

.token-chart-columns {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  height: 100%;
}

.token-chart-col {
  flex: 1 1 0;
  min-width: 3px;
  max-width: 72px;
  height: 100%;
  display: flex;
  align-items: flex-end;
  cursor: default;
}

.token-chart-stack {
  width: 100%;
  display: flex;
  flex-direction: column-reverse;
  min-height: 1px;
  border-radius: 3px 3px 0 0;
  overflow: hidden;
  transition: opacity 0.15s;
}

.token-chart-col:hover .token-chart-stack {
  opacity: 0.85;
}

.token-chart-seg {
  width: 100%;
  min-height: 1px;
  box-sizing: border-box;
}

/* 段间缝隙：用卡片底色分割（叠放视觉与参考图一致），不影响总高 */
.token-chart-seg:not(:last-child) {
  border-top: 1px solid var(--td-bg-color-container);
}

.token-chart-xaxis {
  display: flex;
  justify-content: center;
  gap: 2px;
  padding-left: 52px;
  margin-top: 6px;
}

.token-chart-xlabel {
  flex: 1 1 0;
  min-width: 0;
  max-width: 72px;
  font-size: 11px;
  text-align: center;
  color: var(--td-text-color-placeholder);
  white-space: nowrap;
  overflow: visible;
}

.token-chart-legend {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 280px;
  overflow-y: auto;
  padding-right: 4px;
}

.token-chart-legend-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.token-chart-legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-top: 5px;
  flex-shrink: 0;
}

.token-chart-legend-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.token-chart-legend-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.token-chart-legend-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--td-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.token-chart-legend-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--td-text-color-primary);
  white-space: nowrap;
}

.token-chart-legend-share {
  margin-left: 4px;
  font-size: 11px;
  font-weight: 400;
  color: var(--td-text-color-placeholder);
}

.token-chart-legend-track {
  height: 6px;
  border-radius: 3px;
  background: var(--td-bg-color-component);
  overflow: hidden;
}

.token-chart-legend-fill {
  height: 100%;
  border-radius: 3px;
  min-width: 2px;
}

/* Tooltip：自绘浮层（深底浅字，与 TDesign tooltip 同观感），定位在柱顶上方 */
.token-chart-tip {
  position: absolute;
  z-index: 10;
  box-sizing: border-box;
  pointer-events: none;
  transform: translateX(-50%);
  padding: 8px 10px;
  border-radius: var(--td-radius-medium, 6px);
  color: #fff;
  background: var(--td-gray-color-13, #2c2c2c);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}

.token-chart-tip-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 12px;
  font-weight: 600;
}

.token-chart-tip-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.8;
}

.token-chart-tip-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.token-chart-tip-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.token-chart-tip-value {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
</style>
