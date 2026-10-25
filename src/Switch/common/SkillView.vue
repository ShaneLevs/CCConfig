<script setup>

import { ref, onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Dialog, Button, MessagePlugin, Switch, Popconfirm, Space, Tag, Tooltip,
} from "tdesign-vue-next";
import { DownloadIcon, DeleteIcon, RefreshIcon, FolderOpen1Icon } from "tdesign-icons-vue-next";
import SkillInstallDialog from "../../components/SkillInstallDialog.vue";
import SkillCard from "../../components/SkillCard.vue";
import "./styles/SkillView.css";

const { t } = useI18n();

// 通用 Skill：读取 ~/.agents/skills 目录下的 Skill（SKILL.md 元数据），
// 支持从 SkillHub / 魔搭社区 通过链接安装（功能同 Claude Code，仅安装目录不同）。
// 启停：写入 ~/.pi/agent/settings.json 的 skills 数组（-skills/<name>/SKILL.md 强制排除），
// 控制 Pi Agent 是否加载该 Skill（与 `pi config` 交互一致）。

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
          isMultiline = true; multilineType = newValuePart; currentValue = [];
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

const skills = ref([]);
const loading = ref(false);
const showDetailDialog = ref(false);
const selectedSkill = ref(null);

const loadSkills = () => {
  loading.value = true;
  try {
    skills.value = window.services.readCommonSkills();
  } catch (e) {
    console.error("加载通用 Skill 失败:", e);
    skills.value = [];
  }
  setTimeout(() => { loading.value = false; }, 50);
};

// 通用安装弹窗（SkillHub / 魔搭社区）
const installDialogRef = ref(null);
const SKILL_INSTALL_CONFIG = {
  getSkillsPath: 'getCommonSkillsPath',
  installSkill: 'installCommonSkill',
  installSkillFromModelScope: 'installCommonSkillFromModelScope',
  completeSkillInstall: 'completeCommonSkillInstall',
  cancelSkillInstall: 'cancelCommonSkillInstall',
};
const openInstallWithUrl = (url) => {
  installDialogRef.value?.open(url);
};

defineExpose({ openInstallWithUrl });

const openDetail = (skill) => {
  selectedSkill.value = skill;
  showDetailDialog.value = true;
};

const toggleSkill = (skill, enabled) => {
  const result = window.services.setCommonSkillEnabled(skill.dirName, enabled);
  if (result.success) {
    MessagePlugin.success(enabled ? t('commonApp.skill.enabledToast', { name: skill.name }) : t('commonApp.skill.disabledToast', { name: skill.name }));
    skill.enabled = enabled;
  } else {
    MessagePlugin.error(result.error || (enabled ? t('commonApp.skill.enableFailed') : t('commonApp.skill.disableFailed')));
  }
};

const deleteSkill = (skill) => {
  const result = window.services.deleteCommonSkill(skill.dirName);
  if (result.success) {
    MessagePlugin.success(t('commonApp.skill.deletedToast', { name: skill.name }));
    loadSkills();
  } else {
    MessagePlugin.error(result.error || t('common.deleteFailed'));
  }
};

const openSkillDir = (skill) => {
  try {
    window.utools.shellOpenPath(skill.dir);
  } catch {
    MessagePlugin.error(t('commonApp.skill.openFolderFailed'));
  }
};

const openCommonSkillsDir = () => {
  try {
    window.services.openCommonSkillsDir();
  } catch {
    MessagePlugin.error(t('commonApp.skill.openDirFailed'));
  }
};

const enabledSkills = computed(() => skills.value.filter(s => s.enabled));
const disabledSkills = computed(() => skills.value.filter(s => !s.enabled));

onMounted(loadSkills);
</script>

