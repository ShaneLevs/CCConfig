<script setup>

import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Empty, Button, Tag, Tooltip, Dialog, Popconfirm, Space, MessagePlugin } from "tdesign-vue-next";
import { RefreshIcon, FolderOpen1Icon, DownloadIcon, DeleteIcon } from "tdesign-icons-vue-next";
import SkillInstallDialog from "../../components/SkillInstallDialog.vue";
import SkillCard from "../../components/SkillCard.vue";
import "./styles/SkillView.css";

const { t } = useI18n();

const skills = ref([]);
const loading = ref(false);
const showDetailDialog = ref(false);
const selectedSkill = ref(null);

const parseFrontmatter = (yamlStr) => {
  if (!yamlStr) return {};
  const result = {};
  const lines = yamlStr.split('\n');
  let currentKey = null;
  let currentValue = [];
  let isMultiline = false;
  let multilineType = null;
  for (const line of lines) {
    const keyMatch = line.match(/^(\w+):\s*(.*)$/);
    if (keyMatch && !isMultiline) {
      if (currentKey) result[currentKey] = currentValue.join('\n').trim();
      currentKey = keyMatch[1];
      const valuePart = keyMatch[2];
      if (valuePart === '>' || valuePart === '|') {
        isMultiline = true; multilineType = valuePart; currentValue = [];
      } else if (valuePart.startsWith('>') || valuePart.startsWith('|')) {
        isMultiline = true; multilineType = valuePart[0]; currentValue = [valuePart.slice(1).trim()];
      } else {
        currentValue = [valuePart];
      }
    } else if (isMultiline && currentKey) {
      if (line.match(/^\w+:\s/) && !line.startsWith(' ') && !line.startsWith('\t')) {
        result[currentKey] = multilineType === '>' ? currentValue.join(' ').trim() : currentValue.join('\n').trim();
        const newKeyMatch = line.match(/^(\w+):\s*(.*)$/);
        currentKey = newKeyMatch[1];
        const newValuePart = newKeyMatch[2];
        if (newValuePart === '>' || newValuePart === '|') {
          isMultiline = true; multilineType = newValuePart[0]; currentValue = newValuePart.length > 1 ? [newValuePart.slice(1).trim()] : [];
        } else if (newValuePart.startsWith('>') || newValuePart.startsWith('|')) {
          isMultiline = true; multilineType = newValuePart[0]; currentValue = [newValuePart.slice(1).trim()];
        } else {
          isMultiline = false; currentValue = [newValuePart];
        }
      } else {
        currentValue.push(line.trim());
      }
    }
  }
  if (currentKey) {
    if (isMultiline && multilineType === '>') result[currentKey] = currentValue.join(' ').trim();
    else result[currentKey] = currentValue.join('\n').trim();
  }
  return result;
};

const loadSkills = () => {
  loading.value = true;
  try {
    skills.value = window.services.getOpencodeSkills();
  } catch (e) {
    console.error("加载 OpenCode skills 失败:", e);
    skills.value = [];
  }
  setTimeout(() => { loading.value = false; }, 50);
};

// 通用安装弹窗（SkillHub / 魔搭社区）
const installDialogRef = ref(null);
const SKILL_INSTALL_CONFIG = {
  getSkillsPath: 'getOpencodeSkillsPath',
  installSkill: 'installOpencodeSkill',
  installSkillFromModelScope: 'installOpencodeSkillFromModelScope',
  completeSkillInstall: 'completeOpencodeSkillInstall',
  cancelSkillInstall: 'cancelOpencodeSkillInstall',
};
const openInstallWithUrl = (url) => {
  installDialogRef.value?.open(url);
};

defineExpose({ openInstallWithUrl });

const openDir = () => {
  try {
    window.services.openOpencodeSkillsDir();
  } catch (e) {
    MessagePlugin.error(t('opencode.skill.cannotOpenDir'));
  }
};

const openDetail = (skill) => {
  selectedSkill.value = skill;
  showDetailDialog.value = true;
};

const openSkillDir = (skill) => {
  try {
    window.utools.shellOpenPath(skill.path);
  } catch {
    MessagePlugin.error(t("opencode.skill.cannotOpenFolder"));
  }
};

