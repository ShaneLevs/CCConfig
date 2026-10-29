<script setup>

import { ref, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Dialog, Button, MessagePlugin, Switch, Popconfirm, Space, Tag, Tooltip,
  Select, Input, Checkbox,
} from "tdesign-vue-next";
import {
  DownloadIcon, DeleteIcon, RefreshIcon, FolderOpen1Icon, SettingIcon, AddIcon,
  EditIcon, CloseIcon,
} from "tdesign-icons-vue-next";
import SkillInstallDialog from "../../components/SkillInstallDialog.vue";
import SkillCard from "../../components/SkillCard.vue";
import { usePageRefresh } from "../../composables/usePageRefresh";
import "./styles/SkillView.css";

const { t } = useI18n();

// 通用 Skill：读取 ~/.agents/skills 目录下的 Skill（SKILL.md 元数据），
// 支持从 SkillHub / 魔搭社区 通过链接安装（功能同 Claude Code，仅安装目录不同）。
// 启停：物理移动目录到 .disabled/（同 Claude Code）；
// 场景：按用途绑定一组 Skill，切换后只启用绑定的那些（见 preload/services/common.js）。

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

// 场景：按用途绑定一组 Skill，切换后只启用绑定的那些（服务层物理移动 .disabled 目录）
const scenes = ref([]);
const activeSceneId = ref("");
const showSceneManager = ref(false);
const draft = ref(null);
const pendingScene = ref(null);
const editingSceneId = ref(null);
const editingName = ref("");
let selectionBeforeNew = "";

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

const loadScenes = () => {
  try {
    const data = window.services.getSkillScenes();
    scenes.value = Array.isArray(data?.scenes) ? data.scenes : [];
    activeSceneId.value = data?.activeId || "";
  } catch (e) {
    console.error("加载 Skill 场景失败:", e);
    scenes.value = [];
    activeSceneId.value = "";
  }
};

const loadAll = () => {
  loadSkills();
  loadScenes();
};

// 切回本页时自动刷新（页面用 v-show 保活，onMounted 不会再跑）
const { autoRefreshing } = usePageRefresh("common", "skill", loadAll);

const activeScene = computed(
  () => scenes.value.find((s) => s.id === activeSceneId.value) || null
);

const sceneOptions = computed(() =>
  scenes.value.map((s) => ({ label: s.name, value: s.id }))
);

const sceneFailureText = (applied) =>
  (applied?.failed || [])
    .map((f) => `${f.name} (${f.action}): ${f.error}`)
    .join('; ');

const notifySceneResult = (result, scene) => {
  const applied = result?.applied;
  if (!applied) return;
  if (applied.failed?.length) {
    MessagePlugin.error(t('commonApp.skill.scene.switchPartial', {
      count: applied.failed.length,
      detail: sceneFailureText(applied),
    }));
  } else if (applied.missing?.length) {
    MessagePlugin.warning(t('commonApp.skill.scene.switchMissing', {
      count: applied.missing.length,
      names: applied.missing.join(', '),
    }));
  } else {
    MessagePlugin.success(t('commonApp.skill.scene.switchSuccess', {
      name: scene?.name || '',
      count: applied.enabled.length,
    }));
  }
};

const switchScene = (id) => {
  if (!id) return;
  try {
    const result = window.services.switchSkillScene(id);
    loadScenes();
    loadSkills();
    const scene = scenes.value.find((s) => s.id === id) || { name: '' };
    notifySceneResult(result, scene);
  } catch (e) {
    console.error("切换 Skill 场景失败:", e);
    MessagePlugin.error(t('commonApp.skill.scene.applyFailed', { message: e.message }));
    loadScenes();
  }
};

const handleSceneChange = (value) => {
  switchScene(value);
};

