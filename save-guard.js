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
 * Bounds on the discard phase. The remainder of an over-limit body is read and
 * thrown away so the reply can be delivered (closing while the peer still writes
 * resets the connection and the 413 is lost); these limits keep a hostile upload
 * from holding the connection open forever.
 */
export const MAX_DISCARD_BYTES = 32 * 1024 * 1024
export const DISCARD_TIMEOUT_MS = 5000

/**
 * Read a request body, counting bytes as they arrive.
 *
 * Crossing `cap` stops all accumulation immediately: the offending chunk and
 * everything after it are discarded, never concatenated and never retained. The
 * remainder is still drained — measured, not stored — because a peer that is
 * still writing when the socket closes sees ECONNRESET instead of the 413.
 */
export const readCappedBody = async (request, nodeStyle, cap = MAX_BODY_BYTES) => {
  if (nodeStyle) return readNodeBody(request, cap)

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
        // The web runtime owns the connection, so cancelling is safe here and stops
        // the transfer without buffering the rest.
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

/**
 * Node request bodies are read with explicit listeners rather than `for await`:
 * breaking out of an async iterator destroys the stream, which is exactly the
 * socket reset this guard must avoid.
 */
const readNodeBody = (request, cap) =>
  new Promise((resolve, reject) => {
    const parts = []
    let total = 0
    let excess = 0
    let over = false
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
      request.removeListener('data', onData)
      request.removeListener('end', onEnd)
      request.removeListener('error', onError)
      request.removeListener('aborted', onAborted)
    }

    const stop = () => {
      if (settled) return
      settled = true
      cleanup()
      // A teardown after the refusal can emit on the request; swallow it so it never
      // becomes an unhandled 'error'.
      request.on('error', () => {})
      reject(new BodyTooLarge())
    }

    const onData = (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (over) {
        // Discarded: counted, never stored.
        excess += buffer.length
        if (excess > MAX_DISCARD_BYTES) stop()
        return
      }
      total += buffer.length
      if (total > cap) {
        over = true
        // Bound the drain in time as well, in case the peer trickles bytes forever.
        timer = setTimeout(stop, DISCARD_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
        return
      }
      parts.push(buffer)
    }

    const onEnd = () => {
      if (settled) return
      if (over) {
        // The whole body is gone, so the reply can be written on a healthy socket.
        stop()
        return
      }
      settled = true
      cleanup()
      resolve(Buffer.concat(parts).toString('utf8'))
    }

    const onError = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const onAborted = () => onError(new Error('request aborted'))

    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
  })

/**
 * Answer an over-limit request.
 *
 * Shared by the route and the HTTP test so both exercise the same shape: the body
 * has already been drained by `readCappedBody`, so this only has to mark the
 * connection as spent and let it close once the reply is flushed.
 */
export const replyBodyTooLarge = ({ reply, request, response, nodeStyle, message = 'request body is too large' }) => {
  const sent = reply(413, { error: message }, { connection: 'close' })
  if (!nodeStyle) return sent
  // Never destroy here: the client still has to read this response.
  request.on('error', () => {})
  return sent
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
