<script setup>

import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Space, Tooltip, MessagePlugin, Popconfirm,
  Dialog, Input, Select, Loading,
} from "tdesign-vue-next";
import {
  RefreshIcon, AddIcon, EditIcon, DeleteIcon, LoginIcon, LinkIcon, CheckCircleFilledIcon,
  FolderAddIcon, CloseIcon,
} from "tdesign-icons-vue-next";
import { useAppContext } from "../../composables/useAppContext";
import { usePageRefresh } from "../../composables/usePageRefresh";
import "./styles/SubscriptionsView.css";

const { t } = useI18n();

// activeTab 由 index.vue 传入（与 v-model:active-tab 同一个 ref），用来判断本页是否可见：
// 已访问的页签用 v-if + v-show 保持挂载，组件不重建，需要靠它触发重读。
const props = defineProps({
  activeTab: { type: String, default: "config" },
});

// 「订阅」：用户手动添加已订阅的第三方服务（目前是 open-design），插件用自己的登录态查用量。
// getSubscriptions() 返回的快照不含 Cookie 原文；Cookie 由 preload 从本机浏览器读一次、
// 加密存进 DB，之后刷新只读库。所以这里有两条不同的动作：
//   刷新用量 = 用已存的 Cookie 打接口（refreshSubscription）
//   重新登录 = 重新读浏览器 Cookie（reloginSubscription），只在登录态过期时需要

const items = ref([]);
const loading = ref(false);
const refreshingAll = ref(false);
const busyId = ref("");

const loadSubscriptions = () => {
  try {
    items.value = window.services.getSubscriptions() || [];
  } catch (e) {
    console.error("读取订阅列表失败:", e);
    items.value = [];
  }
};

// 进页面顺手刷新一遍（服务层有自己的 5 分钟节流，不会每次都打接口）
// 注意 refreshSubscriptions 是异步方法（桌面版 bridge 返回 Promise），必须 await。
const refreshAll = async (force = false) => {
  refreshingAll.value = true;
  try {
    items.value = (await window.services.refreshSubscriptions({ force })) || items.value;
  } catch (e) {
    MessagePlugin.error(t("commonApp.subscription.refreshFailed"));
    loadSubscriptions();
  } finally {
    refreshingAll.value = false;
  }
};

const refreshOne = async (item) => {
  busyId.value = item.id;
  try {
    await window.services.refreshSubscription(item.id);
    MessagePlugin.success(t("commonApp.subscription.refreshedToast"));
  } catch (e) {
    // 服务层已把失败原因写进 lastError，列表重新读一遍就能显示
    MessagePlugin.error(t(`commonApp.subscription.error.${e.code || "http"}`));
  } finally {
    busyId.value = "";
    loadSubscriptions();
  }
};

const relogin = async (item) => {
  // 手填过 Cookie 的订阅没有「可重新读取的浏览器登录态」→ 不去白扫一遍浏览器（还可能弹钥匙串框），
  // 直接打开编辑弹窗让用户重粘：这是这一类登录态唯一有效的续命方式。
  if (item.cookieSource === "manual") {
    openEdit(item);
    MessagePlugin.warning(t("commonApp.subscription.manualReloginHint"));
    return;
  }
  busyId.value = item.id;
  try {
    await window.services.reloginSubscription(item.id);
    MessagePlugin.success(t("commonApp.subscription.reloginToast"));
  } catch (e) {
    MessagePlugin.error(
      e.code === "not_found"
        ? t("commonApp.subscription.cookieNotFound")
        : t(`commonApp.subscription.error.${e.code || "http"}`),
    );
  } finally {
    busyId.value = "";
    loadSubscriptions();
  }
};

const removeItem = (item) => {
  try {
    items.value = window.services.deleteSubscription(item.id) || [];
    MessagePlugin.success(t("commonApp.subscription.deletedToast"));
  } catch (e) {
    MessagePlugin.error(t("common.deleteFailed"));
  }
};

// ==================== 添加 / 编辑弹窗 ====================

