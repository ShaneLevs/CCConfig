<script setup>
// Grok Build Skill 管理：~/.grok/skills（官方用户级 skill 目录）
// 启停沿用 .disabled 目录机制（物理移动目录，同 Claude / OpenCode / 通用 Skill 同一套心智）。
// 安装：复用通用安装弹窗（SkillHub / 魔搭社区），目标目录为 ~/.grok/skills。
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Empty, Button, Tag, Tooltip, Switch, Popconfirm, Space, MessagePlugin, Dialog } from "tdesign-vue-next";
import { DownloadIcon, DeleteIcon, FolderOpen1Icon, RefreshIcon } from "tdesign-icons-vue-next";
import SkillInstallDialog from "../../components/SkillInstallDialog.vue";
import SkillCard from "../../components/SkillCard.vue";
import { usePageRefresh } from "../../composables/usePageRefresh";
import "./styles/SkillView.css";

const { t } = useI18n();

const skills = ref([]);
const showDetailDialog = ref(false);
const selectedSkill = ref(null);

// frontmatter 轻量解析（与其它 Skill 视图一致：只取顶层 key: value，支持 > / | 折叠）
const parseFrontmatter = (yamlStr) => {
  if (!yamlStr) return {};
  const result = {};
  const lines = yamlStr.split("\n");
  let currentKey = null;
  let currentValue = [];
  let isMultiline = false;
  let multilineType = null;
  for (const line of lines) {
    const keyMatch = line.match(/^(\w+):\s*(.*)$/);
    if (keyMatch && !isMultiline) {
      if (currentKey) result[currentKey] = currentValue.join("\n").trim();
      currentKey = keyMatch[1];
      const valuePart = keyMatch[2];
      if (valuePart === ">" || valuePart === "|") {
        isMultiline = true; multilineType = valuePart; currentValue = [];
      } else if (valuePart.startsWith(">") || valuePart.startsWith("|")) {
        isMultiline = true; multilineType = valuePart[0]; currentValue = [valuePart.slice(1).trim()];
      } else {
        currentValue = [valuePart];
      }
    } else if (isMultiline && currentKey) {
      if (line.match(/^\w+:\s/) && !line.startsWith(" ") && !line.startsWith("\t")) {
        result[currentKey] = multilineType === ">" ? currentValue.join(" ").trim() : currentValue.join("\n").trim();
        const newKeyMatch = line.match(/^(\w+):\s*(.*)$/);
        currentKey = newKeyMatch[1];
        const newValuePart = newKeyMatch[2];
        isMultiline = false;
        currentValue = [newValuePart];
      } else {
        currentValue.push(line.trim());
      }
    }
  }
  if (currentKey) {
    result[currentKey] = isMultiline && multilineType === ">"
      ? currentValue.join(" ").trim()
      : currentValue.join("\n").trim();
  }
  return result;
};

const loadSkills = () => {
  try {
    skills.value = window.services.getGrokSkills() || [];
  } catch (e) {
    console.error("加载 Grok skills 失败:", e);
    skills.value = [];
  }
};

// 切回本页时自动刷新（页面用 v-show 保活，onMounted 不会再跑）
const { autoRefreshing, refreshNow } = usePageRefresh("grok", "skill", loadSkills);

const enabledSkills = computed(() => skills.value.filter((s) => !s.disabled));
const disabledSkills = computed(() => skills.value.filter((s) => s.disabled));

const toggleSkill = (skill, enabled) => {
  const result = window.services.setGrokSkillEnabled(skill.name, enabled);
  if (result.success) {
    MessagePlugin.success(t(enabled ? "grok.skill.enabledSuccess" : "grok.skill.disabledSuccess", { name: skill.name }));
    loadSkills();
  } else {
    MessagePlugin.error(result.error || t("common.saveFailed"));
  }
};

const deleteSkill = (skill) => {
  const result = window.services.deleteGrokSkill(skill.name, skill.disabled);
  if (result.success) {
    MessagePlugin.success(t("grok.skill.deletedSuccess", { name: skill.name }));
    loadSkills();
  } else {
    MessagePlugin.error(result.error || t("common.deleteFailed"));
  }
};

const openDir = () => {
  try {
    window.utools.shellOpenPath(window.services.getGrokSkillsDir());
  } catch {
    MessagePlugin.error(t("grok.skill.openDirFailed"));
  }
};

const openSkillDir = (skill) => {
  try {
    window.utools.shellOpenPath(skill.path);
  } catch {
    MessagePlugin.error(t("grok.skill.openDirFailed"));
  }
};

const openDetail = (skill) => {
  selectedSkill.value = skill;
  showDetailDialog.value = true;
};

// 通用安装弹窗（SkillHub / 魔搭社区），目标目录为 ~/.grok/skills（服务层 skills-install 已接入）
const installDialogRef = ref(null);
const SKILL_INSTALL_CONFIG = {
  getSkillsPath: "getGrokSkillsDir",
  installSkill: "installGrokSkill",
  installSkillFromModelScope: "installGrokSkillFromModelScope",
  completeSkillInstall: "completeGrokSkillInstall",
  cancelSkillInstall: "cancelGrokSkillInstall",
};
const openInstallWithUrl = (url) => {
  installDialogRef.value?.open(url);
};

