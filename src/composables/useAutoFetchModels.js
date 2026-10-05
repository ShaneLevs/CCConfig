import { ref, computed } from "vue";

// 「自动拉取模型列表」共享逻辑：调用 window.services.fetchProviderModels
// （OpenAI 兼容 /models 接口），供各应用的添加/批量添加模型弹窗复用。
export function useAutoFetchModels() {
  const autoModels = ref([]);
  const autoModelsLoading = ref(false);
  const autoModelsError = ref("");

  // AutoComplete 下拉选项（显示名 → 模型 ID）
  const modelOptions = computed(() =>
    autoModels.value.map(m => ({ label: m.name || m.id, value: m.id }))
  );

  // prov 需为 { baseUrl, apiKey } 形状的供应商对象
  const fetchAutoModels = async (prov) => {
    if (!prov || !prov.baseUrl) {
      autoModelsError.value = "该供应商未配置 Base URL，无法自动获取";
      return;
    }
    autoModelsLoading.value = true;
    autoModelsError.value = "";
    try {
      const list = await window.services.fetchProviderModels(prov.baseUrl, prov.apiKey);
      autoModels.value = list;
      if (list.length === 0) autoModelsError.value = "接口返回空列表";
    } catch (e) {
      autoModelsError.value = e.message;
      autoModels.value = [];
    } finally {
      autoModelsLoading.value = false;
    }
  };

  const resetAutoModels = () => {
    autoModels.value = [];
    autoModelsLoading.value = false;
    autoModelsError.value = "";
  };

  // 拉取结果回填表单（id / 名称 / 上下文 / 最大输出 / 推理）
  const applyAutoModel = (m, form) => {
    form.value = {
      ...form.value,
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.contextWindow || 0,
      maxTokens: m.maxTokens || 0,
      reasoning: !!m.reasoning,
    };
  };

  // 从下拉选中模型：自动带出名称/上下文/输出/推理
  const onModelIdSelect = (val, form) => {
    const m = autoModels.value.find(x => x.id === val);
    if (m) applyAutoModel(m, form);
  };

  return {
    autoModels,
    autoModelsLoading,
    autoModelsError,
    modelOptions,
    fetchAutoModels,
    resetAutoModels,
    applyAutoModel,
    onModelIdSelect,
  };
}
