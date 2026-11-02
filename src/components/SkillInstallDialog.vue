<script setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, Input, Button, Tag, Loading } from "tdesign-vue-next";
import { useSkillInstall } from "../composables/useSkillInstall";

// 通用 Skill 安装弹窗（SkillHub / 魔搭社区）
// 用法：
//   <SkillInstallDialog
//     ref="d"
//     :service-config="{ getSkillsPath, installSkill, ... }"   // useSkillInstall 的 cfg
//     manual-dir-label="~/.claude/skills"                       // 手动安装目录文案
//     @installed="loadSkills"                                    // 安装/覆盖成功后刷新列表
//   />
//   父组件通过 ref 调用：
//     d.open()        打开空白安装弹窗（点「安装 Skill」按钮）
//     d.open(url)     带 URL 打开（URL 关键词触发）
//     d.openDir()     打开手动安装目录

const props = defineProps({
  serviceConfig: { type: Object, default: () => ({}) },
  manualDirLabel: { type: String, default: "~/.claude/skills" },
});

const emit = defineEmits(["installed"]);
const { t } = useI18n();

const {
  showInstallDialog, installUrl, isFetchingInfo, isInstalling,
  installInfo, installProgress, pendingInstall, showOverwriteDialog, supportsSkillsSh,
  openInstallDialog, openInstallWithUrl, openExternal, openSkillsDir,
  confirmInstall, overwriteInstall, cancelInstall,
} = useSkillInstall(() => emit("installed"), props.serviceConfig);

const sourceLabel = computed(() => {
  const source = installInfo.value?.source;
  if (source === "skillhub") return t("skill.install.sourceSkillHub");
  if (source === "modelscope") return t("skill.install.sourceModelScope");
  if (source === "skills-sh") return t("skill.install.sourceSkillsSh");
  return "";
});

const sourceTagTheme = computed(() =>
  installInfo.value?.source === "modelscope" ? "warning" : "primary",
);

const fromRegistry = computed(() =>
  ["skillhub", "modelscope"].includes(installInfo.value?.source),
);

const open = (url) => {
  if (url) openInstallWithUrl(url);
  else openInstallDialog();
};

const openDir = () => openSkillsDir();

defineExpose({ open, openInstallWithUrl, openDir });
</script>

