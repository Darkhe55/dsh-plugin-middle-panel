import { promises as fsp } from 'node:fs'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = path.join(here, 'vendor', 'pdfjs')

const VENDOR_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

export const vendorRoot = VENDOR_ROOT

// Resolve a request path inside the vendored directory and refuse anything that
// escapes it: the route serves a fixed tree, not the filesystem.
export const resolveVendorPath = (requestPath) => {
  const raw = String(requestPath || '').replace(/^\/+/, '')
  if (!raw) return null
  const absolute = path.resolve(VENDOR_ROOT, raw)
  const relative = path.relative(VENDOR_ROOT, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}

export const listVendorFiles = (dir = VENDOR_ROOT, prefix = '') => {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) out.push(...listVendorFiles(path.join(dir, entry.name), relative))
    else out.push(relative)
  }
  return out
}

const PREFIX = '/dsh-canvas/vendor/pdfjs/'

// One handler shape for every way of naming a file.
const makeHandler = (corsFor, fallbackName) => async (request, response) => {
  const nodeStyle = Boolean(response && typeof response.writeHead === 'function')
  const headerOf = (name) => {
    try {
      if (request && request.headers && typeof request.headers.get === 'function') {
        return request.headers.get(name) || ''
      }
      if (request && request.headers) return String(request.headers[String(name).toLowerCase()] || '')
    } catch {
      /* fall through */
    }
    return ''
  }
  const method = String((request && request.method) || '').toUpperCase()
  const cors =
    typeof corsFor === 'function'
      ? corsFor({ headers: { get: (name) => headerOf(name) } }, headerOf('host'))
      : undefined
  const send = (status, body, extra) => {
    const headers = Object.assign({}, cors || {}, extra || {})
    if (nodeStyle) {
      response.writeHead(status, headers)
      response.end(body)
      return undefined
    }
    return new Response(body, { status, headers })
  }
  if (method === 'OPTIONS') {
    if (!cors) return send(403, '')
    return nodeStyle ? send(204, '') : new Response(null, { status: 204, headers: Object.assign({}, cors) })
  }
  if (method !== 'GET' && method !== 'HEAD') return send(405, 'GET only')
  if (!cors) return send(403, 'origin not allowed')

  const url = String((request && request.url) || '')
  const pathPart = url.split('?')[0]
  const query = url.split('?')[1] || ''
  const fromQuery = new URLSearchParams(query).get('f')
  const relative = fromQuery
    ? decodeURIComponent(fromQuery)
    : fallbackName
      ? fallbackName
      : pathPart.startsWith(PREFIX)
        ? decodeURIComponent(pathPart.slice(PREFIX.length))
        : ''
  const absolute = resolveVendorPath(relative)
  if (!absolute) return send(400, 'bad path')

  let bytes
  try {
    bytes = await fsp.readFile(absolute)
  } catch {
    return send(404, 'not found')
  }
  const type = VENDOR_TYPES[path.extname(absolute).toLowerCase()] || 'application/octet-stream'
  return send(200, method === 'HEAD' ? '' : bytes, {
    'content-type': type,
    'content-length': String(bytes.length),
    'cache-control': 'public, max-age=31536000, immutable',
  })
}

// Register an exact route per file, because a host is not guaranteed to match a
// wildcard. Each registration is isolated: one refusal must not drop the rest.
export const registerVendorRoute = (ctx, corsFor) =>
  ctx.effect(() => {
    const disposers = []
    const add = (routePath, fallbackName) => {
      try {
        const dispose = ctx.webServer.register({
          path: routePath,
          handler: makeHandler(corsFor, fallbackName),
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch {
        /* a host that refuses this path shape still gets the others */
      }
    }
    for (const relative of listVendorFiles()) add(PREFIX + relative, relative)
    // Also answer the query shape, which needs a single path for everything.
    add('/dsh-canvas/vendor', '')
    return () => {
      disposers.forEach((dispose) => {
        try {
          dispose()
        } catch {
          /* best effort */
        }
      })
    }
  })
