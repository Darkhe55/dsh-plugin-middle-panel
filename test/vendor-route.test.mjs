import { registerVendorRoute, listVendorFiles, resolveVendorPath } from '../vendor-route.js'

let failures = 0
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail))
  if (!ok) failures += 1
}

// —— 文件枚举 ——
const files = listVendorFiles()
check(files.includes('pdf.min.mjs'), '枚举到主模块')
check(files.includes('pdf.worker.min.mjs'), '枚举到 worker')
check(files.some((name) => name.startsWith('cmaps/')), '枚举到 cmaps')
check(files.some((name) => name.startsWith('standard_fonts/')), '枚举到字体')
check(files.length > 150, '文件数合理', String(files.length))

// —— 每个文件一条精确路由 ——
const registered = []
const ctx = {
  effect: (fn) => fn(),
  webServer: {
    register: (route) => {
      registered.push(route.path)
      return () => {}
    },
  },
}
registerVendorRoute(ctx, () => ({ 'access-control-allow-origin': '*' }))
check(registered.length === files.length + 1, '文件数 + 查询兜底各一条', String(registered.length))
check(registered.includes('/dsh-canvas/vendor/pdfjs/pdf.min.mjs'), '主模块有精确路径')
check(registered.includes('/dsh-canvas/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap'), '中文 cmap 有精确路径')
check(registered.includes('/dsh-canvas/vendor'), '查询兜底已注册')
check(
  registered.every((item) => !item.includes('*') || item === '/dsh-canvas/vendor/pdfjs/*'),
  '不再依赖通配',
)

// —— 单条路由真的能出字节 ——
const handlerOf = (routePath) => {
  let found = null
  registerVendorRoute(
    {
      effect: (fn) => fn(),
      webServer: { register: (route) => (route.path === routePath ? (found = route.handler) : null) },
    },
    () => ({ 'access-control-allow-origin': '*' }),
  )
  return found
}

const run = async (handler, url) => {
  const out = {}
  const response = {
    writeHead: (status, headers) => {
      out.status = status
      out.headers = headers || {}
    },
    end: (body) => {
      out.body = body
    },
  }
  const request = {
    method: 'GET',
    url,
    headers: { get: (name) => ({ origin: 'http://127.0.0.1:7367', host: '127.0.0.1:7367' })[name] || null },
  }
  await handler(request, response)
  return out
}

const main = await run(handlerOf('/dsh-canvas/vendor/pdfjs/pdf.min.mjs'), '/dsh-canvas/vendor/pdfjs/pdf.min.mjs')
check(main.status === 200, '精确路由 200', String(main.status))
check(String(main.headers['content-type']).includes('text/javascript'), 'MIME 正确', main.headers['content-type'])
check(main.body && main.body.length > 400000, '返回真实字节', String(main.body && main.body.length))

const cmap = await run(handlerOf('/dsh-canvas/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap'), '/dsh-canvas/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap')
check(cmap.status === 200, '中文 cmap 可取', String(cmap.status))

const queried = await run(handlerOf('/dsh-canvas/vendor'), '/dsh-canvas/vendor?f=pdf.worker.min.mjs')
check(queried.status === 200 && queried.body.length > 1000000, '查询兜底可取 worker', String(queried.status))

// —— 安全 ——
check(resolveVendorPath('../../index.js') === null, '拒绝向上穿越')
check(resolveVendorPath('cmaps/../pdf.min.mjs') !== null, '允许目录内相对路径')
check(resolveVendorPath('') === null, '空路径拒绝')

if (failures) {
  console.log('失败 ' + failures + ' 项')
  process.exit(1)
}
