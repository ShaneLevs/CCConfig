<script setup>
// Command Code Skill 管理：~/.commandcode/skills（官方用户级 skill 目录）
// 启停沿用 .disabled 目录机制（物理移动目录，同 Claude / OpenCode / Grok / 通用 Skill 同一套心智）。
// 官方还有一个 settings.json.disabledSkills 数组也能停用 Skill，但本插件统一用目录机制，
// 两套状态同时维护会打架（见 command-code.js 顶部说明）。
// 安装：复用通用安装弹窗（SkillHub / 魔搭社区），目标目录为 ~/.commandcode/skills。
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Empty, Button, Tag, Tooltip, Switch, Popconfirm, Space, MessagePlugin, Dialog } from "tdesign-vue-next";
import { DownloadIcon, DeleteIcon, FolderOpen1Icon, RefreshIcon } from "tdesign-icons-vue-next";
import SkillInstallDialog from "../../components/SkillInstallDialog.vue";
import SkillCard from "../../components/SkillCard.vue";
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
    skills.value = window.services.getCommandCodeSkills() || [];
  } catch (e) {
    console.error("加载 Command Code skills 失败:", e);
    skills.value = [];
  }
};

const enabledSkills = computed(() => skills.value.filter((s) => !s.disabled));
const disabledSkills = computed(() => skills.value.filter((s) => s.disabled));

const toggleSkill = (skill, enabled) => {
  const result = window.services.setCommandCodeSkillEnabled(skill.name, enabled);
  if (result.success) {
    MessagePlugin.success(t(enabled ? "commandcode.skill.enabledSuccess" : "commandcode.skill.disabledSuccess", { name: skill.name }));
    loadSkills();
  } else {
    MessagePlugin.error(result.error || t("common.saveFailed"));
  }
};

const deleteSkill = (skill) => {
  const result = window.services.deleteCommandCodeSkill(skill.name, skill.disabled);
  if (result.success) {
    MessagePlugin.success(t("commandcode.skill.deletedSuccess", { name: skill.name }));
    loadSkills();
  } else {
    MessagePlugin.error(result.error || t("common.deleteFailed"));
  }
};

const openDir = () => {
  try {
    window.utools.shellOpenPath(window.services.getCommandCodeSkillsDir());
  } catch {
    MessagePlugin.error(t("commandcode.skill.openDirFailed"));
  }
};

const openSkillDir = (skill) => {
  try {
    window.utools.shellOpenPath(skill.path);
  } catch {
    MessagePlugin.error(t("commandcode.skill.openDirFailed"));
  }
};

const openDetail = (skill) => {
  selectedSkill.value = skill;
  showDetailDialog.value = true;
};

// 通用安装弹窗（SkillHub / 魔搭社区），目标目录为 ~/.commandcode/skills
const installDialogRef = ref(null);
const SKILL_INSTALL_CONFIG = {
  getSkillsPath: "getCommandCodeSkillsDir",
  installSkill: "installCommandCodeSkill",
  installSkillFromModelScope: "installCommandCodeSkillFromModelScope",
  completeSkillInstall: "completeCommandCodeSkillInstall",
  cancelSkillInstall: "cancelCommandCodeSkillInstall",
};
const openInstallWithUrl = (url) => {
  installDialogRef.value?.open(url);
};

defineExpose({ openInstallWithUrl });

onMounted(() => setTimeout(loadSkills, 50));
</script>

