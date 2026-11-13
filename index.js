/**
 * Host half of the middle-panel bundle.
 *
 * Registers the model-facing `canvas` tool — open a deliverable in the middle
 * canvas panel — plus a short prompt section explaining when to use it instead
 * of `present`, and the write-back route the panel saves text files through.
 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'fs', 'workingDirectory', 'sessions']

import { registerVendorRoute } from './vendor-route.js'
import {
  BodyTooLarge,
  OutsideWorkspace,
  decodeCappedBase64,
  readCappedBody,
  resolveWriteTarget,
  textTooLarge,
  utf8Bytes,
} from './save-guard.js'

const writeIsStale = (before, expectedMtime, expectedSize, force) => {
  if (!before) return false
  // Node-style stats expose isFile() as a method; a plain snapshot may expose a flag.
  const isFile = typeof before.isFile === 'function' ? before.isFile() : Boolean(before.isFile)
  if (!isFile) return false
  if (force) return false
  const mtime = Number(expectedMtime) || 0
  const size = Number(expectedSize) || 0
  if (mtime > 0 && Math.abs(Number(before.mtimeMs) - mtime) > 1) return true
  // Size is the fallback signal when the caller only knows the file's extent, and a
  // second opinion when a writer preserves mtime.
  if (size > 0 && Number(before.size) !== size) return true
  return false
}

export { sessionCwdOf, sessionRootFromStore, writeIsStale }

const VIEWS = ['auto', 'text', 'markdown', 'html', 'image']

const PROMPT = [
  '## Canvas panel',
  '',
  'The Web GUI has a middle canvas panel between the workspace list and the conversation.',
  'Use the `canvas` tool to open a deliverable there when the user will look at, judge or iterate on it: an HTML page or UI, a document, an image, a design, a JSON/text artifact.',
  'Keep using `present` for a plain file list; use `canvas` when the file itself is the subject of the conversation.',
  'After opening, the user can select text, pick HTML elements or mark image regions; those become numbered annotations they send back as one chat message. Read such a message as a numbered change list.',
].join('\n')

/** Session workspaces seen so far, so a save stays inside the folder the user is working in. */
const sessionRoots = new Map()

const normalize = (value) => String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/')

const isInside = (root, target) => {
  const base = normalize(root).replace(/\/+$/, '').toLowerCase()
  const path = normalize(target).toLowerCase()
  return path === base || path.startsWith(base + '/')
}

/**
 * The working directory of a session, read from whichever shape the store holds.
 *
 * Cordis services have moved between releases: a session value may be the session
 * itself, a record wrapping one, or an agent owning one. Accept all of them instead
 * of depending on a single layout.
 */
const sessionCwdOf = (value) => {
  const layers = [
    value,
    value && value.session,
    value && value.record,
    value && value.record && value.record.session,
    value && value.agent,
    value && value.agent && value.agent.session,
  ]
  for (const layer of layers) {
    const cwd = layer && layer.header && layer.header.cwd
    if (typeof cwd === 'string' && cwd) return cwd
  }
  return undefined
}

const sessionRootFromStore = (ctx, sessionId) => {
  if (!sessionId) return undefined
  const services = []
  // `ctx.sessions` is the current accessor; `ctx.get(name)` is the older one. Both
  // are tried, because a missing accessor used to make every save fall back to the
  // in-memory workspace map and answer 403 after a restart.
  try {
    if (ctx && ctx.sessions) services.push(ctx.sessions)
  } catch {
    /* ignore */
  }
  try {
    const legacy = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    if (legacy && !services.includes(legacy)) services.push(legacy)
  } catch {
    /* ignore */
  }
  for (const service of services) {
    try {
      if (typeof service.get === 'function') {
        const cwd = sessionCwdOf(service.get(sessionId))
        if (cwd) return cwd
      }
      // A registry without `get` still exposes its entries.
      if (typeof service.values === 'function') {
        for (const value of service.values()) {
          const id =
            value &&
            (value.id ||
              (value.header && value.header.id) ||
              (value.session && value.session.header && value.session.header.id))
          if (id && String(id) === String(sessionId)) {
            const cwd = sessionCwdOf(value)
            if (cwd) return cwd
          }
        }
      }
    } catch {
      /* try the next accessor */
    }
  }
  return undefined
}

