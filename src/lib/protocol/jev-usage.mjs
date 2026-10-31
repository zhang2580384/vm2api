/** Minimal attempt telemetry: no body, API key, URL, or provider error text. */
import { createHash, randomUUID } from 'node:crypto'

let recorder = null
let storageErrors = 0
export function installJevUsageRecorder(value) {
  if (value !== null && typeof value !== 'function') throw new TypeError('Invalid usage recorder')
  recorder = value
}
export function jevUsageStorageErrors() {
  return storageErrors
}
const count = (value) => (Number.isSafeInteger(value) && value >= 0 && value <= 1000000000 ? value : null)
const label = (value, max = 80) =>
  typeof value === 'string' && value.length <= max && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : ''
export function isOfficialTypeSafeUrl(value) {
  try {
    return new URL(value).origin === 'https://api.typesafe.ai'
  } catch {
    return false
  }
}
export function jevKeyFingerprint(key) {
  return key ? createHash('sha256').update(String(key)).digest('hex').slice(0, 12) : ''
}
export function normalizeJevUsage(value = {}) {
  const provider = ['jev', 'laya', 'modernbert'].includes(value.provider) ? value.provider : 'jev'
  const input = count(value.usage?.input_tokens)
  const output = count(value.usage?.output_tokens)
  // A public-list estimate only for the official TypeSafe endpoint, not reseller billing.
  const priced = provider === 'jev' && value.official_typesafe === true
  const iso =
    typeof value.created_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.created_at) &&
    Number.isFinite(Date.parse(value.created_at))
      ? value.created_at
      : new Date().toISOString()
  return {
    id: randomUUID(),
    created_at: iso,
    request_id: label(value.request_id, 100),
    provider,
    model: label(value.response_model) || label(value.model),
    key_fingerprint: /^[a-f0-9]{12}$/.test(value.key_fingerprint || '') ? value.key_fingerprint : '',
    http_status:
      Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599
        ? value.http_status
        : null,
    outcome: ['success', 'http_error', 'network_error', 'invalid_response'].includes(value.outcome)
      ? value.outcome
      : 'invalid_response',
    duration_ms: count(Math.round(Number(value.duration_ms))) ?? 0,
    input_tokens: input,
    output_tokens: output,
    estimated_cost_nano_usd: priced && input !== null ? input * 42 : null,
    input_nano_usd_per_token: priced ? 42 : null,
    output_nano_usd_per_token: priced ? 0 : null,
    pricing_basis: priced ? 'typesafe-public-2026-10-25-estimate' : 'unknown',
  }
}
export function recordJevUsage(value) {
  if (!recorder) return
  try {
    recorder(normalizeJevUsage(value))
  } catch {
    storageErrors++
  }
}
export function shanghaiUsageDay(iso = new Date().toISOString()) {
  return new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10)
}
