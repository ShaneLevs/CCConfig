import { ref, computed, watch } from "vue";
import { MessagePlugin } from "tdesign-vue-next";
import { t } from "../i18n";

const GROUP_ORDER_ID = "ccconfig_group_order";

export function useConfigColumns(savedConfigs) {
  const groupOrder = ref([]);
  const columnAssignments = ref({});
  const leftColumn = ref([]);
  const rightColumn = ref([]);
  const dragState = ref({ active: false, floatEl: null, offsetX: 0, offsetY: 0, dragGroup: null, placeholderCol: null, placeholderIdx: null, dragHeight: 0 });

  const groupedConfigs = computed(() => {
    const groups = new Map();
    savedConfigs.value.forEach(config => {
      const groupKey = `${config.key}|${config.baseUrl}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          key: config.key,
          baseUrl: config.baseUrl,
          configs: [],
        });
      }
      groups.get(groupKey).configs.push(config);
    });

    const result = Array.from(groups.values()).map(group => {
      group.configs.sort((a, b) => a.createdAt - b.createdAt);
      return group;
    });

    const order = groupOrder.value;
    if (order.length) {
      const orderMap = new Map(order.map((k, i) => [k, i]));
      result.sort((a, b) => {
        const keyA = `${a.key}|${a.baseUrl}`;
        const keyB = `${b.key}|${b.baseUrl}`;
        const oA = orderMap.has(keyA) ? orderMap.get(keyA) : Infinity;
        const oB = orderMap.has(keyB) ? orderMap.get(keyB) : Infinity;
        if (oA !== oB) return oA - oB;
        return a.configs[0]?.createdAt - b.configs[0]?.createdAt;
      });
    } else {
      result.sort((a, b) => a.configs[0]?.createdAt - b.configs[0]?.createdAt);
    }
    return result;
  });

  const loadGroupOrder = () => {
    const doc = window.utools.db.get(GROUP_ORDER_ID);
    groupOrder.value = doc?.order || [];
    columnAssignments.value = doc?.columns || {};
  };

  const estimateGroupHeight = (group) => {
    if (!group || group.isPlaceholder) return 0;
    return 52 + (group.configs?.length || 0) * 41;
  };

  const splitToColumns = (groups) => {
    const left = [], right = [];
    groups.forEach((group, i) => {
      const key = `${group.key}|${group.baseUrl}`;
      const col = columnAssignments.value[key];
      if (col === 'right') right.push(group);
      else if (col === 'left') left.push(group);
      else if (i % 2 === 0) left.push(group);
      else right.push(group);
    });
    return { left, right };
  };

  const saveColumns = () => {
    const columns = {};
    leftColumn.value.forEach(g => {
      if (!g.isPlaceholder) columns[`${g.key}|${g.baseUrl}`] = 'left';
    });
    rightColumn.value.forEach(g => {
      if (!g.isPlaceholder) columns[`${g.key}|${g.baseUrl}`] = 'right';
    });
    const flatOrder = [];
    const maxLen = Math.max(leftColumn.value.length, rightColumn.value.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < leftColumn.value.length) flatOrder.push(leftColumn.value[i]);
      if (i < rightColumn.value.length) flatOrder.push(rightColumn.value[i]);
    }
    const doc = { _id: GROUP_ORDER_ID, order: flatOrder.filter(g => !g.isPlaceholder).map(g => `${g.key}|${g.baseUrl}`), columns };
    const existing = window.utools.db.get(GROUP_ORDER_ID);
    if (existing) doc._rev = existing._rev;
    window.utools.db.put(doc);
    groupOrder.value = doc.order;
    columnAssignments.value = columns;
  };

  const rebalanceColumns = () => {
    const calcH = (col) => col.reduce((sum, g) => sum + estimateGroupHeight(g) + 12, 0) - (col.length ? 12 : 0);
    const leftH = calcH(leftColumn.value);
    const rightH = calcH(rightColumn.value);

    if (Math.abs(leftH - rightH) < 40) {
      MessagePlugin.info(t('common.reorganized'));
      return;
    }

    const taller = leftH > rightH ? leftColumn : rightColumn;
    const shorter = leftH > rightH ? rightColumn : leftColumn;
    let tH = Math.max(leftH, rightH);
    let sH = Math.min(leftH, rightH);
    let moved = 0;

    while (taller.value.length > 1 && Math.abs(tH - sH) > 30) {
      const item = taller.value[taller.value.length - 1];
      const itemH = estimateGroupHeight(item) + 12;
      const newTH = tH - itemH;
      const newSH = sH + itemH;
      if (Math.abs(newTH - newSH) >= Math.abs(tH - sH)) break;
      taller.value.pop();
      shorter.value.push(item);
      tH = newTH;
      sH = newSH;
      moved++;
    }

    if (!moved) return;
    saveColumns();
    MessagePlugin.info(t('common.reorganized'));
  };

  const getColRef = (col) => col === 'left' ? leftColumn : rightColumn;

  const onDragMouseDown = (col, idx, e) => {
    if (e.button !== 0) return;
    const groupEl = e.target.closest('.config-group');
    if (!groupEl) return;

    const column = getColRef(col);
    const group = column.value[idx];
    if (!group || group.isPlaceholder) return;

    const rect = groupEl.getBoundingClientRect();
    dragState.value = {
      active: false,
      floatEl: null,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      dragGroup: group,
      placeholderCol: null,
      placeholderIdx: null,
      dragHeight: rect.height,
    };

    const onMouseMove = (ev) => {
      if (!dragState.value.active) {
        if (Math.abs(ev.clientX - dragState.value.startX) < 4 && Math.abs(ev.clientY - dragState.value.startY) < 4) return;
        dragState.value.active = true;

        column.value.splice(idx, 1, { isPlaceholder: true, _id: '__placeholder__' });
        dragState.value.placeholderCol = col;
        dragState.value.placeholderIdx = idx;

        const clone = groupEl.cloneNode(true);
        clone.style.width = rect.width + 'px';
        clone.style.position = 'fixed';
        clone.style.zIndex = '9999';
        clone.style.pointerEvents = 'none';
        clone.style.opacity = '1';
        clone.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
        clone.style.transform = 'scale(1.02)';
        clone.style.background = 'var(--td-bg-color-container)';
        clone.style.borderRadius = 'var(--td-radius-medium)';
        clone.style.border = '1px solid var(--td-component-border)';
        clone.style.overflow = 'hidden';
        document.body.appendChild(clone);
        dragState.value.floatEl = clone;
      }

      if (dragState.value.floatEl) {
        dragState.value.floatEl.style.left = (ev.clientX - dragState.value.offsetX) + 'px';
        dragState.value.floatEl.style.top = (ev.clientY - dragState.value.offsetY) + 'px';
      }

      const containerEl = document.querySelector('.config-groups');
      if (!containerEl) return;
      const containerRect = containerEl.getBoundingClientRect();
      const midX = containerRect.left + containerRect.width / 2;
      const targetColName = ev.clientX < midX ? 'left' : 'right';
      const targetCol = getColRef(targetColName);

      const childIdx = targetColName === 'left' ? 1 : 2;
      const colEls = document.querySelectorAll(`.masonry-col:nth-child(${childIdx}) .config-group:not(.drag-gap-parent)`);
      let targetIdx = colEls.length;
      for (let i = 0; i < colEls.length; i++) {
        const r = colEls[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          targetIdx = i;
          break;
        }
      }

      if (targetColName === dragState.value.placeholderCol && targetIdx === dragState.value.placeholderIdx) return;

      const currentCol = getColRef(dragState.value.placeholderCol);
      currentCol.value.splice(dragState.value.placeholderIdx, 1);

      if (targetColName === dragState.value.placeholderCol && targetIdx > dragState.value.placeholderIdx) {
        targetIdx--;
      }

      targetCol.value.splice(targetIdx, 0, { isPlaceholder: true, _id: '__placeholder__' });
      dragState.value.placeholderCol = targetColName;
      dragState.value.placeholderIdx = targetIdx;
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (dragState.value.floatEl) {
        dragState.value.floatEl.remove();
      }

      if (dragState.value.placeholderCol) {
        const col = getColRef(dragState.value.placeholderCol);
        col.value.splice(dragState.value.placeholderIdx, 1, dragState.value.dragGroup);
      }

      saveColumns();
      dragState.value = { active: false, floatEl: null, offsetX: 0, offsetY: 0, dragGroup: null, placeholderCol: null, placeholderIdx: null, dragHeight: 0 };
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  watch(groupedConfigs, (groups) => {
    if (!dragState.value.active) {
      const { left, right } = splitToColumns(groups);
      leftColumn.value = left;
      rightColumn.value = right;
    }
  }, { immediate: true });

  return {
    groupedConfigs,
    leftColumn,
    rightColumn,
    dragState,
    groupOrder,
    loadGroupOrder,
    rebalanceColumns,
    onDragMouseDown,
  };
}
