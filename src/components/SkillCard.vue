<script setup>
import { useI18n } from "vue-i18n";
import { Card, Tooltip, MessagePlugin } from "tdesign-vue-next";

// 通用 Skill 展示卡片（Claude / OpenCode / 通用 三视图共用）
// 骨架：名称（点击复制）+ header-extra 插槽 + actions 插槽 + 描述区 + meta 插槽
// 用法：
//   <SkillCard :name="skill.name" :disabled="skill.disabled" @detail="openDetail(skill)">
//     <template #header-extra>...项目 Tag / 状态 Tag...</template>
//     <template #actions>...Switch / 删除按钮...</template>
//     <template #description>{{ desc }}</template>
//     <template #meta>...使用统计...</template>
//   </SkillCard>

const props = defineProps({
  name: { type: String, required: true },
  disabled: { type: Boolean, default: false },
  clickable: { type: Boolean, default: true },
});

const emit = defineEmits(["detail"]);
const { t } = useI18n();

const copyName = () => {
  try {
    window.utools.copyText(props.name);
    MessagePlugin.success(t("mcp.nameCopied"));
  } catch {
    MessagePlugin.error(t("common.copyFailed"));
  }
};
</script>

<template>
  <Card
    :bordered="true"
    hover
    class="skill-card"
    :class="{ 'skill-card--disabled': disabled }"
  >
    <template #header>
      <div class="skill-card-header">
        <div class="skill-card-left">
          <Tooltip :content="t('mcp.copyName')" placement="top">
            <span class="skill-card-name" @click.stop="copyName">{{ name }}</span>
          </Tooltip>
          <slot name="header-extra" />
        </div>
        <div class="skill-card-actions">
          <slot name="actions" />
        </div>
      </div>
    </template>
    <div
      class="skill-card-description"
      :class="{ 'skill-card-description--clickable': clickable }"
      @click="emit('detail')"
    >
      <slot name="description" />
    </div>
    <div class="skill-card-meta">
      <slot name="meta" />
    </div>
  </Card>
</template>

<style scoped>
.skill-card {
  transition: opacity 0.2s;
}

.skill-card:hover {
  box-shadow: var(--td-shadow-1);
}

.skill-card--disabled {
  opacity: 0.6;
}

.skill-card :deep(.t-card__header) {
  padding: 10px 16px 6px;
  border-bottom: none;
}

.skill-card :deep(.t-card__body) {
  padding: 0 16px 10px;
}

.skill-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.skill-card-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.skill-card-name {
  color: var(--td-brand-color);
  cursor: pointer;
  font-size: 16px;
  font-weight: 500;
  word-break: break-all;
}

.skill-card-name:hover {
  text-decoration: underline;
}

.skill-card-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.skill-card-description {
  font-size: 13px;
  color: var(--td-text-color-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-all;
}

.skill-card-description--clickable {
  cursor: pointer;
}

.skill-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--td-text-color-placeholder);
}
</style>
