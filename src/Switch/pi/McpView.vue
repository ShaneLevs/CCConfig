<script setup>

import { ref, onMounted } from "vue";
import {
  Card, Empty, Tag, Button, Tooltip, MessagePlugin,
} from "tdesign-vue-next";
import { RefreshIcon } from "tdesign-icons-vue-next";
import "./styles/McpView.css";

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
    MessagePlugin.success("名称已复制");
  } catch { MessagePlugin.error("复制失败"); }
};

// 状态 Tag 映射
const stateMeta = (srv) => {
  if (srv.enabled === false) return { theme: "default", label: "已禁用" };
  switch (srv.state) {
    case "connected": return { theme: "success", label: "已连接" };
    case "needs_login": return { theme: "warning", label: "待登录" };
    case "needs_auth": return { theme: "warning", label: "待登录" };
    case "disconnected": return { theme: "danger", label: "已断开" };
    case "error": return { theme: "danger", label: "错误" };
    default: return { theme: "default", label: srv.state || "未知" };
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

const toolsCountText = (srv) => `${srv.tools?.length || 0} 个工具`;

onMounted(() => {
  loadServers().finally(() => { loading.value = false; });
});

</script>

<template>
  <div class="pi-mcp-container">
    <div class="pi-mcp-header">
      <span class="pi-mcp-tip">
        Pi Agent MCP 服务器（~/.pi/agent/mcp.json 与受信项目 .pi/mcp.json）— 通过
        <code class="hint-link" @click="openPiConfig">pi mcp</code> 管理
      </span>
      <Tooltip content="刷新（pi mcp list --json）" placement="top">
        <Button size="small" variant="outline" :loading="loading" @click="refresh">
          <template #icon><RefreshIcon /></template>
        </Button>
      </Tooltip>
    </div>

    <div v-if="loading" class="pi-mcp-empty">
      <Empty description="正在通过 pi mcp list 读取配置..." />
    </div>

    <div v-else-if="servers.length === 0" class="pi-mcp-empty">
      <Empty description="未发现 MCP 服务器，可用 pi mcp add 添加" />
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
            <Tooltip content="点击复制名称" placement="top">
              <span class="pi-mcp-srv-name" @click.stop="copyMcpName(srv.serverName)">{{ srv.serverName }}</span>
            </Tooltip>
            <Tag size="small" variant="light" :theme="stateMeta(srv).theme">{{ stateMeta(srv).label }}</Tag>
            <Tag size="small" variant="outline" theme="default">{{ srv.scope === 'local' ? '项目' : '全局' }}</Tag>
          </div>
        </template>

        <div class="pi-mcp-card-body">
          <div class="pi-mcp-info-row">
            <span class="pi-mcp-label">传输</span>
            <span class="pi-mcp-value mono">{{ transportShort(srv) }}</span>
          </div>
          <div class="pi-mcp-info-row">
            <span class="pi-mcp-label">配置来源</span>
            <span class="pi-mcp-value mono">{{ srv.source || '—' }}</span>
          </div>
          <div class="pi-mcp-info-row">
            <span class="pi-mcp-label">暴露模式</span>
            <span class="pi-mcp-value">{{ exposureLabel(srv) }}</span>
          </div>
          <div class="pi-mcp-info-row pi-mcp-tools-row">
            <span class="pi-mcp-label">工具 ({{ toolsCountText(srv) }})</span>
            <span class="pi-mcp-value mono">{{ toolsText(srv) }}</span>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
