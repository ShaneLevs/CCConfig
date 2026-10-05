// pi 扩展（packages）安装与 pi.dev 包市场：安装/卸载/一键更新走 pi CLI；
// pi.dev 无 JSON API，列表与详情页为 SSR HTML，这里做离线可重放的解析。
const https = require("node:https");

const { runPiCmd, PI_CMD_TIMEOUT } = require("./pi-common");

// ==================== Extensions (Packages) ====================

// pi.dev 包市场：拉取 /packages 并解析 SSR HTML
// 说明：pi.dev 无 JSON API，包列表为 SSR HTML；搜索/类型/排序/分页均为 GET 整页导航，
// 接口即 https://pi.dev/packages?sort=&name=&type=&page= ，可直接离线重放（不依赖浏览器）
const fetchPiDevPackages = (params = {}, redirects = 0) => {
  const { page = 1, name = "", type = "", sort = "downloads" } = params;
  const qs = [];
  if (sort && sort !== "downloads") qs.push("sort=" + encodeURIComponent(sort));
  if (name) qs.push("name=" + encodeURIComponent(name));
  if (type) qs.push("type=" + encodeURIComponent(type));
  if (page && Number(page) > 1)
    qs.push("page=" + encodeURIComponent(String(page)));
  const url = "https://pi.dev/packages" + (qs.length ? "?" + qs.join("&") : "");

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          accept: "text/html",
        },
        timeout: 15_000,
      },
      (res) => {
        // pi.dev 会对参数顺序做 302 规范化，跟随重定向（最多 3 次）
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirects >= 3) return reject(new Error("too many redirects"));
          const loc = res.headers.location;
          const next = loc.indexOf("://") >= 0 ? loc : "https://pi.dev" + loc;
          const nextParams = {};
          const qi = next.indexOf("?");
          if (qi >= 0) {
            for (const kv of next.slice(qi + 1).split("&")) {
              const eq = kv.indexOf("=");
              if (eq > 0)
                nextParams[decodeURIComponent(kv.slice(0, eq))] =
                  decodeURIComponent(kv.slice(eq + 1));
            }
          }
          return resolve(fetchPiDevPackages(nextParams, redirects + 1));
        }
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          try {
            resolve(parsePiDevPackagesHtml(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", function () {
      this.destroy();
      reject(new Error("timeout"));
    });
  });
};

const parsePiDevPackagesHtml = (html) => {
  let total = 0;
  const t = html.match(/packages-count">[^<]*\/\s*(\d+)/);
  if (t) total = parseInt(t[1], 10);

  let lastPage = 0;
  const pageLinks = [...html.matchAll(/href="\/packages[^"]*page=(\d+)"/g)];
  for (const pl of pageLinks)
    lastPage = Math.max(lastPage, parseInt(pl[1], 10));

  const items = [];
  const re =
    /<article class="surface-panel content-card"[^>]*data-package-card="true"([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const b = m[1];
    const name = (b.match(/data-package-name="([^"]*)"/) || [])[1] || "";
    if (!name) continue;
    const types = [
      ...b.matchAll(/class="meta-chip packages-badge" data-type="([^"]*)"/g),
    ].map((x) => x[1]);
    const downloads = parseInt(
      (b.match(/data-package-downloads="(\d+)"/) || [])[1] || "0",
      10,
    );
    const date = parseInt(
      (b.match(/data-package-date="(\d+)"/) || [])[1] || "0",
      10,
    );
    const desc = (
      (b.match(/class="packages-desc">([\s\S]*?)<\/p>/) || [])[1] || ""
    )
      .replace(/<[^>]+>/g, "")
      .trim();
    const metaMatch = b.match(/class="packages-meta">([\s\S]*?)<\/div>/);
    const metaSpans = metaMatch
      ? [...metaMatch[1].matchAll(/<span>([^<]*)<\/span>/g)].map((x) => x[1])
      : [];
    const links = [
      ...b.matchAll(
        /<a href="(https?:\/\/[^"]*)" target="_blank" rel="noopener">/g,
      ),
    ].map((x) => x[1]);
    items.push({
      name,
      types,
      downloads,
      date,
      description: desc,
      author: metaSpans[0] || "",
      downloadsText: metaSpans[1] || "",
      dateText: metaSpans[2] || "",
      npm: links[0] || "",
      repo: links[1] || "",
    });
  }
  return { items, total, lastPage, pageSize: 50 };
};

// ==================== 包详情（pi.dev/packages/{name}） ====================

