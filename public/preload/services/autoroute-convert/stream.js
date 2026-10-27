// 自动网关 · 流式管道
// 上游 SSE → target.readStream（canonical 事件流）→ source.createFrameWriter（入站协议帧）→ 客户端
// 非流式路径不经过本模块（server 直接 buffer + parse/format）。

const sseHeaders = () => ({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
});

// 读取上游响应体为字符串（非流式路径用）
const collectBody = async (res, limit = 32 * 1024 * 1024) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) throw new Error("Upstream response body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

// 流式转发：消费上游响应并把重写后的 SSE 帧写到客户端响应。
// 返回规范 end 事件里的 usage（供网关统计），无则 null。
// upstreamRes: 上游 IncomingMessage（已 200）；target: 出站适配器；source: 入站适配器；res: 客户端 ServerResponse
// onClientGone: 客户端提前断开时回调（上游随之被中止，统计侧据此记 499）
const pipeStream = async ({ upstreamRes, target, source, res, onClientGone }) => {
  // 客户端在等待上游响应头的这段时间里已经断开：直接释放上游，别往销毁的 socket 写
  if (res.destroyed || res.writableEnded) {
    try {
      upstreamRes.destroy();
    } catch (e) {
      /* ignore */
    }
    if (typeof onClientGone === "function") onClientGone();
    return null;
  }
  res.writeHead(200, sseHeaders());
  let closed = false;
  res.on("close", () => {
    if (closed || res.writableFinished) return;
    closed = true;
    // 客户端断了就把上游也断开，别让它继续跑完白烧 token
    try {
      if (upstreamRes && typeof upstreamRes.destroy === "function") upstreamRes.destroy();
    } catch (e) {
      /* ignore */
    }
    if (typeof onClientGone === "function") onClientGone();
  });
  const writer = source.createFrameWriter();
  let endUsage = null;
  try {
    for await (const event of target.readStream(upstreamRes)) {
      if (event.type === "end" && event.usage) endUsage = event.usage;
      if (closed) break;
      for (const frame of writer.push(event)) {
        if (!closed) res.write(frame);
      }
    }
    for (const frame of writer.finish()) {
      if (!closed) res.write(frame);
    }
  } catch (e) {
    // 上游中途异常：尽力补一帧错误后收尾，避免客户端悬挂
    for (const frame of writer.push({ type: "error", message: (e && e.message) || "Upstream stream interrupted" })) {
      if (!closed) res.write(frame);
    }
    for (const frame of writer.finish()) {
      if (!closed) res.write(frame);
    }
  } finally {
    if (!closed) res.end();
    // 确保上游连接释放
    if (upstreamRes && typeof upstreamRes.destroy === "function") upstreamRes.destroy();
  }
  return endUsage;
};

module.exports = { pipeStream, collectBody, sseHeaders };
