// @ts-check

export const NONCE_HEADER = 'x-orbit-nonce'
export const PROOF_HEADER = 'x-orbit-proof'

const BLOCK = 64
const encoder = new TextEncoder()

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** @param {Uint8Array} bytes */
async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * A fresh challenge for one request: 16 random bytes as hex.
 * @returns {string}
 */
export function newNonce() {
  return hex(crypto.getRandomValues(new Uint8Array(16)))
}

/**
 * True for a nonce the server answers: 16 to 64 bytes as hex.
 * @param {unknown} nonce
 * @returns {nonce is string}
 */
export function isNonce(nonce) {
  return typeof nonce === 'string' && /^[0-9a-f]{32,128}$/i.test(nonce)
}

/**
 * HMAC-SHA256(token, nonce) as lower-case hex, built on `crypto.subtle.digest`
 * alone because a mod's environment has no `importKey`/`sign`.
 * @param {string} token
 * @param {string} nonce
 * @returns {Promise<string>}
 */
export async function proofOf(token, nonce) {
  let key = encoder.encode(token)
  if (key.length > BLOCK) key = await sha256(key)
  const inner = new Uint8Array(BLOCK)
  const outer = new Uint8Array(BLOCK)
  for (let i = 0; i < BLOCK; i += 1) {
    inner[i] = (key[i] ?? 0) ^ 0x36
    outer[i] = (key[i] ?? 0) ^ 0x5c
  }
  const message = encoder.encode(nonce)
  const innerHash = await sha256(new Uint8Array([...inner, ...message]))
  return hex(await sha256(new Uint8Array([...outer, ...innerHash])))
}

/**
 * True only when `proof` is the server's answer to `nonce` under `token`;
 * compared in constant time, and false for a missing or malformed proof.
 * @param {string} token
 * @param {string} nonce
 * @param {unknown} proof
 * @returns {Promise<boolean>}
 */
export async function isProven(token, nonce, proof) {
  if (typeof proof !== 'string') return false
  const want = await proofOf(token, nonce)
  if (proof.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < want.length; i += 1) diff |= want.charCodeAt(i) ^ proof.charCodeAt(i)
  return diff === 0
}
