<script setup>
import { ref } from "vue";
import { Dialog, Input, Button, RadioGroup, Radio, RadioButton, CheckboxGroup, Checkbox, Textarea, MessagePlugin } from "tdesign-vue-next";
import DynamicKvEditor from "./DynamicKvEditor.vue";

// 通用 MCP 服务器添加/编辑弹窗（表单 + JSON 双模式）
// 用法：
//   <McpServerDialog ref="d" :header-prefix="'本地 · '" :name-disabled-on-edit="false" @save="handleSave" />
//   d.open('create')                      打开空白弹窗
//   d.open('edit', name, config)          带初始值打开编辑弹窗
//   父组件在 @save 收到 { mode, name, config }，保存成功后调用 d.close()
// props：
//   headerPrefix          弹窗标题前缀（如「本地 · 」），默认空
//   nameDisabledOnEdit    编辑时名称是否禁用（common 按名 upsert 需禁用；claude 支持改名）
//   showTarget            是否显示「本地/云端」目标多选（common 合并列表用），默认 false
//   targetOptions         目标选项 [{ value, label }]，默认 [本地, 云端]
//   open(mode, name, config, target) 的 target 为初始选中端（数组，也兼容单值字符串）
//   @save 事件里 target 统一为选中端数组（claude 等不启用 showTarget 的使用方可忽略）

const props = defineProps({
  headerPrefix: { type: String, default: "" },
  nameDisabledOnEdit: { type: Boolean, default: false },
  showTarget: { type: Boolean, default: false },
  targetOptions: {
    type: Array,
    default: () => [
      { value: 'local', label: '本地' },
      { value: 'cloud', label: '云端' },
    ],
  },
});

const emit = defineEmits(["save"]);

const showDialog = ref(false);
const dialogMode = ref('create'); // create | edit
const dialogTarget = ref(['local', 'cloud']); // 保存目标端数组（showTarget 时多选；新建默认两端全勾）
const mcpName = ref('');
const mcpType = ref('stdio');
const mcpCommand = ref('');
const mcpArgsText = ref('');
const mcpUrl = ref('');
const mcpEnv = ref([]);
const mcpHeaders = ref([]);

// 编辑模式：form 表单 / json 直接编辑（双向同步）
const editMode = ref('form');
const jsonContent = ref('');
const jsonError = ref('');

// 表单 → config 对象（提交 + syncFormToJson 共用）
const buildConfigFromForm = () => {
  const config = {};
  if (mcpType.value === 'http') {
    config.type = 'http';
    if (mcpUrl.value.trim()) config.url = mcpUrl.value.trim();
    const headersObj = {};
    (mcpHeaders.value || []).forEach(({ key, value }) => {
      if (key && key.trim()) headersObj[key.trim()] = value;
    });
    if (Object.keys(headersObj).length) config.headers = headersObj;
  } else {
    config.type = 'stdio';
    if (mcpCommand.value.trim()) config.command = mcpCommand.value.trim();
    const args = mcpArgsText.value.trim().split(/\s+/).filter(Boolean);
    if (args.length) config.args = args;
    const envObj = {};
    (mcpEnv.value || []).forEach(({ key, value }) => {
      if (key && key.trim()) envObj[key.trim()] = value;
    });
    if (Object.keys(envObj).length) config.env = envObj;
  }
  return config;
};

// 表单字段 → JSON 字符串
const syncFormToJson = () => {
  jsonContent.value = JSON.stringify(buildConfigFromForm(), null, 2);
  jsonError.value = '';
};

// config 对象 → 表单字段
const applyConfigToForm = (config) => {
  mcpType.value = (config.type === 'http' || config.url) ? 'http' : 'stdio';
  mcpCommand.value = config.command || '';
  mcpArgsText.value = (Array.isArray(config.args) ? config.args.join(' ') : '') || '';
  mcpUrl.value = config.url || '';
  mcpEnv.value = config.env ? Object.entries(config.env).map(([k, v]) => ({ key: k, value: v })) : [];
  mcpHeaders.value = config.headers ? Object.entries(config.headers).map(([k, v]) => ({ key: k, value: v })) : [];
};

