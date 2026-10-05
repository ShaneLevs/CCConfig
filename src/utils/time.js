/**
 * Format a timestamp as a relative time string (Chinese locale).
 * @param {number|null} timestamp - Unix timestamp in milliseconds
 * @returns {string}
 */
export function formatLastUsed(timestamp) {
  if (!timestamp) return "从未使用";
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return diffMinutes <= 1 ? "刚刚" : `${diffMinutes} 分钟前`;
    }
    return `${diffHours} 小时前`;
  } else if (diffDays === 1) return "昨天";
  else if (diffDays < 7) return `${diffDays} 天前`;
  else if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前`;
  else return date.toLocaleDateString("zh-CN");
}

/**
 * Format a timestamp as a short relative time string（插件安装/更新时间等）。
 * 非法时间戳原样返回。
 * @param {number|string} ts - Unix timestamp in milliseconds
 * @returns {string}
 */
export function formatRelativeTime(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  if (isNaN(date.getTime())) return ts;
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 30) return `${days} 天前`;
  return date.toLocaleDateString();
}
