// 数字缩写展示（模型上下文窗口 / 最大输出等）：0/空 → 「默认」，≥1M → x.xM，≥1K → x.xK
export const formatNumber = (n) => {
  if (!n) return '默认';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
};