const dialogVisible = ref(false);
const editTarget = ref(null); // null = 新增
const form = ref({ provider: "open-design", label: "" });
const providers = ref([]);
// 手选的浏览器数据目录（浏览器清单之外的兜底，跟订阅一起存）
const formDirs = ref([]);
// 读取浏览器 Cookie 的结果：idle | reading | found | notfound | stored
const captureState = ref("idle");
const capturedCookie = ref("");
const capturedBrowser = ref("");
// 未命中时的具体原因，用于把「去点钥匙串允许」「换浏览器」等提示区分开
const captureReason = ref("");
// 手动粘贴的 Cookie 头（钥匙串授权拿不到、或想用别的机器的登录态时的兜底）。
// 非空即代表用户明确要覆盖：优先级高于自动读取的结果。
const manualCookie = ref("");

// 真正要存进订阅的 Cookie：手填优先，其次才是自动读取的结果
const effectiveCookie = computed(() => (manualCookie.value || "").trim() || capturedCookie.value);

// 手填框一改就同步状态：填了 → 手填；清空 → 回到浏览器读取 / 未找到（编辑时回到「沿用已保存」）
watch(manualCookie, (val) => {
  if ((val || "").trim()) {
    captureState.value = "manual";
  } else if (captureState.value === "manual") {
    captureState.value = capturedCookie.value ? "found" : editTarget.value ? "stored" : "notfound";
  }
});

const openAdd = () => {
  editTarget.value = null;
  form.value = { provider: providers.value[0]?.id || "open-design", label: "" };
  formDirs.value = [];
  capturedCookie.value = "";
  capturedBrowser.value = "";
  manualCookie.value = "";
  captureReason.value = "";
  captureState.value = "idle";
  dialogVisible.value = true;
  // 打开就自动试一次：大多数情况下用户浏览器还登着，省掉一次点击
  readCookie();
};

const openEdit = (item) => {
  editTarget.value = item;
  form.value = { provider: item.provider, label: item.label || "" };
  formDirs.value = Array.isArray(item.cookieDirs) ? [...item.cookieDirs] : [];
  capturedCookie.value = "";
  capturedBrowser.value = "";
  manualCookie.value = "";
  captureReason.value = "";
  // 编辑时默认沿用已存的登录态（不主动读浏览器，避开不必要的钥匙串弹窗）：
  // 想换登录态就点「重新读取」；过期了就直接当未找到处理。
  captureState.value = item.cookieExpired ? "notfound" : "stored";
  dialogVisible.value = true;
};

/**
 * 读本机浏览器 Cookie。
 * 服务层是同步的（几十毫秒，首次扫描或钥匙串弹窗可能到 20 秒），
 * 所以先让出一帧把 loading 画出来，避免点了没反应。
 */
const readCookie = () => {
  captureState.value = "reading";
  captureReason.value = "";
  setTimeout(() => {
    try {
      const res = window.services.captureSubscriptionCookie(form.value.provider, {
        customDirs: formDirs.value,
      }) || {};
      if (res.found) {
        capturedCookie.value = res.header;
        capturedBrowser.value = res.browser || "";
        // 备注名自动填入（用户仍可改）：没填过就用站点品牌名，不用用户自己想名字
        if (!form.value.label) form.value.label = providerLabelOf(form.value.provider);
      } else {
        capturedCookie.value = "";
        // 未命中原因：钥匙串被拒 > 应用绑定加密 > 环境不支持 > 普通未找到
        captureReason.value = res.keychainBlocked
          ? "keychain"
          : res.appBound
            ? "appBound"
            : res.supported === false
              ? "unsupported"
              : "";
      }
    } catch (e) {
      capturedCookie.value = "";
      console.error("读取登录态失败:", e);
    } finally {
      // 手填的 Cookie 优先于自动读取的结果：这时不需要「已从某浏览器读到」/「没找到」这类提示
      captureState.value = manualCookie.value.trim()
        ? "manual"
        : capturedCookie.value
          ? "found"
          : "notfound";
    }
  }, 30);
};

