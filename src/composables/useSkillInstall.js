import { ref, watch } from "vue";
import { MessagePlugin } from "tdesign-vue-next";
import { t } from "../i18n";

const DEFAULT_CONFIG = {
  getSkillsPath: 'getSkillsPath',
  installSkill: 'installSkill',
  installSkillFromModelScope: 'installSkillFromModelScope',
  completeSkillInstall: 'completeSkillInstall',
  cancelSkillInstall: 'cancelSkillInstall',
};

// TRACE 评测维度（顺序与官方一致）
const TRACE_DIMENSIONS = [
  { key: 'trust', labelKey: 'skill.trace.trust' },
  { key: 'reliability', labelKey: 'skill.trace.reliability' },
  { key: 'adaptability', labelKey: 'skill.trace.adaptability' },
  { key: 'convention', labelKey: 'skill.trace.convention' },
  { key: 'effectiveness', labelKey: 'skill.trace.effectiveness' },
];

// 分类 key → 文案 key（fetchSkillHubCategories 失败时的兜底）
const SKILLHUB_CATEGORY_FALLBACK = {
  'pay-skill': 'skill.categories.paySkill',
  'office-efficiency': 'skill.categories.officeEfficiency',
  'content-creation': 'skill.categories.contentCreation',
  'dev-programming': 'skill.categories.devProgramming',
  'data-analysis': 'skill.categories.dataAnalysis',
  'design-media': 'skill.categories.designMedia',
  'ai-agent': 'skill.categories.aiAgent',
  'knowledge-management': 'skill.categories.knowledgeManagement',
  'business-ops': 'skill.categories.businessOps',
  education: 'skill.categories.education',
  professional: 'skill.categories.professional',
  'it-ops-security': 'skill.categories.itOpsSecurity',
  'life-service': 'skill.categories.lifeService',
};

// 计算 TRACE 评测总分（算法与官方一致：维度分 = items 均值，总分 = 五维均值）
const buildEvaluation = (data) => {
  if (!data || !data.dimensions) return null;
  const dimScores = TRACE_DIMENSIONS.map(({ key }) => {
    const items = data.dimensions[key]?.items;
    const scores = Object.values(items || {})
      .map((i) => i?.score)
      .filter((s) => typeof s === 'number');
    return scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0;
  });
  const total = dimScores.reduce((a, b) => a + b, 0) / dimScores.length;
  return { total: Math.round(total * 10) / 10 };
};