// 切换编辑模式：成功才改 editMode，失败保持原模式
const switchEditMode = (mode) => {
  if (mode === editMode.value) return;
  if (mode === 'json') {
    syncFormToJson();
    editMode.value = mode;
  } else {
    try {
      const config = JSON.parse(jsonContent.value || '{}');
      applyConfigToForm(config);
      jsonError.value = '';
      editMode.value = mode;
    } catch (e) {
      jsonError.value = 'JSON 解析失败: ' + e.message;
      MessagePlugin.error('JSON 解析失败，无法切回表单: ' + e.message);
    }
  }
};

const open = (mode, name, config, target) => {
  dialogMode.value = mode === 'edit' ? 'edit' : 'create';
  dialogTarget.value = Array.isArray(target) ? [...target] : (target ? [target] : ['local', 'cloud']);
  mcpName.value = (mode === 'edit' && name) ? name : '';
  if (config && typeof config === 'object') {
    applyConfigToForm(config);
  } else {
    mcpType.value = 'stdio';
    mcpCommand.value = '';
    mcpArgsText.value = '';
    mcpUrl.value = '';
    mcpEnv.value = [];
    mcpHeaders.value = [];
  }
  editMode.value = 'form';
  jsonError.value = '';
  syncFormToJson();
  showDialog.value = true;
};

const close = () => {
  showDialog.value = false;
};

const useStdioTemplate = () => {
  mcpType.value = 'stdio';
  mcpCommand.value = 'npx';
  mcpArgsText.value = '-y @modelcontextprotocol/server-filesystem /path/to/files';
  syncFormToJson();
};

const useHttpTemplate = () => {
  mcpType.value = 'http';
  mcpUrl.value = 'http://localhost:3000/mcp';
  syncFormToJson();
};

const submit = () => {
  const name = mcpName.value.trim();
  if (!name) { MessagePlugin.warning('请输入服务器名称'); return; }
  if (props.showTarget && !dialogTarget.value.length) {
    MessagePlugin.warning('请至少勾选一个保存位置');
    return;
  }
  let config;
  if (editMode.value === 'json') {
    try {
      config = JSON.parse(jsonContent.value || '{}');
    } catch (e) {
      jsonError.value = 'JSON 格式错误: ' + e.message;
      MessagePlugin.error('JSON 格式错误: ' + e.message);
      return;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      MessagePlugin.warning('JSON 内容必须是对象');
      return;
    }
  } else {
    config = buildConfigFromForm();
    if (config.type === 'http' && !config.url) { MessagePlugin.warning('请输入 HTTP URL'); return; }
    if (config.type === 'stdio' && !config.command) { MessagePlugin.warning('请输入启动命令'); return; }
  }
  emit('save', { mode: dialogMode.value, name, config, target: dialogTarget.value });
};

defineExpose({ open, close });
</script>