<template>
  <div class="commandcode-skill-container">
    <div class="commandcode-skill-header">
      <span class="commandcode-skill-tip">
        <span class="hint-link" @click="openDir">~/.commandcode/skills</span>
        <span class="commandcode-skill-sub">{{ t("commandcode.skill.tip") }}</span>
      </span>
      <Space size="small">
        <Button size="small" theme="primary" @click="installDialogRef?.open()">
          <template #icon><DownloadIcon /></template> {{ t("commandcode.skill.install") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" @click="loadSkills">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </Space>
    </div>

    <div v-if="!skills.length" class="commandcode-skill-empty">
      <Empty :description="t('commandcode.skill.empty')" />
    </div>

    <div v-else class="commandcode-skill-list">
      <SkillCard
        v-for="skill in enabledSkills"
        :key="skill.name"
        :name="skill.name"
        @detail="openDetail(skill)"
      >
        <template #actions>
          <Space size="small">
            <Switch :value="true" @change="(val) => toggleSkill(skill, val)" />
            <Popconfirm theme="danger" :content="t('commandcode.skill.deleteConfirm')" @confirm="deleteSkill(skill)">
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </template>
        <template #description>{{ parseFrontmatter(skill.frontmatter).description || t("skill.noDescription") }}</template>
        <template #meta>
          <Tag size="small" variant="light" theme="default">{{ t("commandcode.skill.fileCount", { count: skill.fileCount }) }}</Tag>
        </template>
      </SkillCard>

      <template v-if="disabledSkills.length > 0">
        <div class="commandcode-skill-section-divider">
          <span class="commandcode-skill-section-label">{{ t("commandcode.skill.disabledSection", { count: disabledSkills.length }) }}</span>
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
              <Popconfirm theme="danger" :content="t('commandcode.skill.deleteConfirm')" @confirm="deleteSkill(skill)">
                <Tooltip :content="t('common.delete')" placement="top">
                  <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
                </Tooltip>
              </Popconfirm>
            </Space>
          </template>
          <template #description>{{ parseFrontmatter(skill.frontmatter).description || t("skill.noDescription") }}</template>
          <template #meta>
            <Tag size="small" variant="light" theme="default">{{ t("commandcode.skill.fileCount", { count: skill.fileCount }) }}</Tag>
          </template>
        </SkillCard>
      </template>
    </div>

    <!-- 详情弹窗 -->
    <Dialog v-model:visible="showDetailDialog" width="600px" :footer="false">
      <template #header>
        <div class="commandcode-skill-detail-header">
          <span>{{ selectedSkill?.name || t("commandcode.skill.detailTitle") }}</span>
          <Tooltip :content="t('commandcode.skill.openFolder')" placement="top">
            <Button size="small" variant="outline" @click="openSkillDir(selectedSkill)">
              <template #icon><FolderOpen1Icon style="font-size: 14px" /></template> {{ t("commandcode.skill.folder") }}
            </Button>
          </Tooltip>
        </div>
      </template>
      <div v-if="selectedSkill" class="commandcode-skill-detail">
        <div class="commandcode-skill-detail-grid">
          <div class="commandcode-skill-detail-item">
            <span class="commandcode-skill-detail-label">{{ t("common.name") }}</span>
            <span class="commandcode-skill-detail-value">{{ selectedSkill.name }}</span>
          </div>
          <div class="commandcode-skill-detail-item">
            <span class="commandcode-skill-detail-label">{{ t("commandcode.skill.status") }}</span>
            <Tag size="small" :theme="selectedSkill.disabled ? 'default' : 'success'" variant="light">
              {{ selectedSkill.disabled ? t("common.disabled") : t("common.enabled") }}
            </Tag>
          </div>
          <div class="commandcode-skill-detail-item">
            <span class="commandcode-skill-detail-label">{{ t("commandcode.skill.fileCountLabel") }}</span>
            <span class="commandcode-skill-detail-value">{{ selectedSkill.fileCount || "-" }}</span>
          </div>
        </div>
        <div v-if="parseFrontmatter(selectedSkill.frontmatter).description" class="commandcode-skill-detail-section">
          <div class="commandcode-skill-detail-title">{{ t("commandcode.skill.description") }}</div>
          <div class="commandcode-skill-detail-desc">{{ parseFrontmatter(selectedSkill.frontmatter).description }}</div>
        </div>
      </div>
    </Dialog>

    <SkillInstallDialog ref="installDialogRef" :service-config="SKILL_INSTALL_CONFIG" manual-dir-label="~/.commandcode/skills" />
  </div>
</template>