export function useSkillInstall(loadSkills, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const showInstallDialog = ref(false);
  const installUrl = ref("");
  const isFetchingInfo = ref(false);
  const isInstalling = ref(false);
  const installInfo = ref(null);
  const installProgress = ref(0);
  const pendingInstall = ref(null);
  const showOverwriteDialog = ref(false);

  let fetchTimer = null;

  const extractSlug = (url) => {
    // SkillHub 新格式: skillhub.cn/skills/{namespace}/{slug}；兼容老格式单段 /skills/{slug}
    const skillhubMatch = url.match(
      /skillhub\.(?:tencent\.com|cn)\/skills\/([^/?#]+)(?:\/([^/?#]+))?/,
    );
    if (skillhubMatch) {
      const first = skillhubMatch[1];
      const second = skillhubMatch[2];
      if (second)
        return { source: 'skillhub', slug: second, namespace: first };
      return { source: 'skillhub', slug: first, namespace: null };
    }
    const modelscopeMatch = url.match(/modelscope\.cn\/skills\/(@?[^/]+\/[^/]+)/);
    if (modelscopeMatch) return { source: 'modelscope', slug: modelscopeMatch[1] };
    return null;
  };

  const doFetchSkillInfo = async ({ source, slug, namespace }) => {
    isFetchingInfo.value = true;
    installInfo.value = null;
    try {
      if (source === 'skillhub') {
        const result = await window.services.fetchSkillInfo(slug, namespace);
        const info = result.data;
        // 并行拉取评测报告与分类（尽力而为，失败不阻塞主流程）
        let evaluation = null;
        let categoryMap = {};
        try {
          const [ev, cat] = await Promise.all([
            window.services.fetchSkillEvaluation(slug, namespace),
            window.services.fetchSkillHubCategories(),
          ]);
          evaluation = ev;
          categoryMap = (cat?.items || []).reduce((acc, c) => {
            acc[c.key] = c.name;
            return acc;
          }, {});
        } catch (e) {
          /* ignore */
        }
        const catKey = info.skill?.category;
        const tags = [];
        const fallbackKey = SKILLHUB_CATEGORY_FALLBACK[catKey];
        const catName = categoryMap[catKey] || (fallbackKey ? t(fallbackKey) : null);
        if (catName) tags.push(catName);
        (info.skill?.subCategories || []).forEach((s) => {
          if (s?.name) tags.push(s.name);
        });
        installInfo.value = {
          source: 'skillhub',
          slug,
          namespace,
          displayName: info.skill?.displayName || slug,
          summary: info.skill?.summary_zh || info.skill?.summary || t('skill.noDescription'),
          version: info.latestVersion?.version || 'unknown',
          downloads: info.skill?.stats?.downloads || 0,
          author: info.owner?.displayName || info.owner?.handle || t('skill.unknownAuthor'),
          tags,
          requiresApiKey: info.skill?.labels?.requires_api_key === 'true',
          evaluation: buildEvaluation(evaluation),
        };
      } else if (source === 'modelscope') {
        const result = await window.services.fetchModelScopeSkillInfo(slug);
        const info = result.data;
        installInfo.value = {
          source: 'modelscope',
          slug,
          displayName: info.DisplayName || info.Name || slug.split('/').pop(),
          summary: info.Description || t('skill.noDescription'),
          version: 'master',
          downloads: info.DownloadCount || 0,
          author: info.Owner || info.SourceDeveloper || t('skill.unknownAuthor')
        };
      }
    } catch (e) {
      MessagePlugin.error(t('skill.fetchFailed', { message: e.message }));
    } finally {
      isFetchingInfo.value = false;
    }
  };

  watch(installUrl, (newVal) => {
    if (fetchTimer) {
      clearTimeout(fetchTimer);
      fetchTimer = null;
    }
    if (installInfo.value) installInfo.value = null;

    const result = extractSlug(newVal.trim());
    if (!result) return;

    const isCompleteUrl = newVal.includes('skillhub.') || newVal.includes('modelscope.cn');
    if (isCompleteUrl) {
      doFetchSkillInfo(result);
    } else {
      fetchTimer = setTimeout(() => doFetchSkillInfo(result), 500);
    }
  });

  const openInstallDialog = () => {
    installUrl.value = "";
    installInfo.value = null;
    pendingInstall.value = null;
    isFetchingInfo.value = false;
    isInstalling.value = false;
    showInstallDialog.value = true;
  };

  const openInstallWithUrl = (url) => {
    installUrl.value = url;
    installInfo.value = null;
    pendingInstall.value = null;
    isFetchingInfo.value = false;
    isInstalling.value = false;
    showInstallDialog.value = true;
  };

  const openExternal = (url) => {
    window.utools.shellOpenExternal(url);
  };

  const openSkillsDir = () => {
    window.utools.shellOpenPath(window.services[cfg.getSkillsPath]());
  };

  const confirmInstall = async () => {
    if (!installInfo.value) return;
    isInstalling.value = true;
    installProgress.value = 0;

    try {
      let result;
      if (installInfo.value.source === 'skillhub') {
        result = await window.services[cfg.installSkill](
          installInfo.value.slug,
          installInfo.value.version,
          installInfo.value.namespace,
          (progress) => { installProgress.value = progress; }
        );
      } else if (installInfo.value.source === 'modelscope') {
        result = await window.services[cfg.installSkillFromModelScope](
          installInfo.value.slug,
          (progress) => { installProgress.value = progress; }
        );
      }

      pendingInstall.value = result;

      if (result.exists) {
        showInstallDialog.value = false;
        showOverwriteDialog.value = true;
      } else {
        window.services[cfg.completeSkillInstall](result.skillName, result.extractDir);
        MessagePlugin.success(t('skill.installSuccess', { name: result.skillName }));
        showInstallDialog.value = false;
        loadSkills();
      }
    } catch (e) {
      MessagePlugin.error(t('skill.installFailed', { message: e.message }));
      window.services[cfg.cancelSkillInstall]();
    } finally {
      isInstalling.value = false;
    }
  };

  const overwriteInstall = () => {
    if (!pendingInstall.value) return;
    window.services[cfg.completeSkillInstall](
      pendingInstall.value.skillName,
      pendingInstall.value.extractDir
    );
    MessagePlugin.success(t('skill.overwriteSuccess', { name: pendingInstall.value.skillName }));
    pendingInstall.value = null;
    showOverwriteDialog.value = false;
    loadSkills();
  };

  const cancelInstall = () => {
    if (pendingInstall.value) {
      window.services[cfg.cancelSkillInstall](pendingInstall.value.extractDir);
    }
    pendingInstall.value = null;
    showOverwriteDialog.value = false;
  };

  return {
    showInstallDialog,
    installUrl,
    isFetchingInfo,
    isInstalling,
    installInfo,
    installProgress,
    pendingInstall,
    showOverwriteDialog,
    openInstallDialog,
    openInstallWithUrl,
    openExternal,
    openSkillsDir,
    confirmInstall,
    overwriteInstall,
    cancelInstall,
  };
}
