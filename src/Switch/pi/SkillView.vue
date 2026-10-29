<script setup>
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Card, Empty, Tag, Button, Tooltip } from "tdesign-vue-next";
import { RefreshIcon, FolderOpen1Icon } from "tdesign-icons-vue-next";
import { usePageRefresh } from "../../composables/usePageRefresh";
import "./styles/SkillView.css";

const { t } = useI18n();

const loading = ref(false);
const skills = ref([]);

const loadSkills = () => {
  loading.value = true;
  try {
    skills.value = window.services.getPiSkills();
  } catch (e) {
    console.error("加载 Pi Skills 失败:", e);
    skills.value = [];
  }
  setTimeout(() => { loading.value = false; }, 50);
};

// 切回本页时自动刷新（页面用 v-show 保活，onMounted 不会再跑）
const { autoRefreshing } = usePageRefresh("pi", "skill", loadSkills);

const openPiSkillsDir = () => {
  try {
    window.services.openPiDir();
  } catch (e) {
    console.error("打开 Pi 目录失败:", e);
  }
};

const getDescription = (fm) => {
  if (!fm) return '';
  const m = fm.match(/description:\s*(.+)/);
  return m ? m[1].trim() : '';
};

const copySkillName = (name) => {
  try {
    navigator.clipboard.writeText(name);
  } catch {}
};

onMounted(loadSkills);
</script>

<template>
  <div class="pi-skill-container">
    <div class="pi-section-header">
      <span class="pi-skill-tip">{{ t("pi.skill.tipPrefix") }}<code class="pi-hint-link" @click="openPiSkillsDir">pi config</code>{{ t("pi.skill.tipSuffix") }}</span>

      <Tooltip :content="t('common.refresh')" placement="top">

        <Button size="small" variant="outline" :loading="loading || autoRefreshing" @click="loadSkills">
        <template #icon><RefreshIcon /></template>
      </Button>

      </Tooltip>
    </div>

    <div v-if="skills.length === 0" class="pi-empty-state">
      <Empty :description="t('pi.skill.empty')" />
    </div>

    <div v-else class="pi-skill-list">
      <Card
        v-for="sk in skills"
        :key="sk.name + '@' + sk.package"
        :bordered="true"
        class="pi-skill-card"
        hover
      >
        <template #header>
          <div class="pi-skill-header-wrapper">
            <div class="pi-skill-header-left">
              <Tooltip :content="t('pi.skill.copyName')" placement="top">
                <span class="pi-skill-name-link" @click.stop="copySkillName(sk.name)">{{ sk.name }}</span>
              </Tooltip>
              <Tag size="small" variant="outline">@{{ sk.package }}</Tag>
            </div>
          </div>
        </template>
        <div class="pi-skill-description">
          {{ getDescription(sk.frontmatter) || t('skill.noDescription') }}
        </div>
        <div class="pi-skill-stats">
          <Tag size="small" variant="light" theme="success">{{ t("pi.skill.available") }}</Tag>
        </div>
      </Card>
    </div>
  </div>
</template>
