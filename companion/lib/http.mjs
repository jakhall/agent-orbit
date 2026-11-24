import { PAGE_CSP } from './secrets.mjs'

const MAX_BODY = 256 * 1024

export const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(type.startsWith('text/html')
      ? { 'content-security-policy': PAGE_CSP }
      : {}),
  })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
  return true
}

export const readBody = req =>
  new Promise((resolve, reject) => {
    let size = 0
    let isTooLarge = false
    const chunks = []
    req.on('data', chunk => {
      if (isTooLarge) return
      size += chunk.length
      if (size > MAX_BODY) {
        isTooLarge = true
        chunks.length = 0
        reject(Object.assign(new Error('body too large'), { status: 413 }))
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      if (isTooLarge) return
      let body
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      } catch {
        reject(Object.assign(new Error('the request body is not JSON'), { status: 400 }))
        return
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) reject(Object.assign(new Error('the request body must be a JSON object'), { status: 400 }))
      else resolve(body)
    })
    req.on('error', reject)
  })