<template>
  <div class="skill-container">
    <div class="section-header">
      <span class="skill-tip">{{ t('commonApp.skill.tipPrefix') }}<span class="hint-link" @click="openCommonSkillsDir">~/.agents/skills</span>{{ t('commonApp.skill.tipSuffix') }}</span>
      <Space size="small">
        <Button size="small" theme="primary" @click="installDialogRef?.open()">
          <template #icon><DownloadIcon /></template> {{ t('skill.install.title') }}
        </Button>

        <Tooltip :content="t('common.refresh')" placement="top">

          <Button size="small" variant="outline" :loading="loading" @click="loadSkills">
          <template #icon><RefreshIcon /></template>
        </Button>

        </Tooltip>
      </Space>
    </div>

    <div v-if="!skills.length" class="empty-state">
      <Empty :description="t('commonApp.skill.empty', { path: '~/.agents/skills' })">
        <template #action>
          <Button size="small" theme="primary" @click="openCommonSkillsDir">
            <template #icon><FolderOpen1Icon /></template> {{ t('commonApp.skill.createAndOpen') }}
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else class="skill-list">
      <!-- 已启用 -->
      <SkillCard
        v-for="skill in enabledSkills"
        :key="skill.dirName"
        :name="skill.name"
        @detail="openDetail(skill)"
      >
        <template #header-extra>
          <Tag size="small" variant="light" theme="success">{{ t('common.enabled') }}</Tag>
        </template>
        <template #actions>
          <Space size="small">
            <Switch :value="true" @change="(val) => toggleSkill(skill, val)" />
            <Tooltip :content="t('commonApp.skill.openFolder')" placement="top">
              <Button size="small" theme="default" variant="text" @click.stop="openSkillDir(skill)"><FolderOpen1Icon /></Button>
            </Tooltip>
            <Popconfirm theme="danger" :content="t('commonApp.skill.deleteConfirm')" @confirm="deleteSkill(skill)">
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </template>
        <template #description>{{ parseFrontmatter(skill.frontmatter).description || t('skill.noDescription') }}</template>
        <template #meta>
          <Tag size="small" variant="light" theme="primary">{{ t('commonApp.skill.fileCount', { count: skill.fileCount }) }}</Tag>
          <span class="skill-dir-name">~/.agents/skills/{{ skill.dirName }}</span>
        </template>
      </SkillCard>

      <!-- 已禁用分组 -->      <template v-if="disabledSkills.length > 0">
        <div class="skill-section-divider">
          <span class="skill-section-label">{{ t('commonApp.skill.disabledGroup', { count: disabledSkills.length }) }}</span>
        </div>
        <SkillCard
          v-for="skill in disabledSkills"
          :key="skill.dirName + '-disabled'"
          :name="skill.name"
          disabled
          @detail="openDetail(skill)"
        >
          <template #header-extra>
            <Tag size="small" variant="light" theme="default">{{ t('common.disabled') }}</Tag>
          </template>
          <template #actions>
            <Space size="small">
              <Switch :value="false" @change="(val) => toggleSkill(skill, val)" />
              <Tooltip :content="t('commonApp.skill.openFolder')" placement="top">
                <Button size="small" theme="default" variant="text" @click.stop="openSkillDir(skill)"><FolderOpen1Icon /></Button>
              </Tooltip>
              <Popconfirm theme="danger" :content="t('commonApp.skill.deleteConfirm')" @confirm="deleteSkill(skill)">
                <Tooltip :content="t('common.delete')" placement="top">
                  <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
                </Tooltip>
              </Popconfirm>
            </Space>
          </template>
          <template #description>{{ parseFrontmatter(skill.frontmatter).description || t('skill.noDescription') }}</template>
          <template #meta>
            <Tag size="small" variant="light" theme="primary">{{ t('commonApp.skill.fileCount', { count: skill.fileCount }) }}</Tag>
            <span class="skill-dir-name">~/.agents/skills/.disabled/{{ skill.dirName }}</span>
          </template>
        </SkillCard>
      </template>
    </div>

    <!-- 详情弹窗 -->
    <Dialog v-model:visible="showDetailDialog" width="600px" :footer="false">
      <template #header>
        <div class="detail-dialog-header">
          <span>{{ selectedSkill?.name || t('commonApp.skill.detailTitle') }}</span>
          <Tooltip :content="t('commonApp.skill.openFolder')" placement="top">
            <Button size="small" variant="outline" @click="openSkillDir(selectedSkill)">
              <template #icon><FolderOpen1Icon style="font-size: 14px" /></template> {{ t('commonApp.skill.folder') }}
            </Button>
          </Tooltip>
        </div>
      </template>
      <div v-if="selectedSkill" class="skill-detail">
        <div class="detail-info-grid">
          <div class="detail-info-item"><span class="detail-info-label">{{ t('common.name') }}</span><span class="detail-info-value">{{ selectedSkill.name }}</span></div>
          <div class="detail-info-item"><span class="detail-info-label">{{ t('commonApp.skill.status') }}</span><Tag size="small" :theme="selectedSkill.enabled ? 'success' : 'default'" variant="light">{{ selectedSkill.enabled ? t('common.enabled') : t('common.disabled') }}</Tag></div>
          <div class="detail-info-item"><span class="detail-info-label">{{ t('commonApp.skill.dirName') }}</span><span class="detail-info-value">{{ selectedSkill.dirName }}</span></div>
          <div class="detail-info-item"><span class="detail-info-label">{{ t('commonApp.skill.fileCountLabel') }}</span><span class="detail-info-value">{{ selectedSkill.fileCount }}</span></div>
          <div class="detail-info-item detail-info-item--full"><span class="detail-info-label">{{ t('commonApp.skill.path') }}</span><span class="detail-info-value mono" style="font-size:12px;word-break:break-all;">{{ selectedSkill.dir }}</span></div>
        </div>
        <div v-if="parseFrontmatter(selectedSkill.frontmatter).description" class="detail-section">
          <div class="detail-section-title">{{ t('commonApp.skill.description') }}</div>
          <div class="detail-desc">{{ parseFrontmatter(selectedSkill.frontmatter).description }}</div>
        </div>
        <div v-if="parseFrontmatter(selectedSkill.frontmatter).instructions" class="detail-section">
          <div class="detail-section-title">{{ t('commonApp.skill.instructions') }}</div>
          <div class="detail-desc">{{ parseFrontmatter(selectedSkill.frontmatter).instructions }}</div>
        </div>
      </div>
    </Dialog>

    <!-- 通用安装弹窗（SkillHub / 魔搭社区） -->
    <SkillInstallDialog
      ref="installDialogRef"
      :service-config="SKILL_INSTALL_CONFIG"
      manual-dir-label="~/.agents/skills"
      @installed="loadSkills"
    />
  </div>
</template>
