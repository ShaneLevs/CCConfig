<script setup>

import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Card, Empty, Tag, Button, Tooltip, MessagePlugin,
} from "tdesign-vue-next";
import { RefreshIcon } from "tdesign-icons-vue-next";
import "./styles/McpView.css";

const { t } = useI18n();

const loading = ref(true);
const servers = ref([]);

const loadServers = async () => {
  try {
    servers.value = (await window.services.getPiMcpServers()) || [];
  } catch (e) {
    console.error("加载 Pi MCP 服务器失败:", e);
    servers.value = [];
  }
};

const refresh = () => {
  loading.value = true;
  loadServers().finally(() => { loading.value = false; });
};

const openPiConfig = () => {
  try {
    window.utools.shellOpenPath(window.services.resolvePiPath());
  } catch (e) {
    window.services.openPiDir();
  }
};

// 点击复制 MCP 名称
const copyMcpName = (name) => {
  try {
    window.utools.copyText(name);
    MessagePlugin.success(t("pi.mcp.nameCopied"));
  } catch { MessagePlugin.error(t("pi.mcp.copyFailed")); }
};

// 状态 Tag 映射
const stateMeta = (srv) => {
  if (srv.enabled === false) return { theme: "default", label: t("pi.mcp.state.disabled") };
  switch (srv.state) {
    case "connected": return { theme: "success", label: t("pi.mcp.state.connected") };
    case "needs_login": return { theme: "warning", label: t("pi.mcp.state.needsLogin") };
    case "needs_auth": return { theme: "warning", label: t("pi.mcp.state.needsLogin") };
    case "disconnected": return { theme: "danger", label: t("pi.mcp.state.disconnected") };
    case "error": return { theme: "danger", label: t("pi.mcp.state.error") };
    default: return { theme: "default", label: srv.state || t("pi.mcp.state.unknown") };
  }
};

const transportShort = (srv) => {
  if (srv.transport) return srv.transport;
  const c = srv.config || {};
  if (c.url) return c.url;
  return [c.command, ...(c.args || [])].filter(Boolean).join(" ");
};

const exposureLabel = (srv) => srv.exposure || "codemode";

const toolsText = (srv) => srv.tools?.length ? srv.tools.join(", ") : "—";

const toolsCountText = (srv) => t("pi.mcp.toolsCount", { count: srv.tools?.length || 0 });

onMounted(() => {
  loadServers().finally(() => { loading.value = false; });
});

</script>

<template>
  <div class="pi-mcp-container">
    <div class="pi-mcp-header">
      <span class="pi-mcp-tip">
        {{ t("pi.mcp.tipPrefix") }}<code class="hint-link" @click="openPiConfig">pi mcp</code>{{ t("pi.mcp.tipSuffix") }}
      </span>
      <Tooltip :content="t('pi.mcp.refresh')" placement="top">
        <Button size="small" variant="outline" :loading="loading" @click="refresh">
          <template #icon><RefreshIcon /></template>
        </Button>
      </Tooltip>
    </div>

    <div v-if="loading" class="pi-mcp-empty">
      <Empty :description="t('pi.mcp.loading')" />
    </div>

    <div v-else-if="servers.length === 0" class="pi-mcp-empty">
      <Empty :description="t('pi.mcp.empty')" />
    </div>

    <div v-else class="pi-mcp-list">
      <Card
        v-for="srv in servers"
        :key="srv.serverName + '@' + (srv.source || '')"
        :bordered="true"
        class="pi-mcp-card"
      >
        <template #title>
          <div class="pi-mcp-card-header">
            <Tooltip :content="t('pi.mcp.copyName')" placement="top">
              <span class="pi-mcp-srv-name" @click.stop="copyMcpName(srv.serverName)">{{ srv.serverName }}</span>
            </Tooltip>
            <Tag size="small" variant="light" :theme="stateMeta(srv).theme">{{ stateMeta(srv).label }}</Tag>
            <Tag size="small" variant="outline" theme="default">{{ srv.scope === 'local' ? t('pi.mcp.scopeProject') : t('pi.mcp.scopeGlobal') }}</Tag>
          </div>
        </template>

        <div class="pi-mcp-card-body">
          <div class="pi-mcp-info-row">
            <span class="pi-mcp-label">{{ t("pi.mcp.transport") }}</span>
            <span class="pi-mcp-value mono">{{ transportShort(srv) }}</span>
          </div>
          <div class="pi-mcp-info-row">
            <span class="pi-mcp-label">{{ t("pi.mcp.source") }}</span>
            <span class="pi-mcp-value mono">{{ srv.source || '—' }}</span>
          </div>
          <div class="pi-mcp-info-row">
            <span class="pi-mcp-label">{{ t("pi.mcp.exposure") }}</span>
            <span class="pi-mcp-value">{{ exposureLabel(srv) }}</span>
          </div>
          <div class="pi-mcp-info-row pi-mcp-tools-row">
            <span class="pi-mcp-label">{{ t("pi.mcp.tools", { count: toolsCountText(srv) }) }}</span>
            <span class="pi-mcp-value mono">{{ toolsText(srv) }}</span>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
