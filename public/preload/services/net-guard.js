// 安全出站请求：默认只允许公网 http/https，拒绝回环/内网地址和跨协议降级。
//
// 渲染层可以传 baseUrl 给 fetchProviderModels，并会在请求头里带用户的 API Key。
// 如果直接请求，renderer 就能借助 preload 访问本机端口、云元数据或内网服务，
// 因此这里把 URL 校验、DNS 解析和重定向校验集中到一个入口。
// 用户填写的模型服务地址可能就在本机或内网，只有这类模型请求通过 allowPrivate
// 显式放行私有网段；云元数据、链路本地与保留地址始终拒绝。
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
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved
  return false;
};

// 把 IPv6 拆成 8 个 16 位整数；非法格式返回 null。支持 :: 压缩与内嵌 IPv4。
const _ipv6Hextets = (ip) => {
  let value = String(ip || "").toLowerCase().split("%")[0];
  if (!value.includes(":")) return null;
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const parts = _ipv4Parts(tail);
    if (!parts) return null;
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tailParts = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    const parsed = head.map((part) =>
      /^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN,
    );
    return parsed.some(Number.isNaN) ? null : parsed;
  }
  const fill = 8 - head.length - tailParts.length;
  if (fill < 1) return null;
  const parts = [...head, ...Array(fill).fill("0"), ...tailParts];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part)))
    return null;
  return parts.map((part) => parseInt(part, 16));
};

const isPrivateIpv6 = (ip) => {
  const h = _ipv6Hextets(ip);
  if (!h) return true;
  // ::/96（含 :: / ::1）以及 IPv4-compatible 地址
  if (
    h[0] === 0 &&
    h[1] === 0 &&
    h[2] === 0 &&
    h[3] === 0 &&
    h[4] === 0 &&
    h[5] === 0 &&
    h[6] === 0
  )
    return true;
  // IPv4-mapped IPv6: ::ffff:127.0.0.1 / ::ffff:7f00:1
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isPrivateIpv4(
      `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`,
    );
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x2002) {
    // 6to4: 2002:V4ADDR::/48，内嵌 IPv4 也必须校验
    return isPrivateIpv4(
      `${h[1] >> 8}.${h[1] & 255}.${h[2] >> 8}.${h[2] & 255}`,
    );
  }
  if (
    h[0] === 0x0064 &&
    h[1] === 0xff9b &&
    h[2] === 0 &&
    h[3] === 0 &&
    h[4] === 0 &&
    h[5] === 0
  ) {
    // NAT64 64:ff9b::/96：内嵌 IPv4 是公网才放行
    return isPrivateIpv4(
      `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`,
    );
  }
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 1) return true; // NAT64 local-use
  if (h[0] === 0x2001 && h[1] === 0x0000) return true; // Teredo
  return false;
};

const isPrivateIp = (ip) => {
  const kind = net.isIP(_stripBrackets(ip));
  if (kind === 4) return isPrivateIpv4(_stripBrackets(ip));
  if (kind === 6) return isPrivateIpv6(_stripBrackets(ip));
  return true;
};

const _ipv4FromHextets = (h) => `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;

// 允许模型服务使用的私有网段：回环、RFC1918、CGNAT（Tailscale 等）与 IPv6 ULA。
// 169.254/16、fe80::/10 等链路本地地址和云元数据地址不在其中，allowPrivate 也不放行。
const isPrivateNetworkIpv4 = (ip) => {
  const p = _ipv4Parts(ip);
  if (!p) return false;
  const [a, b] = p;
  if (a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return ip !== "100.100.100.200"; // 阿里云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
};

const isPrivateNetworkIpv6 = (ip) => {
  const h = _ipv6Hextets(ip);
  if (!h) return false;
  if (h.slice(0, 7).every((part) => part === 0) && h[7] === 1) return true; // ::1
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isPrivateNetworkIpv4(_ipv4FromHextets(h)); // IPv4-mapped
  }
  if ((h[0] & 0xfe00) === 0xfc00) {
    // AWS IPv6 元数据 fd00:ec2::254 与 ULA 同段，单独排除
    if (
      h[0] === 0xfd00 &&
      h[1] === 0x0ec2 &&
      h[2] === 0 &&
      h[3] === 0 &&
      h[4] === 0 &&
      h[5] === 0 &&
      h[6] === 0 &&
      h[7] === 0x254
    )
      return false;
    return true;
  }
  return false;
};

const isPrivateNetworkIp = (ip) => {
  const value = _stripBrackets(ip);
  const kind = net.isIP(value);
  if (kind === 4) return isPrivateNetworkIpv4(value);
  if (kind === 6) return isPrivateNetworkIpv6(value);
  return false;
};

const _invalidUrl = () => new Error(t("service.common.invalidUrl"));
const _blockedAddress = () => new Error(t("service.common.blockedAddress"));

/**
 * 解析并校验 URL；返回标准 URL 对象。
 * options.allowPrivate 仅供用户填写的模型服务地址使用。
 */
const assertSafeUrl = (input, options = {}) => {
  const allowPrivate = !!(options && options.allowPrivate);
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
  if (!host) throw _blockedAddress();
  if (host === "localhost" || host.endsWith(".localhost")) {
    if (allowPrivate) return url;
    throw _blockedAddress();
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    if (allowPrivate && isPrivateNetworkIp(host)) return url;
    throw _blockedAddress();
  }
  return url;
};

/**
 * dns.lookup wrapper：所有解析结果都必须通过内网校验。
 * 使用 http(s).request 的 lookup 选项，让连接复用这里校验过的地址。
 * allowPrivate 为 true 时只放行模型服务可用的私有网段。
 */
const safeLookup = (hostname, options, callback, allowPrivate = false) => {
  const requestAll = !!(options && options.all);
  dns.lookup(hostname, { ...(options || {}), all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length) return callback(new Error(t("service.common.blockedAddress")));
    for (const item of list) {
      if (isPrivateIp(item.address) && !(allowPrivate && isPrivateNetworkIp(item.address))) {
        return callback(_blockedAddress());
      }
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
      lookup: (hostname, lookupOptions, callback) =>
        safeLookup(hostname, lookupOptions, callback, !!options.allowPrivate),
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
          next = assertSafeUrl(new URL(location, url).toString(), {
            allowPrivate: options.allowPrivate,
          });
        } catch (e) {
          return reject(e);
        }
        if (url.protocol === "https:" && next.protocol === "http:") {
          return reject(new Error(t("service.common.invalidUrl")));
        }
        const nextHeaders = { ...headers };
        // 重定向后 Host 必须按新 URL 重新生成，不能沿用上一跳
        for (const key of Object.keys(nextHeaders)) {
          if (key.toLowerCase() === "host") delete nextHeaders[key];
        }
        if (next.origin !== url.origin) {
          for (const key of Object.keys(nextHeaders)) {
            const lower = key.toLowerCase();
            if (
              lower === "authorization" ||
              lower === "x-api-key" ||
              lower === "x-goog-api-key" ||
              lower === "cookie" ||
              lower === "proxy-authorization"
            )
              delete nextHeaders[key];
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
  const url = assertSafeUrl(input, options);
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
