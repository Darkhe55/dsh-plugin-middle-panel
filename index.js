/**
 * Host half of the middle-panel bundle.
 *
 * Registers the model-facing `canvas` tool — open a deliverable in the middle
 * canvas panel — plus a short prompt section explaining when to use it instead
 * of `present`, and the write-back route the panel saves text files through.
 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'fs', 'workingDirectory', 'sessions']

const VIEWS = ['auto', 'text', 'markdown', 'html', 'image']
const MAX_SAVE_BYTES = 4 * 1024 * 1024

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

/** The Session's own working directory, from the live session store. */
const sessionRootFromStore = (ctx, sessionId) => {
  if (!sessionId) return undefined
  try {
    const sessions = ctx.get('sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const cwd = session && session.header && session.header.cwd
    return typeof cwd === 'string' && cwd ? cwd : undefined
  } catch {
    return undefined
  }
}

const corsFor = (request) => {
  const origin = request.headers.get('origin') || ''
  // The desktop page runs on dsh-app://, which Chromium reports as `null` on a
  // cross-origin request; loopback pages report their own http origin.
  const opaque = origin === 'null' || origin === ''
  const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin)
  if (!opaque && origin !== 'dsh-app://app' && !loopback) return undefined
  return {
    'access-control-allow-origin': opaque ? '*' : origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

export function apply(ctx) {
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
          description: 'Workspace-relative or absolute path of the deliverable to show.',
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
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          opened: { type: 'boolean' },
          path: { type: 'string' },
          view: { type: 'string' },
        },
        required: ['opened', 'path', 'view'],
      },
      render: (args, value) => [
        {
          type: 'text',
          text:
            value && value.opened
              ? 'Opened ' + value.path + ' in the canvas panel (' + value.view + '). The user may send numbered annotations from it.'
              : 'Canvas panel is unavailable in this window.',
        },
      ],
    },
    async execute(args, exec) {
      const path = String((args && args.path) || '').trim()
      if (!path) throw new Error('path is required')
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
      return { opened: true, path, view }
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
        const cors = corsFor({ headers: { get: (name) => headerOf(name) } })
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
        const readBody = async () => {
          if (nodeStyle) {
            let text = ''
            for await (const chunk of request) text += chunk
            return text
          }
          return await request.text()
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
        if (method !== 'POST') return reply(405, { error: 'POST only' })
        if (!cors) return reply(403, { error: 'origin not allowed', origin })

        let text = ''
        try {
          text = String((await readBody()) || '')
        } catch (error) {
          return reply(400, { error: 'unreadable body: ' + (error && error.message ? error.message : String(error)) })
        }
        if (text.length > MAX_SAVE_BYTES) return reply(413, { error: 'file is too large' })

        let body
        try {
          body = JSON.parse(text || '{}')
        } catch {
          return reply(400, { error: 'invalid JSON' })
        }

        const sessionId = String(body.sessionId || '')
        const requested = normalize(body.absolutePath || body.path || '')
        const content = typeof body.content === 'string' ? body.content : undefined
        if (!requested) return reply(400, { error: 'path is required' })
        if (content === undefined) return reply(400, { error: 'content is required' })

        // A write is authorised by a live Session's own workspace, never by a
        // guessed path: an opaque origin must still name a real session.
        const root = sessionRootFromStore(ctx, sessionId) || sessionRoots.get(sessionId)
        if (!root) return reply(403, { error: 'unknown session workspace: ' + (sessionId || '(missing sessionId)') })

        const absolute = /^[a-z]:\//i.test(requested) || requested.startsWith('/') ? requested : normalize(root + '/' + requested)
        if (!isInside(root, absolute)) {
          return reply(403, { error: 'refusing to write outside the session workspace: ' + root })
        }

        try {
          const target = await ctx.fs.resolve(absolute)
          // The composed filesystem fences writes by an explicit policy; without
          // one the default mode denies a path this route has already confined.
          await ctx.fs.writeText(target, content, undefined, undefined, {
            mode: 'workspace-write',
            workspaceRoot: root,
            sessionId,
          })
          return reply(200, { ok: true, path: absolute, bytes: content.length })
        } catch (error) {
          return reply(500, { error: error && error.message ? error.message : String(error) })
        }
      },
    }),
  )
}