// uTools 指令「场景：<名称>」/「Scene: <名称>」进入时由 index.vue 的深链调用
const applySceneFromCommand = (payload) => {
  loadScenes();
  const name = String(payload || '')
    .trim()
    .replace(/^(?:场景[:：]\s*|Scene:\s*)/i, '')
    .trim();
  if (!name) return;
  const scene = scenes.value.find((s) => s.name === name);
  if (scene) {
    switchScene(scene.id);
    return;
  }
  MessagePlugin.warning(t('commonApp.skill.scene.switchNotFound', { name }));
};

// ---------- 场景管理弹窗 ----------
const cloneScene = (scene) => ({
  id: scene.id,
  name: scene.name,
  skillDirs: [...(scene.skillDirs || [])],
});

const focusSceneNameInput = () => {
  nextTick(() => {
    const input = document.querySelector('.scene-inline-name input');
    if (input) {
      input.focus();
      input.select?.();
    }
  });
};

const openSceneManager = () => {
  loadScenes();
  pendingScene.value = null;
  editingSceneId.value = null;
  editingName.value = "";
  const first = activeScene.value || scenes.value[0] || null;
  draft.value = first ? cloneScene(first) : null;
  showSceneManager.value = true;
};

// 关闭弹窗视为取消：未命名的草稿不落库
const closeSceneManager = () => {
  pendingScene.value = null;
  editingSceneId.value = null;
  editingName.value = "";
};

const startNewScene = () => {
  if (editingSceneId.value) cancelRename();
  if (pendingScene.value) {
    focusSceneNameInput();
    return;
  }
  selectionBeforeNew = draft.value?.id || "";
  const scene = { id: "", name: "", skillDirs: [] };
  pendingScene.value = scene;
  draft.value = scene;
  focusSceneNameInput();
};

const cancelNewScene = () => {
  pendingScene.value = null;
  const previous =
    scenes.value.find((s) => s.id === selectionBeforeNew) ||
    activeScene.value ||
    scenes.value[0] ||
    null;
  draft.value = previous ? cloneScene(previous) : null;
};

// 回车 / 勾选 / 失焦：有名字才创建，空名字视为取消
const commitNewScene = () => {
  const scene = pendingScene.value;
  if (!scene) return;
  const name = String(scene.name || "").trim();
  if (!name) {
    cancelNewScene();
    return;
  }
  try {
    const result = window.services.saveSkillScene({
      name,
      skillDirs: scene.skillDirs,
    });
    pendingScene.value = null;
    loadScenes();
    draft.value = cloneScene(result.scene);
    MessagePlugin.success(t('commonApp.skill.scene.saved', { name: result.scene.name }));
  } catch (e) {
    MessagePlugin.error(e.message || t('commonApp.skill.scene.nameRequired'));
    focusSceneNameInput();
  }
};

// 失焦即视为确定：有名字创建，没名字取消（勾/叉只保留取消按钮）
const onNewSceneBlur = () => {
  commitNewScene();
};

const selectPendingScene = () => {
  if (pendingScene.value) draft.value = pendingScene.value;
};

const selectDraftScene = (scene) => {
  if (editingSceneId.value && editingSceneId.value !== scene.id) {
    editingSceneId.value = null;
    editingName.value = "";
  }
  draft.value = cloneScene(scene);
};

const startRename = (scene) => {
  if (pendingScene.value) cancelNewScene();
  draft.value = cloneScene(scene);
  editingSceneId.value = scene.id;
  editingName.value = scene.name;
  focusSceneNameInput();
};

const cancelRename = () => {
  editingSceneId.value = null;
  editingName.value = "";
};

const commitRename = (scene) => {
  if (editingSceneId.value !== scene.id) return;
  const name = editingName.value.trim();
  if (!name) {
    cancelRename();
    return;
  }
  if (name === scene.name) {
    cancelRename();
    return;
  }
  try {
    const result = window.services.saveSkillScene({
      id: scene.id,
      name,
      skillDirs: scene.skillDirs,
    });
    loadScenes();
    if (draft.value?.id === scene.id) draft.value = cloneScene(result.scene);
    cancelRename();
    MessagePlugin.success(t('commonApp.skill.scene.saved', { name: result.scene.name }));
  } catch (e) {
    MessagePlugin.error(e.message || t('commonApp.skill.scene.nameRequired'));
    focusSceneNameInput();
  }
};

