// 统一 DB 访问入口。
//
// 正常运行时（uTools preload / 桌面 sidecar 装载 services.js）使用共享本地库
// `~/.ccconfig/db`：uTools 与桌面版因此看到同一份数据。
// 单测与 usage-worker 直接 require 各 service 模块，没有装载 services.js，
// 仍使用注入的 `window.utools.db`（内存 mock / worker 写队列 stub），保持既有测试语义。
const local = () => require('./local-db')

const useLocal = () => globalThis.__CCCONFIG_USE_LOCAL_DB__ === true

const backend = () => {
  if (useLocal()) return local().db
  if (typeof window !== 'undefined' && window.utools && window.utools.db) return window.utools.db
  throw new Error('本地数据库不可用')
}

const get = (id) => backend().get(id)
const put = (doc) => backend().put(doc)
const remove = (idOrDoc, rev) => backend().remove(idOrDoc, rev)
const allDocs = (arg) => backend().allDocs(arg)

// 迁移/导入专用：本地库忽略 _rev 强制写入；mock 环境退化为普通 put
const putForce = (doc) => (useLocal() ? local().putForce(doc) : backend().put(doc))

const getNativeId = () =>
  useLocal()
    ? local().getNativeId()
    : window.utools.getNativeId()

module.exports = { backend, get, put, remove, allDocs, putForce, getNativeId, useLocal }
