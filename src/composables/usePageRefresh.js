import { inject, nextTick, provide, ref, watch } from "vue";
import { useAppContext } from "./useAppContext";

const PAGE_CONTEXT = Symbol("ccconfig.pageContext");

// 自动刷新结束后至少保留的加载态时长：数据是同步读文件时刷新瞬间完成，
// 没有这段最短展示，右上角刷新按钮的 loading 会一闪而过甚至看不到。
const MIN_LOADING_MS = 400;

// index.vue 在 setup 中调用，把当前激活的 agent / 页签透传给所有页面视图。
export function providePageContext(activeTab) {
  const { activeApp } = useAppContext();
  provide(PAGE_CONTEXT, { activeApp, activeTab });
}

// 页面视图调用：切换到 app + tab 对应的页面时自动执行一次 refresh，
// 并在刷新期间（至少 MIN_LOADING_MS）把 autoRefreshing 置为 true，供刷新按钮绑定 loading。
// 返回 refreshNow 供没有自带加载态的页面把手动刷新也接到同一套反馈上。
export function usePageRefresh(app, tab, refresh) {
  const context = inject(PAGE_CONTEXT, null);
  const autoRefreshing = ref(false);
  let runId = 0;

  const refreshNow = async () => {
    const id = ++runId;
    autoRefreshing.value = true;
    const startedAt = Date.now();
    try {
      await refresh();
    } catch (e) {
      console.error(`自动刷新 ${app}:${tab} 失败:`, e);
    } finally {
      const remaining = MIN_LOADING_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      if (id === runId) autoRefreshing.value = false;
    }
  };

  if (context) {
    watch([context.activeApp, context.activeTab], async ([currentApp, currentTab]) => {
      if (currentApp !== app || currentTab !== tab) return;
      // 等父组件的 v-show / v-if 更新落地后再刷新，避免隐藏期间重复拉取。
      await nextTick();
      await refreshNow();
    });
  }

  return { autoRefreshing, refreshNow };
}
