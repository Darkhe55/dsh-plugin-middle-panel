import { promises as fsp } from 'node:fs'
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

export const vendorRoot = VENDOR_ROOT

// `corsFor` lives in index.js and stays there: passing it in keeps this module
// free of a circular import.
const VENDOR_PATHS = ['/dsh-canvas/vendor/pdfjs/*', '/dsh-canvas/vendor']

export const registerVendorRoute = (ctx, corsFor) =>
  ctx.effect(() => {
    const disposers = VENDOR_PATHS.map((routePath) =>
      ctx.webServer.register({
        path: routePath,
          handler: async (request, response) => {
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
            const origin = headerOf('origin')
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
            const marker = '/dsh-canvas/vendor/pdfjs/'
            const index = pathPart.indexOf(marker)
            // Two shapes: a prefix (what pdf.js needs to join cmap and font names) and a
            // single exact path with ?f=, for servers that do not match wildcards.
            const query = url.split('?')[1] || ''
            const fromQuery = new URLSearchParams(query).get('f')
            const requested = fromQuery
              ? decodeURIComponent(fromQuery)
              : index >= 0
                ? decodeURIComponent(pathPart.slice(index + marker.length))
                : ''
            const absolute = resolveVendorPath(requested)
            if (!absolute) return send(400, 'bad path')

            let bytes
            try {
              bytes = await fsp.readFile(absolute)
            } catch {
              return send(404, 'not found')
            }
            const type = VENDOR_TYPES[path.extname(absolute).toLowerCase()] || 'application/octet-stream'
            // The tree is versioned with the package, so it can be cached hard.
            return send(200, method === 'HEAD' ? '' : bytes, {
              'content-type': type,
              'content-length': String(bytes.length),
              'cache-control': 'public, max-age=31536000, immutable',
            })
          },
      }),
    )
    return () => {
      disposers.forEach((dispose) => {
        if (typeof dispose === 'function') dispose()
      })
    }
  })