defineExpose({ openInstallWithUrl });

onMounted(() => setTimeout(refreshNow, 50));
</script>

<template>
  <div class="grok-skill-container">
    <div class="grok-skill-header">
      <span class="grok-skill-tip">
        <span class="hint-link" @click="openDir">~/.grok/skills</span>
        <span class="grok-skill-sub">{{ t("grok.skill.tip") }}</span>
      </span>
      <Space size="small">
        <Button size="small" theme="primary" @click="installDialogRef?.open()">
          <template #icon><DownloadIcon /></template> {{ t("grok.skill.install") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="autoRefreshing" @click="refreshNow">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </Space>
    </div>

    <div v-if="!skills.length" class="grok-skill-empty">
      <Empty :description="t('grok.skill.empty')" />
    </div>

    <div v-else class="grok-skill-list">
      <SkillCard
        v-for="skill in enabledSkills"
        :key="skill.name"
        :name="skill.name"
        @detail="openDetail(skill)"
      >
        <template #actions>
          <Space size="small">
            <Switch :value="true" @change="(val) => toggleSkill(skill, val)" />
            <Popconfirm theme="danger" :content="t('grok.skill.deleteConfirm')" @confirm="deleteSkill(skill)">
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </template>
        <template #description>{{ parseFrontmatter(skill.frontmatter).description || t("skill.noDescription") }}</template>
        <template #meta>
          <Tag size="small" variant="light" theme="default">{{ t("grok.skill.fileCount", { count: skill.fileCount }) }}</Tag>
        </template>
      </SkillCard>

      <template v-if="disabledSkills.length > 0">
        <div class="grok-skill-section-divider">
          <span class="grok-skill-section-label">{{ t("grok.skill.disabledSection", { count: disabledSkills.length }) }}</span>
        </div>
        <SkillCard
          v-for="skill in disabledSkills"
          :key="skill.name + '-disabled'"
          :name="skill.name"
          disabled
          @detail="openDetail(skill)"
        >
          <template #actions>
            <Space size="small">
              <Switch :value="false" @change="(val) => toggleSkill(skill, val)" />
              <Popconfirm theme="danger" :content="t('grok.skill.deleteConfirm')" @confirm="deleteSkill(skill)">
                <Tooltip :content="t('common.delete')" placement="top">
                  <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
                </Tooltip>
              </Popconfirm>
            </Space>
          </template>
          <template #description>{{ parseFrontmatter(skill.frontmatter).description || t("skill.noDescription") }}</template>
          <template #meta>
            <Tag size="small" variant="light" theme="default">{{ t("grok.skill.fileCount", { count: skill.fileCount }) }}</Tag>
          </template>
        </SkillCard>
      </template>
    </div>

    <!-- 详情弹窗 -->
    <Dialog v-model:visible="showDetailDialog" width="600px" :footer="false">
      <template #header>
        <div class="grok-skill-detail-header">
          <span>{{ selectedSkill?.name || t("grok.skill.detailTitle") }}</span>
          <Tooltip :content="t('grok.skill.openFolder')" placement="top">
            <Button size="small" variant="outline" @click="openSkillDir(selectedSkill)">
              <template #icon><FolderOpen1Icon style="font-size: 14px" /></template> {{ t("grok.skill.folder") }}
            </Button>
          </Tooltip>
        </div>
      </template>
      <div v-if="selectedSkill" class="grok-skill-detail">
        <div class="grok-skill-detail-grid">
          <div class="grok-skill-detail-item">
            <span class="grok-skill-detail-label">{{ t("common.name") }}</span>
            <span class="grok-skill-detail-value">{{ selectedSkill.name }}</span>
          </div>
          <div class="grok-skill-detail-item">
            <span class="grok-skill-detail-label">{{ t("grok.skill.status") }}</span>
            <Tag size="small" :theme="selectedSkill.disabled ? 'default' : 'success'" variant="light">
              {{ selectedSkill.disabled ? t("common.disabled") : t("common.enabled") }}
            </Tag>
          </div>
          <div class="grok-skill-detail-item">
            <span class="grok-skill-detail-label">{{ t("grok.skill.fileCountLabel") }}</span>
            <span class="grok-skill-detail-value">{{ selectedSkill.fileCount || "-" }}</span>
          </div>
        </div>
        <div v-if="parseFrontmatter(selectedSkill.frontmatter).description" class="grok-skill-detail-section">
          <div class="grok-skill-detail-title">{{ t("grok.skill.description") }}</div>
          <div class="grok-skill-detail-desc">{{ parseFrontmatter(selectedSkill.frontmatter).description }}</div>
        </div>
      </div>
    </Dialog>

    <SkillInstallDialog ref="installDialogRef" :service-config="SKILL_INSTALL_CONFIG" manual-dir-label="~/.grok/skills" />
  </div>
</template>
