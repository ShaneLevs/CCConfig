// 安全出站请求：只允许公网 http/https，拒绝回环/内网地址和跨协议降级。
//
// 渲染层可以传 baseUrl 给 fetchProviderModels，并会在请求头里带用户的 API Key。
// 如果直接请求，renderer 就能借助 preload 访问本机端口、云元数据或内网服务，
// 因此这里把 URL 校验、DNS 解析和重定向校验集中到一个入口。
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const { t } = require("./i18n");

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 10_000;

const _stripBrackets = (host) => String(host || "").replace(/^\[|\]$/g, "");

const _ipv4Parts = (ip) => {
  const parts = String(ip).split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
};

const isPrivateIpv4 = (ip) => {
  const p = _ipv4Parts(ip);
  if (!p) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved
  return false;
};

const isPrivateIpv6 = (ip) => {
  const value = String(ip || "").toLowerCase().split("%")[0];
  if (value === "::" || value === "::1") return true;
  // IPv4-mapped IPv6: ::ffff:127.0.0.1
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const first = value.split(":")[0];
  if (!first) return true;
  const firstByte = parseInt(first.slice(0, 2), 16);
  if (Number.isNaN(firstByte)) return true;
  if ((firstByte & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (firstByte === 0xfe && /^fe[89ab]/.test(first)) return true; // fe80::/10
  if ((firstByte & 0xff) === 0xff) return true; // ff00::/8 multicast
  return false;
};

const isPrivateIp = (ip) => {
  const kind = net.isIP(_stripBrackets(ip));
  if (kind === 4) return isPrivateIpv4(_stripBrackets(ip));
  if (kind === 6) return isPrivateIpv6(_stripBrackets(ip));
  return true;
};

const _invalidUrl = () => new Error(t("service.common.invalidUrl"));
const _blockedAddress = () => new Error(t("service.common.blockedAddress"));

/** 解析并校验 URL；返回标准 URL 对象。 */
const assertSafeUrl = (input) => {
  let raw = String(input == null ? "" : input).trim();
  if (!raw) throw _invalidUrl();
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw _invalidUrl();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw _invalidUrl();
  if (url.username || url.password) throw _invalidUrl();
  const host = _stripBrackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) throw _blockedAddress();
  if (net.isIP(host) && isPrivateIp(host)) throw _blockedAddress();
  return url;
};

/**
 * dns.lookup wrapper：所有解析结果都必须通过内网校验。
 * 使用 http(s).request 的 lookup 选项，让连接复用这里校验过的地址。
 */
const safeLookup = (hostname, options, callback) => {
  const requestAll = !!(options && options.all);
  dns.lookup(hostname, { ...(options || {}), all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length) return callback(new Error(t("service.common.blockedAddress")));
    for (const item of list) {
      if (isPrivateIp(item.address)) return callback(_blockedAddress());
    }
    if (requestAll) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
};

const _requestOnce = (url, options, deadline, redirectsLeft) => new Promise((resolve, reject) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return reject(new Error(t("service.common.requestTimeout")));
  const transport = url.protocol === "https:" ? https : http;
  const headers = { ...(options.headers || {}) };
  // request 自己会生成 host；这里显式填充，兼容部分中转站
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "host")) {
    headers.host = url.host;
  }
  const req = transport.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method || "GET",
      headers,
      lookup: safeLookup,
      servername: url.protocol === "https:" ? _stripBrackets(url.hostname) : undefined,
      timeout: Math.min(remaining, options.timeout || DEFAULT_TIMEOUT),
    },
    (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error(t("service.common.tooManyRedirects")));
        let next;
        try {
          next = assertSafeUrl(new URL(location, url).toString());
        } catch (e) {
          return reject(e);
        }
        if (url.protocol === "https:" && next.protocol === "http:") {
          return reject(new Error(t("service.common.invalidUrl")));
        }
        const nextHeaders = { ...headers };
        if (next.origin !== url.origin) {
          for (const key of Object.keys(nextHeaders)) {
            const lower = key.toLowerCase();
            if (lower === "authorization" || lower === "x-api-key") delete nextHeaders[key];
          }
        }
        return resolve(_requestOnce(next, { ...options, headers: nextHeaders }, deadline, redirectsLeft - 1));
      }
      let body = "";
      let bytes = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > (options.maxBytes || MAX_BYTES)) {
          req.destroy(new Error(t("service.common.responseTooLarge")));
          return;
        }
        body += chunk;
      });
      res.on("end", () => resolve({ status, headers: res.headers, body, url: url.toString() }));
      res.on("error", reject);
    },
  );
  req.on("error", reject);
  req.on("timeout", () => req.destroy(new Error(t("service.common.requestTimeout"))));
  if (options.body) req.write(options.body);
  req.end();
});

/** GET/POST 文本请求，自动校验每次重定向。 */
const guardedRequest = (input, options = {}) => {
  const url = assertSafeUrl(input);
  const deadline = Date.now() + (options.timeout || DEFAULT_TIMEOUT);
  return _requestOnce(url, options, deadline, options.maxRedirects == null ? MAX_REDIRECTS : options.maxRedirects);
};

/** GET JSON，非 2xx 抛错；返回解析后的 JSON。 */
const guardedJsonRequest = async (input, options = {}) => {
  const res = await guardedRequest(input, options);
  const contentType = String((res.headers && res.headers["content-type"]) || "").toLowerCase();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}${contentType ? ` (${contentType.split(";")[0]})` : ""}`);
  }
  if (contentType && !contentType.includes("json")) {
    throw new Error(`HTTP ${res.status} (${contentType.split(";")[0]})`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(t("serviceAgent.pi.invalidResponse"));
  }
};

module.exports = {
  MAX_REDIRECTS,
  isPrivateIp,
  assertSafeUrl,
  safeLookup,
  guardedRequest,
  guardedJsonRequest,
};
