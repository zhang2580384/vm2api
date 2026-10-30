/** Redacted account observations. JWT claims describe issuance time, not live entitlement. */
import crypto from 'node:crypto'
import { decodeJwtPayload } from './openai-jwt.mjs'

export const OPENAI_ACCOUNT_STATUS_TTL_MS = 15 * 60_000
const FREE_PLANS = new Set(['free', 'free_workspace', 'guest'])
const PAID_PLANS = new Set([
  'go',
  'plus',
  'pro',
  'prolite',
  'team',
  'business',
  'enterprise',
  'ent26',
  'hc',
  'edu',
  'education',
  'edu_plus',
  'edu_pro',
  'self_serve_business_prolite',
  'self_serve_business_usage_based',
  'enterprise_cbp_automation',
  'enterprise_cbp_usage_based',
])

function plan(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
  return /^[a-z0-9_-]{1,64}$/.test(raw) ? raw : null
}

export function codexAccountStamp(account = {}) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([account.access_token || '', account.chatgpt_account_id || '']))
    .digest('hex')
}

function credentialExpiry(account) {
  const raw = account.expires_at
  const n = Number(raw)
  const ms = n > 0 ? (n < 1e12 ? n * 1000 : n) : Date.parse(raw || '')
  const value = Number.isFinite(ms) && ms > 0 ? ms : Number(decodeJwtPayload(account.access_token)?.exp) * 1000
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null
}

export function openaiAccountObservation(account, { payload, status = 0, error = null, now = Date.now() } = {}) {
  const previous =
    account.account_status?.credential_stamp === codexAccountStamp(account) ? account.account_status : null
  const success = !error && status === 200 && payload && typeof payload === 'object' && !Array.isArray(payload)
  return {
    credential_stamp: codexAccountStamp(account),
    checked_at: new Date(now).toISOString(),
    last_success_at: success ? new Date(now).toISOString() : previous?.last_success_at || null,
    plan_type: success ? plan(payload.plan_type ?? payload.planType) : plan(previous?.plan_type),
    usage_allowed: success && typeof payload.rate_limit?.allowed === 'boolean' ? payload.rate_limit.allowed : null,
    limit_reached:
      success && typeof payload.rate_limit?.limit_reached === 'boolean' ? payload.rate_limit.limit_reached : null,
    http_status: Number(status) || null,
    error: success ? null : error || (status === 401 ? 'credential_rejected' : 'upstream_error'),
  }
}

/** Only this allowlist is exposed to list/detail responses; stamps and tokens remain private. */
export function summarizeOpenaiAccountStatus(account = {}, codex = {}, now = Date.now()) {
  const raw = account.account_status
  const observation = raw?.credential_stamp === codexAccountStamp(account) ? raw : null
  const lastSuccess = Date.parse(observation?.last_success_at || '')
  const stale =
    !observation ||
    !!observation.error ||
    !Number.isFinite(lastSuccess) ||
    now - lastSuccess > OPENAI_ACCOUNT_STATUS_TTL_MS
  const live = !!observation?.last_success_at && !stale
  const planType = plan(observation?.plan_type) || plan(account.chatgpt_plan_type) || plan(codex.plan_type)
  const livePlan = plan(observation?.plan_type)
  const subscriptionUntil = account.chatgpt_subscription_active_until || null
  const untilMs = Date.parse(subscriptionUntil || '')
  const expires = credentialExpiry(account)
  const rejected = observation?.http_status === 401 || observation?.error === 'credential_rejected'
  let subscription = 'unknown'
  if (live && FREE_PLANS.has(livePlan)) subscription = 'free'
  else if (live && PAID_PLANS.has(livePlan)) subscription = 'paid'
  else if (Number.isFinite(untilMs)) subscription = untilMs <= now ? 'claim_elapsed' : 'claim_active'
  let credential = account.access_token ? 'unverified' : 'missing'
  if (rejected) credential = 'rejected'
  else if (live) credential = 'valid'
  else if (expires && Date.parse(expires) <= now) credential = 'expired'
  return {
    plan_type: planType,
    subscription_status: subscription,
    credential_status: credential,
    source: observation?.last_success_at ? 'usage' : planType || subscriptionUntil ? 'credential' : 'none',
    checked_at: observation?.checked_at || null,
    last_success_at: observation?.last_success_at || null,
    subscription_active_until: subscriptionUntil,
    credential_expires_at: expires,
    usage_allowed: live ? observation.usage_allowed : null,
    limit_reached: live ? observation.limit_reached : null,
    stale,
    error: observation?.error || null,
    http_status: observation?.http_status || null,
  }
}