<template>
  <Dialog
    v-model:visible="showInstallDialog"
    :header="t('skill.install.title')"
    width="500px"
    :confirm-btn="{ content: t('skill.install.install'), loading: isInstalling, theme: 'primary', disabled: !installInfo }"
    @confirm="confirmInstall"
  >
    <div class="install-form">
      <div class="skill-install-form-item"><label>{{ t('skill.install.link') }}</label><Input v-model="installUrl" :placeholder="supportsSkillsSh ? t('skill.install.linkPlaceholderSkillsSh') : t('skill.install.linkPlaceholder')" :disabled="isFetchingInfo || isInstalling" /></div>
      <div class="install-hint">{{ t('skill.install.hintSourcesPrefix') }} <span class="hint-link" @click="openExternal('https://skillhub.cn/skills')">SkillHub</span> {{ t('skill.install.hintSourcesMiddle') }} <span class="hint-link" @click="openExternal('https://www.modelscope.cn/skills')">{{ t('skill.install.sourceModelScope') }}</span> {{ t('skill.install.hintSourcesSuffix') }}</div>
      <div v-if="supportsSkillsSh" class="install-hint">{{ t('skill.install.hintSkillsSh') }}</div>
      <div class="install-hint">{{ t('skill.install.hintManualPrefix') }} <span class="hint-link" @click="openDir">{{ manualDirLabel }}</span> {{ t('skill.install.hintManualSuffix') }}</div>
      <div v-if="isFetchingInfo" class="install-loading"><Loading size="small" /></div>
      <div v-if="installInfo" class="install-info-card">
        <div class="install-info-header">
          <span class="install-info-name">{{ installInfo.displayName }}</span>
        </div>
        <div class="install-info-meta">
          <template v-if="fromRegistry">
            <span>{{ t('skill.install.author', { author: installInfo.author }) }}</span><span>{{ t('skill.install.downloads', { count: installInfo.downloads }) }}</span>
          </template>
          <Tag size="small" :theme="sourceTagTheme" variant="light" class="install-info-source">{{ sourceLabel }}</Tag>
          <span v-if="fromRegistry" class="install-info-version">v{{ installInfo.version }}</span>
        </div>
        <div v-if="installInfo.sourceLabel" class="install-info-source-label">{{ t('skill.install.installSource') }}: {{ installInfo.sourceLabel }}</div>
        <div v-if="installInfo.tags?.length || installInfo.requiresApiKey" class="install-info-tags">
          <Tag v-for="tag in installInfo.tags" :key="tag" size="small" variant="light" theme="default" class="install-info-tag">{{ tag }}</Tag>
          <Tag v-if="installInfo.requiresApiKey" size="small" variant="light" theme="warning" class="install-info-tag">{{ t('skill.requiresApiKey') }}</Tag>
        </div>
        <div v-if="installInfo.summary" class="install-info-summary">{{ installInfo.summary }}</div>
        <div v-if="installInfo.evaluation" class="install-eval">
          <span class="install-eval-label">{{ t('skill.install.trace') }}</span>
          <span class="install-eval-score">{{ installInfo.evaluation.total }}/5</span>
        </div>
        <div v-if="installInfo.installCommand" class="install-command">
          <span class="install-command-label">{{ t('skill.install.installCommand') }}</span>
          <code>{{ installInfo.installCommand }}</code>
        </div>
        <div v-if="installProgress > 0 && installProgress < 100" class="install-progress"><Loading size="small" /><span>{{ t('skill.install.downloading', { progress: installProgress }) }}</span></div>
      </div>
    </div>
  </Dialog>

  <Dialog
    v-model:visible="showOverwriteDialog"
    :header="t('skill.install.existsTitle')"
    width="400px"
    :confirm-btn="{ content: t('skill.install.overwrite'), theme: 'primary' }"
    :cancel-btn="{ content: t('common.cancel') }"
    @confirm="overwriteInstall"
    @close="cancelInstall"
  >
    <div class="overwrite-hint">{{ t('skill.install.existsHint', { name: pendingInstall?.skillName }) }}</div>
  </Dialog>
</template>

<style scoped>
.install-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.install-form .skill-install-form-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.install-form label {
  font-size: 14px;
  color: var(--td-text-color-primary);
}

.install-hint {
  font-size: 12px;
  color: var(--td-text-color-placeholder);
  margin-top: 4px;
}

.hint-link {
  color: var(--td-brand-color);
  cursor: pointer;
  text-decoration: underline;
}

.install-info-card {
  margin-top: 12px;
  padding: 12px;
  background: var(--td-bg-color-container-hover);
  border-radius: var(--td-radius-medium);
}

.install-info-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.install-info-name {
  font-size: 15px;
  font-weight: 500;
  color: var(--td-text-color-primary);
}

.install-info-version {
  font-size: 12px;
  line-height: 20px;
  padding: 0 6px;
  background: var(--td-brand-color);
  color: var(--td-font-white-1);
  border-radius: var(--td-radius-small);
}

.install-info-source {
  margin-left: auto;
}

.install-info-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--td-text-color-placeholder);
  margin-bottom: 8px;
}

.install-info-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.install-info-tag {
  margin: 0;
}

.install-info-summary {
  font-size: 13px;
  color: var(--td-text-color-secondary);
  line-height: 1.5;
}

.install-info-source-label {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--td-text-color-placeholder);
  word-break: break-all;
}

.install-command {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.install-command-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--td-text-color-secondary);
}

.install-command code {
  padding: 6px 8px;
  background: var(--td-bg-color-container);
  border-radius: var(--td-radius-default);
  font-size: 12px;
  line-height: 1.5;
  color: var(--td-text-color-primary);
  word-break: break-all;
}

.install-loading {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}

.install-eval {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--td-bg-color-component);
  border-radius: var(--td-radius-medium);
  border: 1px solid var(--td-component-stroke);
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}

.install-eval-label {
  color: var(--td-text-color-placeholder);
}

.install-eval-score {
  font-size: 16px;
  font-weight: 700;
  color: var(--td-text-color-primary);
}

.install-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 13px;
  color: var(--td-brand-color);
}

.overwrite-hint {
  font-size: 14px;
  color: var(--td-text-color-primary);
}
</style>