const corsFor = (request, hostHeader) => {

  const origin = request.headers.get('origin') || ''
  // The desktop page runs on dsh-app://, which Chromium reports as `null` on a
  // cross-origin request; loopback pages report their own http origin. A loopback
  // page is only trusted when it is served from this very server: another local
  // app on a different port must not reach these routes.
  const opaque = origin === 'null' || origin === ''
  const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(origin)
  const requestPort = String(hostHeader || '').split(':').pop()
  if (loopback && (!requestPort || loopback[1] !== requestPort)) return undefined
  if (!opaque && origin !== 'dsh-app://app' && !loopback) return undefined
  return {
    // `null` is the serialized origin of the desktop page and of a sandboxed
      // iframe. Echoing the literal `null` grants that one origin instead of every
      // origin, which is what a wildcard would do.
      'access-control-allow-origin': opaque ? 'null' : origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

export function apply(ctx) {
  // pdf.js is served from the plugin tree so the panel can render pages itself.
  registerVendorRoute(ctx, corsFor)
  const tool = {
    name: 'canvas',
    description:
      'Open a deliverable in the middle canvas panel of the Web GUI, beside the conversation. ' +
      'Use it for something the user should look at and iterate on (HTML page, document, image, JSON/text artifact). ' +
      'The user can then annotate that panel; annotations come back later as one numbered chat message.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Workspace-relative or absolute path of the deliverable to show. Use paths instead when showing several at once.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 12,
          description:
            'Several deliverables to open together, one tab each. The first becomes the active tab; the rest stay open beside it.',
        },
        view: {
          type: 'string',
          enum: VIEWS,
          description: 'Render mode; "auto" picks from the file extension. Default "auto".',
        },
        line: {
          type: 'number',
          description: 'Optional 1-based line to focus in a text deliverable.',
        },
        note: {
          type: 'string',
          description: 'Optional one-line hint shown at the top of the panel, e.g. what changed.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          opened: { type: 'boolean' },
          path: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          view: { type: 'string' },
        },
        required: ['opened', 'path', 'paths', 'view'],
      },
      render: (args, value) => [
        {
          type: 'text',
          text:
            value && value.opened
              ? value.paths && value.paths.length > 1
                ? 'Opened ' +
                  value.paths.length +
                  ' deliverables in the canvas panel, one tab each (' +
                  value.view +
                  '): ' +
                  value.paths.join(', ') +
                  '. The user may send numbered annotations from them.'
                : 'Opened ' +
                  value.path +
                  ' in the canvas panel (' +
                  value.view +
                  '). The user may send numbered annotations from it.'
              : 'Canvas panel is unavailable in this window.',
        },
      ],
    },
    async execute(args, exec) {
      // One call may carry several deliverables; each opens as its own tab.
      const listed = Array.isArray(args && args.paths)
        ? args.paths.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12)
        : []
      const single = String((args && args.path) || '').trim()
      const targets = listed.length ? listed : single ? [single] : []
      if (!targets.length) throw new Error('path or paths is required')
      const path = targets[0]
      const requested = String((args && args.view) || 'auto')
      const view = VIEWS.includes(requested) ? requested : 'auto'
      // Remember this Session's workspace so the save route can confine writes.
      const agent = exec && exec.agent
      if (agent) {
        try {
          const directory = await ctx.workingDirectory.ensure(agent, exec && exec.signal)
          if (directory) sessionRoots.set(String(agent.id), directory)
        } catch {
          /* the save route falls back to the default working directory */
        }
      }
      // Tool output must be lossless JSON: return exactly the declared fields.
      return { opened: true, path, paths: targets, view }
    },
  }
  ctx.effect(() => ctx.tools.register(tool))

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'canvas-panel',
      order: 650,
      text: PROMPT,
      interpolate: false,
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      path: '/dsh-canvas/save',
      // Accept both carrier shapes: Node's (request, response) and one Fetch
      // Request answered with a Response. Dispatch on what the objects provide.
      handler: async (request, response) => {
        const nodeStyle = Boolean(response && typeof response.writeHead === 'function' && typeof response.end === 'function')
        const headerOf = (name) => {
          try {
            if (request && request.headers && typeof request.headers.get === 'function') return request.headers.get(name) || ''
            if (request && request.headers) return String(request.headers[String(name).toLowerCase()] || '')
          } catch {
            /* fall through */
          }
          return ''
        }
        const method = String((request && request.method) || '').toUpperCase()
        const origin = headerOf('origin')
        const cors = corsFor({ headers: { get: (name) => headerOf(name) } }, headerOf('host'))
        const reply = (status, body, extra) => {
          const headers = Object.assign(
            { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            cors || {},
            extra || {},
          )
          if (nodeStyle) {
            response.writeHead(status, headers)
            response.end(JSON.stringify(body))
            return undefined
          }
          return new Response(JSON.stringify(body), { status, headers })
        }
        // Read with a byte budget: the stream is abandoned the moment it exceeds
        // MAX_BODY_BYTES, instead of being buffered whole and measured afterwards.
        const readBody = async () => readCappedBody(request, nodeStyle)

        if (method === 'OPTIONS') {
          if (!cors) return reply(403, { error: 'origin not allowed', origin })
          if (nodeStyle) {
            response.writeHead(204, cors)
            response.end()
            return undefined
          }
          return new Response(null, { status: 204, headers: cors })
        }
        if (method !== 'POST') return reply(405, { error: 'POST only' })
        if (!cors) return reply(403, { error: 'origin not allowed', origin })

        let text = ''
        try {
          text = String((await readBody()) || '')
        } catch (error) {
          if (error instanceof BodyTooLarge) return reply(413, { error: 'request body is too large' })
          return reply(400, { error: 'unreadable body: ' + (error && error.message ? error.message : String(error)) })
        }
    

        let body
        try {
          body = JSON.parse(text || '{}')
        } catch {
          return reply(400, { error: 'invalid JSON' })
        }

        const sessionId = String(body.sessionId || '')
        const requested = normalize(body.absolutePath || body.path || '')
        const content = typeof body.content === 'string' ? body.content : undefined
        // Images arrive as base64; text stays a plain string. Both are size-checked
        // against the decoded length so a base64 payload cannot slip past the cap.
        const binary = body.encoding === 'base64'
        if (!requested) return reply(400, { error: 'path is required' })
        if (content === undefined) return reply(400, { error: 'content is required' })
    // The envelope limit is not the file limit: four million CJK characters are
    // four million UTF-16 units but twelve megabytes of UTF-8.
    if (!binary && textTooLarge(content)) return reply(413, { error: 'file is too large' })

        // A write is authorised by a live Session's own workspace, never by a
        // guessed path: an opaque origin must still name a real session.
        const root = sessionRootFromStore(ctx, sessionId) || sessionRoots.get(sessionId)
        if (!root) return reply(403, { error: 'unknown session workspace: ' + (sessionId || '(missing sessionId)') })

        const absolute = /^[a-z]:\//i.test(requested) || requested.startsWith('/') ? requested : normalize(root + '/' + requested)
        if (!isInside(root, absolute)) {
          return reply(403, { error: 'refusing to write outside the session workspace: ' + root })
        }

      try {
        // `resolve` hands back a sandbox handle, not a path; stat the confined
        // absolute path instead. Statting the handle threw, which silently
        // disabled both the conflict check and the metadata route.
        let fs
        try {
          fs = await import('node:fs/promises')
        } catch {
          fs = null
        }
        if (!fs) return reply(500, { error: 'filesystem unavailable' })
        // A prefix test cannot see through a symlink or a Windows junction, so the
        // real destination is resolved and re-checked before anything writes.
        let place
        try {
          place = await resolveWriteTarget(fs, root, absolute)
        } catch (error) {
          if (error instanceof OutsideWorkspace) {
            return reply(403, { error: 'refusing to write outside the session workspace: ' + root })
          }
          throw error
        }
        const target = await ctx.fs.resolve(place.realTarget)
          // Optimistic concurrency: the client sends the mtime it edited against.
          // A mismatch means someone else touched the file, so the write is
          // refused instead of silently discarding one of the two versions.
          const expected = Number(body.expectedMtime) || 0
          const expectedSize = Number(body.expectedSize) || 0
          const force = body.force === true
          let before = null
          if (fs) {
            try {
              before = await fs.stat(absolute)
            } catch {
              before = null
            }
          }
          if (writeIsStale(before, expected, expectedSize, force)) {
            return reply(409, {
              error: 'file changed on disk',
              mtimeMs: Number(before.mtimeMs) || 0,
              size: Number(before.size) || 0,
            })
          }
          let written = 0
          if (binary) {
            let bytes
            try {
              bytes = decodeCappedBase64(content)
            } catch (error) {
              if (error instanceof BodyTooLarge) return reply(413, { error: 'file is too large' })
              throw error
            }
            written = bytes.length
            // Write through a handle to the resolved path: the check and the write then
            // refer to the same real location, not a name that could be swapped between.
            const handle = await fs.open(place.realTarget, 'w')
            try {
              await handle.writeFile(bytes)
            } finally {
              await handle.close()
            }
          } else {
            written = utf8Bytes(content)
            // The composed filesystem fences writes by an explicit policy; without
            // one the default mode denies a path this route has already confined.
            await ctx.fs.writeText(target, content, undefined, undefined, {
              mode: 'workspace-write',
              workspaceRoot: root,
              sessionId,
            })
          }
          let after = null
          if (fs) {
            try {
              after = await fs.stat(absolute)
            } catch {
              after = null
            }
          }
          return reply(200, {
            ok: true,
            path: place.realTarget,
            bytes: written,
            mtimeMs: after ? Number(after.mtimeMs) || 0 : 0,
            size: after ? Number(after.size) || 0 : written,
          })
        } catch (error) {
          return reply(500, { error: error && error.message ? error.message : String(error) })
        }
      },
    }),
  )

  // Read side: a size probe so the client can refuse an oversized file before
  // pulling it into memory, and a byte range so big containers can be streamed.
  ctx.effect(() =>
    ctx.webServer.register({
      path: '/dsh-canvas/file',
      handler: async (request, response) => {
        const nodeStyle = Boolean(response && typeof response.writeHead === 'function' && typeof response.end === 'function')
        const headerOf = (name) => {
          try {
            if (request && request.headers && typeof request.headers.get === 'function') return request.headers.get(name) || ''
            if (request && request.headers) return String(request.headers[String(name).toLowerCase()] || '')
          } catch {
            /* fall through */
          }
          return ''
        }
        const method = String((request && request.method) || '').toUpperCase()
        const origin = headerOf('origin')
        const cors = corsFor({ headers: { get: (name) => headerOf(name) } }, headerOf('host'))
        const reply = (status, body, extra) => {
          const headers = Object.assign(
            { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            cors || {},
            extra || {},
          )
          if (nodeStyle) {
            response.writeHead(status, headers)
            response.end(JSON.stringify(body))
            return undefined
          }
          return new Response(JSON.stringify(body), { status, headers })
        }
        if (method === 'OPTIONS') {
          if (!cors) return reply(403, { error: 'origin not allowed', origin })
          if (nodeStyle) {
            response.writeHead(204, cors)
            response.end()
            return undefined
          }
          return new Response(null, { status: 204, headers: cors })
        }
        if (method !== 'GET') return reply(405, { error: 'GET only' })
        if (!cors) return reply(403, { error: 'origin not allowed', origin })

        let query
        try {
          query = new URL(String((request && request.url) || '/'), 'http://127.0.0.1').searchParams
        } catch {
          return reply(400, { error: 'unreadable url' })
        }
        const sessionId = String(query.get('sessionId') || '')
        const requested = normalize(String(query.get('path') || ''))
        if (!requested) return reply(400, { error: 'path is required' })
        const root = sessionRootFromStore(ctx, sessionId) || sessionRoots.get(sessionId)
        if (!root) return reply(403, { error: 'unknown session workspace: ' + (sessionId || '(missing sessionId)') })
        const absolute = /^[a-z]:\//i.test(requested) || requested.startsWith('/') ? requested : normalize(root + '/' + requested)
        if (!isInside(root, absolute)) return reply(403, { error: 'refusing to read outside the session workspace' })

        let fs
        try {
          fs = await import('node:fs/promises')
        } catch (error) {
          return reply(500, { error: 'filesystem unavailable: ' + (error && error.message ? error.message : String(error)) })
        }
        let target
        try {
          target = await ctx.fs.resolve(absolute)
        } catch (error) {
          return reply(500, { error: error && error.message ? error.message : String(error) })
        }
        void target
        let stats
        try {
          // Stat the confined path, not the sandbox handle: the handle is an object
          // and node's stat rejects it, which used to 404 every metadata probe.
          stats = await fs.stat(absolute)
        } catch (error) {
          return reply(404, { error: 'cannot stat: ' + (error && error.message ? error.message : String(error)) })
        }
        if (!stats.isFile()) return reply(400, { error: 'not a file' })

        // Metadata only. Serving bytes here would turn the route into a local file
        // reader for anything that can name a session; content always goes through
        // the in-process workspace channel instead.
        return reply(200, { ok: true, size: stats.size, mtimeMs: stats.mtimeMs })
      },
    }),
  )
}
