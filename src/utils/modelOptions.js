// TDesign AutoComplete 用 option.text 作为选中后写回输入框的值，label 只用于下拉展示。
// 模型接口里的 name 是展示名，必须把 id 放进 text，否则选中后会把名称写进模型 ID。
export const toModelAutoCompleteOptions = (models) =>
  (models || [])
    .filter((m) => m && m.id != null && String(m.id).trim())
    .map((m) => {
      const id = String(m.id);
      const name = m.name && String(m.name) !== id ? String(m.name) : "";
      return {
        label: name ? `${name} · ${id}` : id,
        text: id,
        value: id,
      };
    });

// AutoComplete 的 filterable 只按 text（模型 ID）匹配；同时支持用展示名搜索。
export const filterModelOption = (input, option) => {
  const keyword = String(input || "").trim().toLowerCase();
  if (!keyword) return true;
  return (
    String(option?.text || "").toLowerCase().includes(keyword) ||
    String(option?.label || "").toLowerCase().includes(keyword)
  );
};