const deleteSkill = (skill) => {
  const result = window.services.deleteOpencodeSkill(skill.name);
  if (result.success) {
    MessagePlugin.success(t("opencode.skill.deleted", { name: skill.name }));
    loadSkills();
  } else {
    MessagePlugin.error(result.error || t("opencode.skill.deleteFailed"));
  }
};

onMounted(loadSkills);


</script>

<template>
  <div class="skill-container">
    <div class="section-header">
      <span class="skill-tip">{{ t("opencode.skill.tipPrefix") }}<span class="hint-link" @click="openDir">~/.config/opencode/skills</span>{{ t("opencode.skill.tipSuffix") }}</span>
      <Space size="small">
        <Button size="small" theme="primary" @click="installDialogRef?.open()">
          <template #icon><DownloadIcon /></template> {{ t("skill.install.install") }}
        </Button>

        <Tooltip :content="t('common.refresh')" placement="top">

          <Button size="small" variant="outline" :loading="loading" @click="loadSkills">
          <template #icon><RefreshIcon /></template>
        </Button>

        </Tooltip>
      </Space>
    </div>

    <div v-if="skills.length === 0" class="empty-state">
      <Empty :description="t('opencode.skill.empty')">
        <template #action>
          <Button size="small" theme="primary" @click="openDir">
            <template #icon><FolderOpen1Icon /></template> {{ t("opencode.skill.createOpenDir") }}
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else class="skill-list">
      <SkillCard
        v-for="skill in skills"
        :key="skill.name"
        :name="skill.name"
        @detail="openDetail(skill)"
      >
        <template #actions>
          <Space size="small">
            <Tooltip :content="t('opencode.skill.openFolder')" placement="top">
              <Button size="small" theme="default" variant="text" @click.stop="openSkillDir(skill)"><FolderOpen1Icon /></Button>
            </Tooltip>
            <Popconfirm theme="danger" :content="t('opencode.skill.deleteConfirm')" @confirm="deleteSkill(skill)">
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </template>
        <template #description>{{ parseFrontmatter(skill.frontmatter).description || t('skill.noDescription') }}</template>
        <template #meta>
          <Tag size="small" variant="light" theme="primary">{{ t("opencode.skill.fileCount", { count: skill.fileCount }) }}</Tag>
        </template>
      </SkillCard>
    </div>

    <!-- 详情弹窗 -->
    <Dialog v-model:visible="showDetailDialog" width="600px" :footer="false">
      <template #header>
        <div class="detail-dialog-header">
          <span>{{ selectedSkill?.name || t('opencode.skill.detailTitle') }}</span>
          <Tooltip :content="t('opencode.skill.openFolder')" placement="top">
            <Button size="small" variant="outline" @click="openSkillDir(selectedSkill)">
              <template #icon><FolderOpen1Icon style="font-size: 14px" /></template> {{ t("opencode.skill.folder") }}
            </Button>
          </Tooltip>
        </div>
      </template>
      <div v-if="selectedSkill" class="skill-detail">
        <div class="detail-info-grid">
          <div class="detail-info-item"><span class="detail-info-label">{{ t("opencode.skill.name") }}</span><span class="detail-info-value">{{ selectedSkill.name }}</span></div>
          <div class="detail-info-item"><span class="detail-info-label">{{ t("opencode.skill.fileCountLabel") }}</span><span class="detail-info-value">{{ selectedSkill.fileCount }}</span></div>
          <div class="detail-info-item"><span class="detail-info-label">{{ t("opencode.skill.path") }}</span><span class="detail-info-value mono" style="font-size:12px;word-break:break-all;">{{ selectedSkill.path }}</span></div>
        </div>
        <div v-if="parseFrontmatter(selectedSkill.frontmatter).description" class="detail-section">
          <div class="detail-section-title">{{ t("opencode.skill.description") }}</div>
          <div class="detail-desc">{{ parseFrontmatter(selectedSkill.frontmatter).description }}</div>
        </div>
      </div>
    </Dialog>

    <!-- 通用安装弹窗（SkillHub / 魔搭社区） -->
    <SkillInstallDialog
      ref="installDialogRef"
      :service-config="SKILL_INSTALL_CONFIG"
      manual-dir-label="~/.config/opencode/skills"
      @installed="loadSkills"
    />
  </div>
</template>