// 让用户手选浏览器数据目录（预置到 formDirs，读 Cookie 时优先用它）
const pickDir = async () => {
  try {
    const res = (await window.services.pickSubscriptionCookieDir()) || {};
    if (res.canceled) return;
    if (!res.ok) {
      MessagePlugin.error(t(`commonApp.subscription.${res.error === 'no_cookie_db' ? 'dirInvalid' : 'dirPickFailed'}`));
      return;
    }
    if (!formDirs.value.includes(res.dir)) formDirs.value = [...formDirs.value, res.dir];
    MessagePlugin.success(t('commonApp.subscription.dirPicked', { name: res.name || res.dir, count: res.dbCount || 1 }));
    readCookie();
  } catch (e) {
    MessagePlugin.error(t('commonApp.subscription.dirPickFailed'));
  }
};

const removeDir = (dir) => {
  formDirs.value = formDirs.value.filter((d) => d !== dir);
};

const openLogin = () => {
  window.services.openSubscriptionLogin(form.value.provider);
};

const saving = ref(false);

const submit = async () => {
  // 手填了 Cookie 就一定走「写入登录态」的分支（编辑时也一样：用户就是要换登录态）
  const cookie = effectiveCookie.value;
  if (editTarget.value && !cookie) {
    // 只改备注名 / 手选目录，不动 Cookie
    try {
      saving.value = true;
      await window.services.updateSubscription({
        id: editTarget.value.id,
        label: form.value.label,
        cookieDirs: formDirs.value,
      });
      MessagePlugin.success(t("commonApp.subscription.savedToast"));
      dialogVisible.value = false;
      loadSubscriptions();
    } catch (e) {
      MessagePlugin.error(t(`commonApp.subscription.error.${e.code || "http"}`));
    } finally {
      saving.value = false;
    }
    return;
  }
  saving.value = true;
  try {
    if (editTarget.value) {
      await window.services.updateSubscription({
        id: editTarget.value.id,
        label: form.value.label,
        cookie,
        cookieSource: cookie === capturedCookie.value ? capturedBrowser.value : "",
        cookieDirs: formDirs.value,
      });
      MessagePlugin.success(t("commonApp.subscription.savedToast"));
    } else {
      await window.services.addSubscription({
        provider: form.value.provider,
        label: form.value.label,
        cookie,
        cookieSource: cookie === capturedCookie.value ? capturedBrowser.value : "",
        cookieDirs: formDirs.value,
      });
      MessagePlugin.success(t("commonApp.subscription.addedToast"));
    }
    dialogVisible.value = false;
    await refreshAll(true);
  } catch (e) {
    MessagePlugin.error(t(`commonApp.subscription.error.${e.code || "http"}`));
  } finally {
    saving.value = false;
    loadSubscriptions();
  }
};

// ==================== 展示辅助 ====================

const providerOptions = computed(() =>
  providers.value.map((p) => ({ label: p.label, value: p.id })),
);

const windowName = (key) => {
  const known = ["session", "week"];
  return known.includes(key)
    ? t(`commonApp.subscription.window.${key}`)
    : t("commonApp.subscription.window.generic", { key });
};

// 备注名默认值 = 站点品牌名（用户仍可改）。读登录态成功后自动回填，省得用户自己想名字。
const providerLabelOf = (id) =>
  providers.value.find((p) => p.id === id)?.label || id || "";

// 「剩余」语义：用户关心的是还剩多少额度，不是已花掉多少。进度条同样按剩余画（越长 = 越充裕），
// 所以阈值要反过来：剩余 ≤10% 危险，≤30% 警告。
const remainingOf = (w) => {
  if (!w || !w.limitCredits) return 0;
  const used = Number(w.usedCredits) || 0;
  const limit = Number(w.limitCredits) || 0;
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((limit - used) / limit) * 100)));
};

const barTheme = (percent) => (percent <= 10 ? "danger" : percent <= 30 ? "warning" : "normal");

