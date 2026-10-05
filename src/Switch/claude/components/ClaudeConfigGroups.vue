<script setup>
import { Button, Space, Tag, Tooltip, Popconfirm } from "tdesign-vue-next";
import { EditIcon, PlayIcon, DeleteIcon } from "tdesign-icons-vue-next";

// claude 配置分组卡片（左右两列 masonry 中的一列）：分组头（Key/URL + 批量编辑）
// 与配置行（当前标记 / 启用 / 编辑 / 删除）。左右结构完全一致，仅数据与拖拽侧向不同。
const props = defineProps({
  groups: { type: Array, default: () => [] },
  // 'left' | 'right'，用于拖拽方向与 key 前缀
  side: { type: String, required: true },
  dragState: { type: Object, required: true },
  isCurrent: { type: Function, required: true },
});
const emit = defineEmits(["drag-mousedown", "batch-edit", "preview", "switch", "edit", "del"]);

const maskKey = (key) => {
  if (!key || key.length < 8) return key || "";
  return key.substring(0, 6) + "***" + key.substring(key.length - 4);
};

const keyPrefix = () => (props.side === "right" ? "r-" : "l-");
</script>

<template>
  <div class="masonry-col">
    <template v-for="(group, idx) in groups" :key="group.isPlaceholder ? 'placeholder' : keyPrefix() + idx + '-' + group.key">
      <div v-if="group.isPlaceholder" class="config-group drag-gap-parent">
        <div class="drag-gap" :style="{ height: dragState.dragHeight + 'px' }"></div>
      </div>
      <div v-else class="config-group">
        <div class="group-conn" @mousedown="emit('drag-mousedown', idx, $event)">
          <div class="group-conn-info">
            <span class="group-key">{{ maskKey(group.key) }}</span>
            <span class="group-url">{{ group.baseUrl }}</span>
          </div>
          <div class="group-conn-actions" @click.stop @mousedown.stop>
            <Tooltip content="批量编辑 URL 和 Key" placement="top">
              <Button size="small" theme="default" variant="text" @click="emit('batch-edit', group)"><EditIcon /></Button>
            </Tooltip>
          </div>
        </div>
        <div v-for="config in group.configs" :key="config.id + '-' + (isCurrent(config) ? 'cur' : 'other')" class="config-row" @click="emit('preview', config)">
          <span class="config-name">{{ config.name }}</span>
          <Space size="small" @click.stop>
            <Tag v-if="isCurrent(config)" theme="success" variant="light" size="small">当前</Tag>
            <Button v-else size="small" theme="success" variant="text" @click="emit('switch', config)"><template #icon><PlayIcon /></template>启用</Button>
            <Tooltip content="编辑" placement="top">
              <Button size="small" theme="default" variant="text" @click="emit('edit', config)"><EditIcon /></Button>
            </Tooltip>
            <Tooltip content="删除" placement="top">
              <Popconfirm theme="danger" content="确定要删除这个配置吗？" @confirm="emit('del', config)">
                <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
              </Popconfirm>
            </Tooltip>
          </Space>
        </div>
      </div>
    </template>
  </div>
</template>