// pi.dev 无 JSON API，详情页同为 SSR HTML：https://pi.dev/packages/{name}，可离线重放抓取
// 注意：服务器会把编码形式（%40vigolium%2Fpiolium）302 到原始形式（@vigolium/piolium），
// 重定向后需按原始路径请求，避免再次编码造成重定向死循环
const fetchPiDevPackage = (name = "", redirects = 0, useRaw = false) => {
  const clean = String(name || "")
    .trim()
    .replace(/^npm:/, "");
  if (!clean) return Promise.reject(new Error("缺少包名"));
  const url =
    "https://pi.dev/packages/" + (useRaw ? clean : encodeURIComponent(clean));

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          accept: "text/html",
        },
        timeout: 15_000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirects >= 3) return reject(new Error("too many redirects"));
          const loc = res.headers.location;
          const next = loc.indexOf("://") >= 0 ? loc : "https://pi.dev" + loc;
          const slug = decodeURIComponent(
            next.split("?")[0].replace(/^https?:\/\/[^/]+\/packages\//, ""),
          );
          if (!slug) return reject(new Error("invalid redirect: " + loc));
          return resolve(fetchPiDevPackage(slug, redirects + 1, true));
        }
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          try {
            resolve(parsePiDevPackageHtml(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", function () {
      this.destroy();
      reject(new Error("timeout"));
    });
  });
};

const decodeHtml = (s = "") =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

// 详情页 HTML → 结构化数据（版本/作者/许可证/依赖/安装命令/链接/manifest/README）
const parsePiDevPackageHtml = (html) => {
  const name = decodeHtml(
    (html.match(/class="content-title">([^<]*)</) || [])[1] || "",
  );
  const description = decodeHtml(
    (
      (html.match(/class="content-description">([\s\S]*?)<\/p>/) || [])[1] ||
      ""
    ).replace(/<[^>]+>/g, ""),
  ).trim();
  const types = [
    ...html.matchAll(
      /class="meta-chip packages-badge" data-type="([^"]*)"/g,
    ),
  ].map((m) => m[1]);
  // 详情链接区（npm / repo / home / report，按序）
  const linksDiv =
    (html.match(/class="packages-detail-links"[^>]*>([\s\S]*?)<\/div>/) || [])[1] ||
    "";
  const links = [...linksDiv.matchAll(/<a href="(https?:\/\/[^"]*)"/g)].map(
    (m) => m[1],
  );
  const install = decodeHtml(
    (html.match(/data-copy-text="([^"]*)"/) || [])[1] || "",
  );

  // 详情键值（definition-grid）：Package / Version / Published / Downloads / Author / License / Types / Size / Dependencies
  const meta = {};
  const dl =
    (html.match(/<dl class="definition-grid detail-grid">([\s\S]*?)<\/dl>/) ||
      [])[1] || "";
  for (const m of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    const k = decodeHtml(m[1])
      .replace(/<[^>]+>/g, "")
      .trim()
      .toLowerCase();
    const v = decodeHtml(m[2])
      .replace(/<[^>]+>/g, "")
      .trim();
    if (k) meta[k] = v;
  }

  // Pi manifest JSON（可选）
  let manifest = null;
  try {
    manifest = JSON.parse(
      decodeHtml(
        (html.match(/<pre class="raw-data-panel">([\s\S]*?)<\/pre>/) || [])[1] ||
          "",
      ),
    );
  } catch {
    manifest = null;
  }

  const readmeHtml =
    (html.match(/class="rich-text packages-readme">([\s\S]*?)<\/section>/) ||
      [])[1] || "";

  return {
    name,
    description,
    types,
    version: meta.version || "",
    published: meta.published || "",
    downloads: meta.downloads || "",
    author: meta.author || "",
    license: meta.license || "",
    size: meta.size || "",
    dependencies: meta.dependencies || "",
    install,
    npm: links[0] || "",
    repo: links[1] || "",
    home: links[2] || "",
    manifest,
    readme: sanitizeReadmeHtml(readmeHtml),
  };
};

// 轻量 HTML 净化：只保留 README 基础排版标签，剥掉脚本/样式/表单/事件/危险协议
const sanitizeReadmeHtml = (html = "") => {
  if (!html) return "";
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|video|audio|link|meta|base)[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(
      /<(script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|video|audio|link|meta|base)\b[^>]*\/?>/gi,
      "",
    );
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(
    /(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    '$1="#"',
  );
  s = s.replace(/<img\b[^>]*>/gi, "");
  return s;
};

// ==================== 安装 / 卸载 / 一键更新 ====================

const installPiExtension = async (source) => {
  const result = await runPiCmd(["install", source], PI_CMD_TIMEOUT.install);
  return {
    success: result.success,
    message: result.success ? result.stdout : result.stderr,
  };
};

const uninstallPiExtension = async (source) => {
  const result = await runPiCmd(["remove", source], PI_CMD_TIMEOUT.default);
  return {
    success: result.success,
    message: result.success ? result.stdout : result.stderr,
  };
};

// 一键更新全部已安装扩展（pi update --extensions）
const updatePiExtensions = async () => {
  const result = await runPiCmd(["update", "--extensions"], PI_CMD_TIMEOUT.install);
  return {
    success: result.success,
    message: result.success ? result.stdout : result.stderr,
  };
};

module.exports = {
  fetchPiDevPackages,
  fetchPiDevPackage,
  installPiExtension,
  uninstallPiExtension,
  updatePiExtensions,
};