// 右侧两列：已选在前，未选在后；勾选/取消会实时在两列之间移动
const selectedSkills = computed(() => {
  if (!draft.value) return [];
  const selected = new Set(draft.value.skillDirs);
  return skills.value.filter((s) => selected.has(s.dirName));
});

const unselectedSkills = computed(() => {
  if (!draft.value) return [];
  const selected = new Set(draft.value.skillDirs);
  return skills.value.filter((s) => !selected.has(s.dirName));
});

const toggleDraftSkill = (name, checked) => {
  if (!draft.value) return;
  const set = new Set(draft.value.skillDirs);
  if (checked) set.add(name);
  else set.delete(name);
  draft.value.skillDirs = [...set];
};

const draftAllSelected = computed(
  () => !!draft.value && skills.value.length > 0 &&
    skills.value.every((s) => draft.value.skillDirs.includes(s.dirName))
);

const toggleDraftAll = () => {
  if (!draft.value) return;
  draft.value.skillDirs = draftAllSelected.value
    ? []
    : skills.value.map((s) => s.dirName);
};

const saveDraft = (apply) => {
  if (!draft.value) return;
  try {
    let sceneId = draft.value.id;
    if (!sceneId) {
      const name = String(draft.value.name || "").trim();
      if (!name) {
        MessagePlugin.error(t('commonApp.skill.scene.nameRequired'));
        focusSceneNameInput();
        return;
      }
      const created = window.services.saveSkillScene({
        name,
        skillDirs: draft.value.skillDirs,
      });
      pendingScene.value = null;
      loadScenes();
      draft.value = cloneScene(created.scene);
      sceneId = created.scene.id;
      MessagePlugin.success(t('commonApp.skill.scene.saved', { name: created.scene.name }));
    } else {
      const current = scenes.value.find((s) => s.id === sceneId);
      const result = window.services.saveSkillScene({
        id: sceneId,
        name: current?.name || draft.value.name,
        skillDirs: draft.value.skillDirs,
      });
      loadScenes();
      draft.value = cloneScene(result.scene);
      MessagePlugin.success(t('commonApp.skill.scene.saved', { name: result.scene.name }));
    }
    loadSkills();
    if (apply) {
      switchScene(sceneId);
      showSceneManager.value = false;
    }
  } catch (e) {
    MessagePlugin.error(e.message || t('commonApp.skill.scene.applyFailed', { message: '' }));
  }
};

const removeDraftScene = () => {
  if (!draft.value?.id) return;
  try {
    window.services.deleteSkillScene(draft.value.id);
    loadScenes();
    loadSkills();
    MessagePlugin.success(t('commonApp.skill.scene.deleted'));
    const first = scenes.value[0] || null;
    draft.value = pendingScene.value || (first ? cloneScene(first) : null);
    cancelRename();
  } catch (e) {
    MessagePlugin.error(e.message || t('commonApp.skill.scene.applyFailed', { message: '' }));
  }
};

