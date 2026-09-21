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
    if (size > limit) throw new Error("上游响应体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

// 流式转发：消费上游响应并把重写后的 SSE 帧写到客户端响应
// upstreamRes: 上游 IncomingMessage（已 200）；target: 出站适配器；source: 入站适配器；res: 客户端 ServerResponse
const pipeStream = async ({ upstreamRes, target, source, res }) => {
  res.writeHead(200, sseHeaders());
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const writer = source.createFrameWriter();
  try {
    for await (const event of target.readStream(upstreamRes)) {
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
    for (const frame of writer.push({ type: "error", message: (e && e.message) || "上游流中断" })) {
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
};

module.exports = { pipeStream, collectBody, sseHeaders };