const usd = (credits, item) => {
  if (credits === null || credits === undefined) return "-";
  const rate = item?.snapshot?.creditsPerUsd || 10000;
  return `$${(credits / rate).toFixed(2)}`;
};

const resetText = (iso) => {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const minutes = Math.round((ts - Date.now()) / 60000);
  if (minutes <= 0) return t("commonApp.subscription.resetSoon");
  if (minutes < 60) return t("commonApp.subscription.resetInMinutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("commonApp.subscription.resetInHours", { n: hours });
  return t("commonApp.subscription.resetInDays", { n: Math.round(hours / 24) });
};

const dateText = (iso) => {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

const errorTextOf = (item) => {
  if (!item.lastError) return "";
  return t(`commonApp.subscription.error.${item.lastError}`);
};

// ==================== 重新读取数据的时机 ====================
// 本视图挂在 index.vue 的「已访问标签页」列表里，用 v-if + v-show 保持不销毁：
// onMounted 只跑一次，之后再回到本页不会重建组件。而托盘弹窗每次展开都会重读并刷新快照，
// 只存进 DB 不会通知到这里 —— 不主动重读就会出现「托盘已刷新、页面还是旧值」。
// 因此三处都要重读：① 页签变可见；② 窗口重新获得焦点 / 重新可见（从菜单栏弹窗点回主窗口、
// 或 Tauri 把隐藏的主窗口 show 出来）；③ 重新进入插件（uTools 版页面重建，走 onMounted）。
// 可见 / 聚焦只读库（便宜、不联网）——数据已经是共享的那份，重读就能看到托盘刷新的结果；
// 只有首次挂载才按 5 分钟节流打一次接口。
const ACTIVE_TAB = "subscription";
const { activeApp } = useAppContext();
const isVisible = computed(() => activeApp.value === "common" && props.activeTab === ACTIVE_TAB);

const reloadFromStore = () => loadSubscriptions();
const reloadWithRefresh = (force = false) => {
  loadSubscriptions();
  if (items.value.length) refreshAll(force);
};

// 页签变可见：先读库，再按服务层的 5 分钟节流打一次接口（与进页面同一套动作）。
// 切回本页时自动刷新，并让右上角刷新按钮保持加载态。
const { autoRefreshing, refreshNow } = usePageRefresh("common", "subscription", () => reloadWithRefresh(false));

// 窗口重新聚焦 / 重新可见：桌面版主窗口被托盘「打开主窗口」show 出来时 WebView 不重建，
// watch 不会触发，只能靠这两个事件补。
const onWindowWake = () => {
  if (isVisible.value) reloadFromStore();
};

onMounted(() => {
  try {
    providers.value = window.services.getSubscriptionProviders() || [];
  } catch (e) {
    providers.value = [{ id: "open-design", label: "Open Design" }];
  }
  refreshNow();
  window.addEventListener("focus", onWindowWake);
  document.addEventListener("visibilitychange", onWindowWake);
});

onUnmounted(() => {
  window.removeEventListener("focus", onWindowWake);
  document.removeEventListener("visibilitychange", onWindowWake);
});
</script>

<template>
  <div class="subs-container">
    <div class="subs-header">
      <span class="subs-tip">{{ t('commonApp.subscription.tip') }}</span>
      <Space size="small">
        <Button size="small" theme="primary" @click="openAdd">
          <template #icon><AddIcon /></template> {{ t('commonApp.subscription.add') }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="refreshingAll || autoRefreshing" @click="refreshAll(true)">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </Space>
    </div>

    <div v-if="!items.length" class="subs-empty">
      <Empty :description="t('commonApp.subscription.empty')">
        <template #action>
          <Button size="small" theme="primary" @click="openAdd">
            <template #icon><AddIcon /></template> {{ t('commonApp.subscription.add') }}
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else class="subs-list">
      <div v-for="item in items" :key="item.id" class="subs-card">
        <div class="subs-card-head">
          <div class="subs-card-title">
            <span class="subs-name">{{ item.label || item.providerLabel }}</span>
            <Tag v-if="item.label !== item.providerLabel" size="small" variant="light" theme="primary">{{ item.providerLabel }}</Tag>
            <Tag v-if="item.snapshot?.plan" size="small" variant="light">{{ item.snapshot.plan }}</Tag>
            <Tag v-if="item.cookieExpired" size="small" variant="light" theme="danger">
              {{ t('commonApp.subscription.expiredTag') }}
            </Tag>
          </div>
          <Space size="small">
            <Tooltip :content="t('common.refresh')" placement="top">
              <Button
                size="small"
                variant="text"
                theme="default"
                :loading="busyId === item.id"
                @click="refreshOne(item)"
              >
                <template #icon><RefreshIcon /></template>
              </Button>
            </Tooltip>
            <Tooltip :content="t('commonApp.subscription.relogin')" placement="top">
              <Button size="small" variant="text" theme="default" @click="relogin(item)">
                <template #icon><LoginIcon /></template>
              </Button>
            </Tooltip>
            <Tooltip :content="t('common.edit')" placement="top">
              <Button size="small" variant="text" theme="default" @click="openEdit(item)">
                <template #icon><EditIcon /></template>
              </Button>
            </Tooltip>
            <Popconfirm
              theme="danger"
              :content="t('commonApp.subscription.deleteConfirm')"
              @confirm="removeItem(item)"
            >
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" variant="text" theme="danger">
                  <template #icon><DeleteIcon /></template>
                </Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </div>

        <div v-if="item.snapshot" class="subs-meta">
          <span v-if="item.snapshot.account?.email">{{ item.snapshot.account.email }}</span>
          <span v-if="item.snapshot.periodEnd">
            {{ t('commonApp.subscription.period', { start: dateText(item.snapshot.periodStart), end: dateText(item.snapshot.periodEnd) }) }}
          </span>
          <span v-if="item.snapshot.cancelAtPeriodEnd" class="subs-warn">
            {{ t('commonApp.subscription.cancelAtPeriodEnd') }}
          </span>
        </div>

        <div v-if="item.snapshot?.windows?.length" class="subs-windows">
          <div v-for="w in item.snapshot.windows" :key="w.key" class="subs-window">
            <div class="subs-window-head">
              <span class="subs-window-name">{{ windowName(w.key) }}</span>
              <span class="subs-window-pct" :class="`is-${barTheme(remainingOf(w))}`">{{ t('commonApp.subscription.remainingShort', { percent: remainingOf(w) }) }}</span>
            </div>
            <div class="subs-bar">
              <div
                class="subs-bar-inner"
                :class="`is-${barTheme(remainingOf(w))}`"
                :style="{ width: `${remainingOf(w)}%` }"
              />
            </div>
            <div class="subs-window-foot">
              <span>{{ usd(w.usedCredits, item) }} / {{ usd(w.limitCredits, item) }}</span>
              <span v-if="w.resetsAt">{{ resetText(w.resetsAt) }}</span>
            </div>
          </div>
        </div>

        <div v-else class="subs-nodata">{{ t('commonApp.subscription.noSnapshot') }}</div>

        <div v-if="item.lastError" class="subs-error">
          {{ errorTextOf(item) }}
          <span v-if="item.cookieExpired" class="subs-error-hint">{{ t('commonApp.subscription.expiredHint') }}</span>
        </div>
      </div>
    </div>

    <!-- 添加 / 编辑 -->
    <Dialog
      v-model:visible="dialogVisible"
      :header="editTarget ? t('commonApp.subscription.editTitle') : t('commonApp.subscription.addTitle')"
      width="520px"
      :confirm-btn="{ content: t('common.save'), loading: saving, disabled: !editTarget && !effectiveCookie }"
      :cancel-btn="{ content: t('common.cancel') }"
      @confirm="submit"
    >
      <div class="subs-form">
        <div class="subs-form-item">
          <label class="subs-form-label">{{ t('commonApp.subscription.provider') }}</label>
          <Select
            v-model="form.provider"
            :options="providerOptions"
            :disabled="!!editTarget"
            :style="{ width: '100%' }"
            @change="readCookie"
          />
        </div>

        <div class="subs-form-item">
          <label class="subs-form-label">{{ t('commonApp.subscription.label') }}</label>
          <Input
            v-model="form.label"
            :placeholder="editTarget?.snapshot?.account?.email || t('commonApp.subscription.labelPlaceholder')"
          />
        </div>

        <div class="subs-form-item">
          <label class="subs-form-label">{{ t('commonApp.subscription.loginState') }}</label>
          <div class="subs-login-box">
            <div v-if="captureState === 'reading'" class="subs-login-line">
              <Loading size="14px" />
              <span>{{ t('commonApp.subscription.cookieReading') }}</span>
            </div>
            <div v-else-if="captureState === 'stored'" class="subs-login-line is-ok">
              <CheckCircleFilledIcon />
              <span>{{ t('commonApp.subscription.cookieStored') }}</span>
            </div>
            <div v-else-if="captureState === 'found'" class="subs-login-line is-ok">
              <CheckCircleFilledIcon />
              <span>{{ capturedBrowser
                ? t('commonApp.subscription.cookieFoundIn', { browser: capturedBrowser })
                : t('commonApp.subscription.cookieFound') }}</span>
            </div>
            <div v-else-if="captureState === 'manual'" class="subs-login-line is-ok">
              <CheckCircleFilledIcon />
              <span>{{ t('commonApp.subscription.cookieManual') }}</span>
            </div>
            <div v-else class="subs-login-line is-miss">
              <LinkIcon />
              <span>{{ t('commonApp.subscription.cookieNotFound') }}</span>
            </div>
            <div v-if="captureState === 'notfound' && captureReason" class="subs-login-reason">
              {{ t(`commonApp.subscription.${captureReason}Hint`) }}
            </div>
            <div class="subs-login-actions">
              <Button size="small" variant="outline" @click="readCookie">
                {{ t('commonApp.subscription.readCookie') }}
              </Button>
              <Button size="small" variant="outline" @click="openLogin">
                <template #icon><LoginIcon /></template> {{ t('commonApp.subscription.openLogin') }}
              </Button>
              <Button size="small" variant="outline" @click="pickDir">
                <template #icon><FolderAddIcon /></template> {{ t('commonApp.subscription.dirButton') }}
              </Button>
            </div>
            <div class="subs-dirs">
              <div class="subs-dirs-head">
                <span>{{ t('commonApp.subscription.dirTitle') }}</span>
                <span class="subs-dirs-hint">{{ formDirs.length ? '' : t('commonApp.subscription.dirEmpty') }}</span>
              </div>
              <div v-for="dir in formDirs" :key="dir" class="subs-dir-row">
                <Tooltip :content="dir" placement="top-left">
                  <span class="subs-dir-path">{{ dir }}</span>
                </Tooltip>
                <Button
                  size="small"
                  variant="text"
                  :title="t('commonApp.subscription.dirRemove')"
                  @click="removeDir(dir)"
                >
                  <template #icon><CloseIcon /></template>
                </Button>
              </div>
              <div class="subs-dirs-hint is-block">{{ t('commonApp.subscription.dirHint') }}</div>
            </div>
            <div class="subs-login-hint">{{ t('commonApp.subscription.loginHint') }}</div>
            <div class="subs-manual">
              <div class="subs-dirs-head">
                <span>{{ t('commonApp.subscription.manualTitle') }}</span>
                <Button size="small" variant="text" theme="primary" class="subs-manual-btn" @click="openLogin">
                  <template #icon><LinkIcon /></template>
                  {{ t('commonApp.subscription.manualHowto') }}
                </Button>
              </div>
              <Input
                v-model="manualCookie"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 4 }"
                :placeholder="t('commonApp.subscription.manualPlaceholder')"
              />
              <div class="subs-dirs-hint is-block">{{ t('commonApp.subscription.manualHint') }}</div>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  </div>
</template>