<template>
  <Dialog
    v-model:visible="showDialog"
    :header="`${headerPrefix}${dialogMode === 'create' ? '添加' : '编辑'} MCP 服务器`"
    width="600px"
  >
    <div class="mcp-dialog-form">
      <div v-if="showTarget" class="mcp-dialog-form-item">
        <label>保存到 <span class="mcp-dialog-required">*</span></label>
        <CheckboxGroup v-model="dialogTarget">
          <Checkbox
            v-for="opt in targetOptions"
            :key="opt.value"
            :value="opt.value"
          >{{ opt.label }}</Checkbox>
        </CheckboxGroup>
      </div>

      <div class="mcp-dialog-form-item">
        <label>名称 <span class="mcp-dialog-required">*</span></label>
        <Input
          v-model="mcpName"
          placeholder="例如: my-mcp-server"
          :disabled="nameDisabledOnEdit && dialogMode === 'edit'"
        />
      </div>

      <div class="mcp-dialog-form-item">
        <label>编辑模式</label>
        <RadioGroup :model-value="editMode" variant="default-filled" @change="(v) => switchEditMode(v)">
          <RadioButton value="form">表单</RadioButton>
          <RadioButton value="json">JSON</RadioButton>
        </RadioGroup>
      </div>

      <template v-if="editMode === 'form'">
        <div class="mcp-dialog-form-item">
          <label>类型</label>
          <RadioGroup v-model="mcpType">
            <Radio value="stdio">STDIO</Radio>
            <Radio value="http">HTTP</Radio>
          </RadioGroup>
        </div>

        <div v-if="dialogMode === 'create'" class="mcp-dialog-template-buttons">
          <Button size="small" variant="outline" @click="useStdioTemplate">STDIO 模板</Button>
          <Button size="small" variant="outline" @click="useHttpTemplate">HTTP 模板</Button>
        </div>

        <template v-if="mcpType === 'stdio'">
          <div class="mcp-dialog-form-item">
            <label>启动命令 <span class="mcp-dialog-required">*</span></label>
            <Input v-model="mcpCommand" placeholder="例如: npx" />
          </div>
          <div class="mcp-dialog-form-item">
            <label>参数 (args，空格分隔)</label>
            <Textarea
              v-model="mcpArgsText"
              :autosize="{ minRows: 2, maxRows: 4 }"
              placeholder="例如: -y @modelcontextprotocol/server-filesystem /path/to/files"
            />
          </div>
          <div class="mcp-dialog-form-item">
            <label>环境变量 (env)</label>
            <DynamicKvEditor
              v-model="mcpEnv"
              key-placeholder="变量名"
              value-placeholder="变量值"
            />
          </div>
        </template>

        <template v-else>
          <div class="mcp-dialog-form-item">
            <label>HTTP URL <span class="mcp-dialog-required">*</span></label>
            <Input v-model="mcpUrl" placeholder="例如: http://localhost:3000/mcp" />
          </div>
          <div class="mcp-dialog-form-item">
            <label>请求头 (headers)</label>
            <DynamicKvEditor
              v-model="mcpHeaders"
              key-placeholder="Header 名"
              value-placeholder="Header 值"
            />
          </div>
        </template>
      </template>

      <template v-else>
        <div class="mcp-dialog-form-item">
          <label>配置内容 (JSON)</label>
          <Textarea
            v-model="jsonContent"
            :autosize="{ minRows: 12, maxRows: 20 }"
            :status="jsonError ? 'error' : 'default'"
            placeholder='{ "type": "stdio", "command": "npx", "args": ["-y", "..."] }'
            class="mcp-dialog-json-textarea"
          />
          <div v-if="jsonError" class="mcp-dialog-json-error">{{ jsonError }}</div>
        </div>
      </template>
    </div>

    <template #footer>
      <div class="mcp-dialog-footer">
        <Button variant="outline" @click="close">取消</Button>
        <Button theme="primary" @click="submit">
          {{ dialogMode === 'create' ? '添加' : '保存' }}
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.mcp-dialog-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.mcp-dialog-form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mcp-dialog-form-item > label {
  font-size: 13px;
  color: var(--td-text-color-primary);
  font-weight: 500;
}

.mcp-dialog-required {
  color: var(--td-error-color);
}

.mcp-dialog-template-buttons {
  display: flex;
  gap: 8px;
}

/* 单选组保持 TDesign 原生样式与间距，不额外覆盖 */

.mcp-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.mcp-dialog-json-textarea textarea,
.mcp-dialog-json-textarea .t-textarea__wrapper {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
}

.mcp-dialog-json-error {
  font-size: 12px;
  color: var(--td-error-color);
  margin-top: 4px;
  word-break: break-all;
}
</style>
