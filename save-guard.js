/**
 * Guards shared by the write routes.
 *
 * Two separate limits: the JSON envelope that carries a request, and the file it
 * finally produces. Conflating them either lets a huge payload reach memory or
 * rejects a legal file whose base64 form is larger than the text cap.
 */

import path from 'node:path'

/** Ceiling for the JSON request itself. */
export const MAX_BODY_BYTES = 6 * 1024 * 1024

/** Ceiling for the file a request produces, after decoding. */
export const MAX_SAVE_BYTES = 4 * 1024 * 1024

export class BodyTooLarge extends Error {
  constructor(message, status = 413) {
    super(message || 'request body is too large')
    this.name = 'BodyTooLarge'
    this.status = status
  }
}

export class OutsideWorkspace extends Error {
  constructor(message) {
    super(message || 'path is outside the session workspace')
    this.name = 'OutsideWorkspace'
  }
}

/**
 * Read a request body, counting bytes as they arrive.
 *
 * A body that crosses `cap` is abandoned mid-stream instead of being buffered
 * first: `text.length` counted UTF-16 units, so four million CJK characters
 * looked like four million "characters" while occupying twelve megabytes.
 */
export const readCappedBody = async (request, nodeStyle, cap = MAX_BODY_BYTES) => {
  if (nodeStyle) {
    const parts = []
    let total = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > cap) {
        try {
          if (typeof request.destroy === 'function') request.destroy()
        } catch {
          /* the refusal below is what matters */
        }
        throw new BodyTooLarge()
      }
      parts.push(buffer)
    }
    return Buffer.concat(parts).toString('utf8')
  }

  const body = request.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const parts = []
    let total = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const buffer = Buffer.from(value)
      total += buffer.length
      if (total > cap) {
        try {
          await reader.cancel()
        } catch {
          /* best effort */
        }
        throw new BodyTooLarge()
      }
      parts.push(buffer)
    }
    return Buffer.concat(parts).toString('utf8')
  }

  const text = await request.text()
  if (utf8Bytes(text) > cap) throw new BodyTooLarge()
  return text
}

/** Byte length of a string as UTF-8, not as UTF-16 code units. */
export const utf8Bytes = (text) => Buffer.byteLength(String(text == null ? '' : text), 'utf8')

/** True when the text exceeds the file cap once encoded. */
export const textTooLarge = (text, cap = MAX_SAVE_BYTES) => utf8Bytes(text) > cap

/** Decode a base64 payload and refuse it when the real bytes exceed the cap. */
export const decodeCappedBase64 = (content, cap = MAX_SAVE_BYTES) => {
  // Reject before decoding when even the encoded form is impossible.
  const encoded = String(content || '')
  if (Math.floor((encoded.length * 3) / 4) > cap * 2) throw new BodyTooLarge('file is too large')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > cap) throw new BodyTooLarge('file is too large')
  return bytes
}

/** Inverse of `path.relative`, used as the membership test. */
export const isInsideReal = (realRoot, realTarget) => {
  const root = path.resolve(realRoot)
  const target = path.resolve(realTarget)
  const relative = path.relative(root, target)
  if (relative === '') return true
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Resolve where a write really lands.
 *
 * A string prefix test on the requested path proves nothing: a symlink or a
 * Windows junction inside the workspace can point anywhere. The nearest existing
 * ancestor is resolved with `realpath`, the missing tail is appended to that real
 * path, and the result must still be inside the real workspace root.
 */
export const resolveWriteTarget = async (fs, root, requested) => {
  const realRoot = await fs.realpath(root)
  const absolute = path.resolve(root, String(requested || ''))

  let probe = absolute
  const tail = []
  let realAncestor = null
  for (;;) {
    try {
      realAncestor = await fs.realpath(probe)
      break
    } catch (error) {
      const parent = path.dirname(probe)
      if (parent === probe) throw new OutsideWorkspace('no existing ancestor for ' + absolute)
      tail.unshift(path.basename(probe))
      probe = parent
    }
  }

  let realTarget = tail.length ? path.join(realAncestor, ...tail) : realAncestor
  if (!isInsideReal(realRoot, realTarget)) throw new OutsideWorkspace('outside the workspace root')

  // The final component can itself be a link; follow it and re-check.
  let stats = null
  try {
    stats = await fs.lstat(realTarget)
  } catch {
    stats = null
  }
  if (stats && stats.isSymbolicLink()) {
    const resolved = await fs.realpath(realTarget)
    if (!isInsideReal(realRoot, resolved)) throw new OutsideWorkspace('link escapes the workspace')
    realTarget = resolved
  }

  return { absolute, realRoot, realTarget }
}
