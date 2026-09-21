import { ref } from 'vue'

// 自动网关「开启」状态（模块级共享，模式同 useAppContext）：
// index.vue 顶部「网关」tab 按钮据此显示绿点标识；
// AutoRouteView 在配置加载 / 开关切换时刷新，插件每次进入时由 index.vue 从 DB 重读。
const autoRouteEnabled = ref(false)

export function useAutoRouteStatus() {
  const refreshAutoRouteEnabled = () => {
    try {
      const config = window.services.readAutoRouteConfig()
      autoRouteEnabled.value = !!(config && config.enabled)
    } catch (e) {
      /* 读取失败保持原值 */
    }
  }

  return { autoRouteEnabled, refreshAutoRouteEnabled }
}
