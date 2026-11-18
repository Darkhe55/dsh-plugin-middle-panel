/**
 * System-prompt variants for the canvas panel.
 *
 * The "open new deliverables automatically" switch is a double lock: it governs the panel's own
 * auto-open behaviour in the client, and — through this module — the guidance the model receives.
 * With the switch off the model is told not to push the panel forward unless the user asks, so the
 * two sides can never disagree about whether the panel should appear on its own.
 */

const PROMPT_BASE = [
  '## Canvas panel',
  '',
  'The Web GUI has a middle canvas panel between the workspace list and the conversation.',
  'After opening, the user can select text, pick HTML elements or mark image regions; those become numbered annotations they send back as one chat message. Read such a message as a numbered change list.',
].join('\n')

const PROMPT_ON = [
  PROMPT_BASE,
  'Open a deliverable with the `canvas` tool when the user will look at, judge or iterate on it: an HTML page or UI, a document, an image, a design, a JSON/text artifact.',
  'When a task produces a new file of that kind, open that new file rather than describing where it is; keep using `present` for a plain file list.',
].join('\n')

const PROMPT_OFF = [
  PROMPT_BASE,
  'Only open the canvas when the user explicitly asks to see a file; do not open it on your own initiative after finishing a task.',
  'Keep using `present` for a plain file list.',
].join('\n')

/** The prompt text that matches the current switch position. */
export const promptFor = (autoOpenNew) => (autoOpenNew === false ? PROMPT_OFF : PROMPT_ON)

export { PROMPT_BASE, PROMPT_ON, PROMPT_OFF }
