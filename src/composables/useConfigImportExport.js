import { ref } from "vue";
import { MessagePlugin } from "tdesign-vue-next";
import { t } from "../i18n";

export function useConfigImportExport(savedConfigs, loadSavedConfigs) {
  const showImportStringDialog = ref(false);
  const importString = ref("");

  const handleExportAsString = () => {
    if (!savedConfigs.value.length) return MessagePlugin.warning(t("claude.config.noExport"));
    const keyDict = new Map(), urlDict = new Map(), list = [];
    savedConfigs.value.forEach((c, i) => {
      const idx = i + 1, cfg = {};
      cfg[`n${idx}`] = c.name;
      if (keyDict.has(c.key)) { cfg[`k${idx}`] = `k${keyDict.get(c.key)}`; } else { cfg[`k${idx}`] = c.key; keyDict.set(c.key, idx); }
      if (urlDict.has(c.baseUrl)) { cfg[`u${idx}`] = `u${urlDict.get(c.baseUrl)}`; } else { cfg[`u${idx}`] = c.baseUrl; urlDict.set(c.baseUrl, idx); }
      if (c.authVar && c.authVar !== 'ANTHROPIC_AUTH_TOKEN') cfg[`a${idx}`] = c.authVar;
      if (c.model) cfg[`m${idx}`] = c.model;
      if (c.defaultHaikuModel) cfg[`h${idx}`] = c.defaultHaikuModel;
      if (c.defaultSonnetModel) cfg[`s${idx}`] = c.defaultSonnetModel;
      if (c.defaultOpusModel) cfg[`o${idx}`] = c.defaultOpusModel;
      if (c.subagentModel) cfg[`g${idx}`] = c.subagentModel;
      list.push(cfg);
    });
    window.utools.copyText(window.services.encryptString(window.services.compressConfigs(list)));
    MessagePlugin.success(t("claude.config.copiedToClipboard"));
  };

  const openImportStringDialog = () => { importString.value = ""; showImportStringDialog.value = true; };

  const handleImportFromString = () => {
    const str = importString.value.trim();
    if (!str) return MessagePlugin.warning(t("claude.config.enterImportString"));
    const decompressed = window.services.decompressConfigs(window.services.decryptString(str));
    if (!decompressed || !Array.isArray(decompressed)) return MessagePlugin.error(t("claude.config.invalidImportString"));

    const configs = [], keyMap = new Map(), urlMap = new Map();
    decompressed.forEach((raw, i) => {
      const idx = i + 1;
      let key = raw[`k${idx}`], url = raw[`u${idx}`];
      if (typeof key === "string" && /^k\d+$/.test(key)) { key = keyMap.get(parseInt(key.substring(1))); } else { keyMap.set(idx, key); }
      if (typeof url === "string" && /^u\d+$/.test(url)) { url = urlMap.get(parseInt(url.substring(1))); } else { urlMap.set(idx, url); }
      configs.push({
        name: raw[`n${idx}`],
        key,
        authVar: raw[`a${idx}`] || 'ANTHROPIC_AUTH_TOKEN',
        baseUrl: url,
        model: raw[`m${idx}`],
        defaultHaikuModel: raw[`h${idx}`],
        defaultSonnetModel: raw[`s${idx}`],
        defaultOpusModel: raw[`o${idx}`],
        subagentModel: raw[`g${idx}`],
      });
    });

    const DB_PREFIX = "ccswitch_config_";
    let ok = 0, fail = 0;
    for (const c of configs) {
      if (!c.name || !c.key) { fail++; continue; }
      const doc = {
        _id: DB_PREFIX + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
        name: c.name.trim(),
        key: window.services.encryptKey(c.key),
        authVar: c.authVar || 'ANTHROPIC_AUTH_TOKEN',
        baseUrl: c.baseUrl?.trim() || "",
        model: c.model?.trim() || "",
        defaultHaikuModel: c.defaultHaikuModel?.trim() || "",
        defaultSonnetModel: c.defaultSonnetModel?.trim() || "",
        defaultOpusModel: c.defaultOpusModel?.trim() || "",
        subagentModel: c.subagentModel?.trim() || "",
        updatedAt: Date.now(),
      };
      window.utools.db.put(doc).ok ? ok++ : fail++;
    }
    loadSavedConfigs();
    showImportStringDialog.value = false;
    ok > 0 && fail === 0
      ? MessagePlugin.success(t("claude.config.importSuccess", { count: ok }))
      : ok > 0
        ? MessagePlugin.warning(t("claude.config.importPartial", { ok, fail }))
        : MessagePlugin.error(t("claude.config.importFailed"));
  };

  return {
    showImportStringDialog,
    importString,
    handleExportAsString,
    openImportStringDialog,
    handleImportFromString,
  };
}