const onGlobalKeydown = (event) => {
  if (event.key !== "Escape" || !showSceneManager.value) return;
  if (pendingScene.value) cancelNewScene();
  if (editingSceneId.value) cancelRename();
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

defineExpose({ openInstallWithUrl, applySceneFromCommand });

const openDetail = (skill) => {
  selectedSkill.value = skill;
  showDetailDialog.value = true;
};

const toggleSkill = (skill, enabled) => {
  const result = window.services.setCommonSkillEnabled(skill.dirName, enabled);
  if (result.success) {
    MessagePlugin.success(enabled ? t('commonApp.skill.enabledToast', { name: skill.name }) : t('commonApp.skill.disabledToast', { name: skill.name }));
    skill.enabled = enabled;
    // 当前场景有效时服务层会同步绑定，刷新场景计数
    loadScenes();
  } else {
    MessagePlugin.error(result.error || (enabled ? t('commonApp.skill.enableFailed') : t('commonApp.skill.disableFailed')));
  }
};

const deleteSkill = (skill) => {
  const result = window.services.deleteCommonSkill(skill.dirName);
  if (result.success) {
    MessagePlugin.success(t('commonApp.skill.deletedToast', { name: skill.name }));
    loadAll();
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

onMounted(() => {
  loadAll();
  // 桌面版托盘也能切场景：窗口重新获得焦点时刷新，避免主界面显示旧状态
  window.addEventListener('focus', loadAll);
  // Esc 关闭弹窗前先撤销行内编辑，避免输入框 blur 把未确认的名字提交
  window.addEventListener('keydown', onGlobalKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('focus', loadAll);
  window.removeEventListener('keydown', onGlobalKeydown, true);
});
</script>

<template>
  <div class="skill-container">
    <div class="section-header">
      <span class="skill-tip">{{ t('commonApp.skill.tipPrefix') }}<span class="hint-link" @click="openCommonSkillsDir">~/.agents/skills</span>{{ t('commonApp.skill.tipSuffix') }}</span>
      <Space size="small">
        <!-- 场景切换 + 管理，与安装 / 刷新同一行 -->
        <Select
          v-if="scenes.length"
          class="skill-scene-select"
          size="small"
          :value="activeSceneId"
          :options="sceneOptions"
          :placeholder="t('commonApp.skill.scene.selectPlaceholder')"
          @change="handleSceneChange"
        />
        <Button size="small" variant="outline" @click="openSceneManager">
          <template #icon><SettingIcon /></template>
          {{ t('commonApp.skill.scene.manage') }}
        </Button>
        <Button size="small" theme="primary" @click="installDialogRef?.open()">
          <template #icon><DownloadIcon /></template> {{ t('skill.install.title') }}
        </Button>

        <Tooltip :content="t('common.refresh')" placement="top">

          <Button size="small" variant="outline" :loading="loading || autoRefreshing" @click="loadSkills">
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

    <!-- 场景管理弹窗 -->
    <Dialog
      v-model:visible="showSceneManager"
      width="760px"
      :header="t('commonApp.skill.scene.managerTitle')"
      :footer="false"
      @close="closeSceneManager"
    >
      <div class="scene-manager">
        <div class="scene-manager-list">
          <div
            v-for="scene in scenes"
            :key="scene.id"
            class="scene-manager-item"
            :class="{ 'is-active': draft && draft.id === scene.id }"
            @click="selectDraftScene(scene)"
          >
            <template v-if="editingSceneId === scene.id">
              <Input
                class="scene-inline-name"
                size="small"
                v-model="editingName"
                :maxlength="30"
                @enter="commitRename(scene)"
                @blur="commitRename(scene)"
              />
              <Button
                class="scene-inline-action"
                size="small"
                variant="text"
                @mousedown.prevent
                @click.stop="cancelRename"
              >
                <template #icon><CloseIcon /></template>
              </Button>
            </template>
            <template v-else>
              <span class="scene-manager-name">{{ scene.name }}</span>
              <Tag v-if="scene.id === activeSceneId" size="small" variant="light" theme="success">
                {{ t('commonApp.skill.scene.current') }}
              </Tag>
              <span class="scene-manager-meta">
                <span class="scene-manager-count">{{ t('commonApp.skill.scene.sceneCount', { count: scene.skillDirs.length }) }}</span>
                <Tooltip :content="t('commonApp.skill.scene.rename')" placement="top">
                  <Button
                    class="scene-edit-btn"
                    size="small"
                    variant="text"
                    @click.stop="startRename(scene)"
                  >
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
              </span>
            </template>
          </div>

          <!-- 新建：直接在列表里以输入框维护名字，空名字取消时不落库 -->
          <div
            v-if="pendingScene"
            class="scene-manager-item is-active"
            @click="selectPendingScene"
          >
            <Input
              class="scene-inline-name"
              size="small"
              v-model="pendingScene.name"
              :placeholder="t('commonApp.skill.scene.namePlaceholder')"
              :maxlength="30"
              @enter="commitNewScene"
              @blur="onNewSceneBlur"
            />
            <Button
              class="scene-inline-action"
              size="small"
              variant="text"
              @mousedown.prevent
              @click.stop="cancelNewScene"
            >
              <template #icon><CloseIcon /></template>
            </Button>
          </div>

          <Button
            class="scene-manager-add"
            size="small"
            variant="text"
            :disabled="!!pendingScene"
            @click="startNewScene"
          >
            <template #icon><AddIcon /></template>
            {{ t('commonApp.skill.scene.newScene') }}
          </Button>
        </div>

        <div v-if="draft" class="scene-manager-detail">
          <div class="scene-manager-skills-head">
            <span>{{ t('commonApp.skill.scene.selectSkills', { count: draft.skillDirs.length }) }}</span>
            <Button size="small" variant="text" @click="toggleDraftAll">
              {{ draftAllSelected ? t('commonApp.skill.scene.clearAll') : t('commonApp.skill.scene.selectAll') }}
            </Button>
          </div>

          <div v-if="!skills.length" class="scene-skill-empty">
            {{ t('commonApp.skill.scene.noSkills') }}
          </div>
          <div v-else class="scene-skill-columns">
            <div class="scene-skill-column">
              <div class="scene-skill-column-head">
                {{ t('commonApp.skill.scene.selectedSkills', { count: selectedSkills.length }) }}
              </div>
              <div class="scene-skill-list">
                <div
                  v-for="skill in selectedSkills"
                  :key="skill.dirName"
                  class="scene-skill-item"
                >
                  <Checkbox
                    :checked="true"
                    @change="(val) => toggleDraftSkill(skill.dirName, val)"
                  />
                  <span class="scene-skill-name">{{ skill.name }}</span>
                  <Tag size="small" variant="light" :theme="skill.enabled ? 'success' : 'default'">
                    {{ skill.enabled ? t('common.enabled') : t('common.disabled') }}
                  </Tag>
                </div>
                <div v-if="!selectedSkills.length" class="scene-skill-empty">
                  {{ t('commonApp.skill.scene.noneSelected') }}
                </div>
              </div>
            </div>

            <div class="scene-skill-column">
              <div class="scene-skill-column-head">
                {{ t('commonApp.skill.scene.unselectedSkills', { count: unselectedSkills.length }) }}
              </div>
              <div class="scene-skill-list">
                <div
                  v-for="skill in unselectedSkills"
                  :key="skill.dirName"
                  class="scene-skill-item"
                >
                  <Checkbox
                    :checked="false"
                    @change="(val) => toggleDraftSkill(skill.dirName, val)"
                  />
                  <span class="scene-skill-name">{{ skill.name }}</span>
                  <Tag size="small" variant="light" :theme="skill.enabled ? 'success' : 'default'">
                    {{ skill.enabled ? t('common.enabled') : t('common.disabled') }}
                  </Tag>
                </div>
                <div v-if="!unselectedSkills.length" class="scene-skill-empty">
                  {{ t('commonApp.skill.scene.allSelected') }}
                </div>
              </div>
            </div>
          </div>

          <div class="scene-manager-hint">{{ t('commonApp.skill.scene.bindingHint') }}</div>

          <div class="scene-manager-actions">
            <Popconfirm
              v-if="draft.id"
              theme="danger"
              :content="t('commonApp.skill.scene.deleteConfirm')"
              @confirm="removeDraftScene"
            >
              <Button size="small" theme="danger" variant="outline">{{ t('common.delete') }}</Button>
            </Popconfirm>
            <div class="scene-manager-actions-right">
              <Button size="small" variant="outline" @click="saveDraft(false)">
                {{ t('commonApp.skill.scene.save') }}
              </Button>
              <Button size="small" theme="primary" @click="saveDraft(true)">
                {{ t('commonApp.skill.scene.saveAndApply') }}
              </Button>
            </div>
          </div>
        </div>

        <div v-else class="scene-manager-empty-detail">
          {{ t('commonApp.skill.scene.empty') }}
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
