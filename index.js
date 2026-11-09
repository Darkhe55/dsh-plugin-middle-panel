/**
 * Host half of the canvas panel bundle.
 *
 * Registers the model-facing `canvas` tool — open a deliverable in the middle
 * canvas panel — plus a short prompt section explaining when to use it instead
 * of `present`.
 */
export const inject = ['tools', 'systemPrompt']

const VIEWS = ['auto', 'text', 'markdown', 'html', 'image']

const PROMPT = [
  '## Canvas panel',
  '',
  'The Web GUI has a middle canvas panel between the workspace list and the conversation.',
  'Use the `canvas` tool to open a deliverable there when the user will look at, judge or iterate on it: an HTML page or UI, a document, an image, a design, a JSON/text artifact.',
  'Keep using `present` for a plain file list; use `canvas` when the file itself is the subject of the conversation.',
  'After opening, the user can select text, pick HTML elements or mark image regions; those become numbered annotations they send back as one chat message. Read such a message as a numbered change list.',
].join('\n')

export function apply(ctx, config) {
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
    async execute(args) {
      const path = String((args && args.path) || '').trim()
      if (!path) throw new Error('path is required')
      const requested = String((args && args.view) || 'auto')
      const view = VIEWS.includes(requested) ? requested : 'auto'
      // Tool output must be lossless JSON: return exactly the declared fields.
      // `line` and `note` stay in the call arguments, which the panel card reads.
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
}
