import { watch } from "vue";

// 进入配置页时默认展开第一个供应商。
// provider/model 形式的 agent 全部折叠时只剩一排标题，页面看起来像没有内容；
// 首次拿到非空供应商列表后展开第一个，之后用户手动折叠/展开不再干预。
export function useFirstProviderExpand(providers, expanded, getValue = (item) => item.id) {
  let expandedOnce = false;
  watch(
    providers,
    (list) => {
      if (expandedOnce || !list || list.length === 0) return;
      expandedOnce = true;
      expanded.value = [getValue(list[0])];
    },
    { immediate: true }
  );
}
