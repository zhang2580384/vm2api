/**
 * Client-facing usage rewrite for unofficial (non-Claude-Code) requests.
 * Hide the rewritten official 4-block and any gateway-injected tools.
 * Keep the caller's prompt, the caller's own tools, and the caller's
 * `--system` / `--append-system-prompt` leftover.
 * Official cache is wiped so the display matches a no-system request.
 * Zero-inject hides billing + timezone env. Caller leftover is kept.
 * Injected server tools (web_search) are hidden at their upstream schema
 * cost, not at the size of the `{type,name}` stub we put on the wire.
 * Official Claude Code traffic is not rewritten and not hidden.
 * Upstream / logs keep real Anthropic counts.
 */
import {
  CRS_AGENT_EXPANSION,
  CRS_OFFICIAL_CLI_SYSTEM,
  CRS_OFFICIAL_SYSTEM,
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_SYSTEM_EXPANSION,
  callerSystemBlocksWithoutBilling,
  normalizePersonaMode,
} from './crs-persona.mjs'
import { CRS_OFFICIAL_CONTINUATION } from './official-cc-system-2.1.241.mjs'

const SYSTEM_REMINDER_RE = /<system-reminder>\n[\s\S]*?<\/system-reminder>\n?/

/** Calibrated so rewrite 3-block (~1668 chars) ≥ observed short-request 554. */
export const PERSONA_TOKEN_CHAR_DIVISOR = 3

export function estimateClaudeInputTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  return Math.ceil(s.length / PERSONA_TOKEN_CHAR_DIVISOR)
}

function isBlankIdentitySlot(text) {
  return /^[\u200b\u200c\u200d\ufeff\s]*$/.test(String(text || ''))
}

function extractSystemTexts(system) {
  if (!system) return []
  if (typeof system === 'string') return isBlankIdentitySlot(system) ? [] : [system]
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter((t) => !isBlankIdentitySlot(t))
  }
  if (typeof system === 'object' && typeof system.text === 'string') {
    return isBlankIdentitySlot(system.text) ? [] : [system.text]
  }
  return []
}

function firstUserRaw(messages) {
  if (!Array.isArray(messages)) return ''
  for (const msg of messages) {
    if (msg?.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((block) => (typeof block === 'string' ? block : block?.text || ''))
        .filter(Boolean)
        .join('\n')
    }
    return msg.content == null ? '' : String(msg.content)
  }
  return ''
}

function extractParkedReminder(messages) {
  const raw = firstUserRaw(messages)
  const m = raw.match(SYSTEM_REMINDER_RE)
  return m ? m[0].trim() : ''
}

function extractSystemRoleTexts(messages) {
  if (!Array.isArray(messages)) return []
  const out = []
  for (const message of messages) {
    if (message?.role !== 'system') continue
    out.push(...extractSystemTexts(message.content))
  }
  return out
}

function isOfficialPersonaText(text) {
  const t = String(text || '')
  if (/^\s*x-anthropic-billing-header:/i.test(t)) return true
  if (t.trim() === CRS_OFFICIAL_SYSTEM || t.trim() === CRS_OFFICIAL_CLI_SYSTEM) return true
  if (t === CRS_SYSTEM_EXPANSION) return true
  if (t === CRS_OFFICIAL_AGENT_PROMPT || t.startsWith(CRS_OFFICIAL_AGENT_PROMPT.slice(0, 80))) return true
  if (t === CRS_AGENT_EXPANSION || t.startsWith(CRS_AGENT_EXPANSION.slice(0, 80))) return true
  if (t.startsWith(CRS_OFFICIAL_CONTINUATION.slice(0, 80))) return true
  if (t.includes('# Environment\nYou have been invoked in the following environment:')) return true
  if (
    /^# Environment\b/m.test(t) &&
    /Timezone:/.test(t) &&
    !t.includes('# Text output') &&
    !t.includes('# Doing tasks')
  )
    return true
  return false
}

function officialPersonaTexts(system) {
  const out = []
  for (const t of extractSystemTexts(system)) {
    if (isOfficialPersonaText(t)) {
      out.push(t)
      continue
    }
    if (t.startsWith(CRS_SYSTEM_EXPANSION)) {
      out.push(CRS_SYSTEM_EXPANSION)
      continue
    }
    if (t.includes(CRS_OFFICIAL_AGENT_PROMPT)) {
      // Standing constraints may lead the official agent block; only the prompt is official.
      out.push(CRS_OFFICIAL_AGENT_PROMPT)
      continue
    }
    if (!t.includes(CRS_OFFICIAL_SYSTEM)) continue
    const billing = t.match(/x-anthropic-billing-header:[^\n]*/i)
    if (billing) out.push(billing[0])
    out.push(CRS_OFFICIAL_SYSTEM)
    if (t.includes(CRS_SYSTEM_EXPANSION)) out.push(CRS_SYSTEM_EXPANSION)
  }
  return out
}

export function officialPersonaText(system) {
  return officialPersonaTexts(system).join('')
}

function stripKnownTexts(text, known) {
  let rest = String(text || '')
  for (const prev of known) {
    if (!prev) continue
    rest = rest.split(prev).join('')
  }
  return rest.replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n')
}

/** Overlay text we injected; caller leftover is not included. */
export function injectedOverlayText(before, after) {
  if (!after || before === after) return ''
  const beforeSys = extractSystemTexts(before?.system)
  const beforeMsg = extractSystemRoleTexts(before?.messages)
  const known = [...beforeSys, ...beforeMsg]
  const parts = []
  for (const t of extractSystemTexts(after.system)) {
    if (isOfficialPersonaText(t)) continue
    if (beforeSys.includes(t)) continue
    const raw = t.startsWith(CRS_SYSTEM_EXPANSION) ? t.slice(CRS_SYSTEM_EXPANSION.length) : t
    const rest = stripKnownTexts(raw, [
      ...known,
      CRS_OFFICIAL_SYSTEM,
      CRS_OFFICIAL_CLI_SYSTEM,
      CRS_SYSTEM_EXPANSION,
      CRS_OFFICIAL_AGENT_PROMPT,
      CRS_AGENT_EXPANSION,
    ])
    if (rest && !isOfficialPersonaText(rest)) parts.push(rest)
  }
  for (const t of extractSystemRoleTexts(after.messages)) {
    if (isOfficialPersonaText(t)) continue
    if (beforeMsg.includes(t)) continue
    const rest = stripKnownTexts(t, [
      ...known,
      CRS_OFFICIAL_SYSTEM,
      CRS_OFFICIAL_CLI_SYSTEM,
      CRS_SYSTEM_EXPANSION,
      CRS_OFFICIAL_AGENT_PROMPT,
      CRS_AGENT_EXPANSION,
    ])
    if (rest && !isOfficialPersonaText(rest)) parts.push(rest)
  }
  const afterReminder = extractParkedReminder(after.messages)
  const beforeReminder = extractParkedReminder(before?.messages)
  if (afterReminder && afterReminder !== beforeReminder) parts.push(afterReminder)
  return parts.join('\n\n')
}

function callerOfficialTexts(system) {
  // Zero can replace billing lines inside a caller text block. Compare the
  // retained text against the same normalized source, as well as the original.
  return new Set([...officialPersonaTexts(system), ...officialPersonaTexts(callerSystemBlocksWithoutBilling(system))])
}

function officialHideTokens(before, after) {
  if (!after || before === after) return 0
  const callerTexts = callerOfficialTexts(before?.system)
  const added = officialPersonaTexts(after.system).filter((text) => !callerTexts.has(text))
  return estimateClaudeInputTokens(added.join(''))
}

function officialUncachedText(system, callerTexts) {
  if (!system) return ''
  if (!Array.isArray(system)) {
    return officialPersonaTexts(system)
      .filter((text) => !callerTexts.has(text))
      .join('')
  }
  const parts = []
  for (const block of system) {
    const text = typeof block === 'string' ? block : block?.text || ''
    if (!text || !isOfficialPersonaText(text) || callerTexts.has(text)) continue
    if (block && typeof block === 'object' && block.cache_control) continue
    parts.push(text)
  }
  return parts.join('')
}

function toolKey(tool) {
  if (!tool || typeof tool !== 'object') return ''
  return String(tool.name || tool.type || tool.function?.name || '').trim()
}

function callerToolKeys(body) {
  return new Set((Array.isArray(body?.tools) ? body.tools : []).map(toolKey).filter(Boolean))
}

/**
 * Server tools ship as a bare `{type,name}` stub because the schema lives
 * upstream, so the outbound bytes are ~18 tokens while Anthropic bills the
 * whole tool contract. Measured on the vm-05 zero baseline (claude-sonnet-5,
 * two identical runs 2026-08-28): 2837 input with `web_search_20250305`
 * against 43 for the same request shape without it.
 */
export const SERVER_TOOL_INPUT_TOKENS = Object.freeze({
  web_search_20250305: 2794,
  web_search_20260209: 2794,
  web_search_20260318: 2794,
})

function serverToolTokens(tool) {
  const type = String(tool?.type || '').trim()
  return type && SERVER_TOOL_INPUT_TOKENS[type] != null ? SERVER_TOOL_INPUT_TOKENS[type] : 0
}

/** Gateway-injected tools only. Caller tools are kept in client usage. */
export function injectedTools(before, after) {
  if (!Array.isArray(after?.tools) || !after.tools.length) return []
  const keep = callerToolKeys(before)
  return after.tools.filter((tool) => {
    const key = toolKey(tool)
    return key && !keep.has(key)
  })
}

export function injectedToolsPayload(before, after) {
  const extra = injectedTools(before, after)
  return extra.length ? JSON.stringify(extra) : ''
}

/** Injected server tools bill their upstream schema, not the outbound stub. */
export function injectedToolsHideTokens(before, after) {
  const extra = injectedTools(before, after)
  if (!extra.length) return 0
  const stubs = []
  let total = 0
  for (const tool of extra) {
    const billed = serverToolTokens(tool)
    if (billed) total += billed
    else stubs.push(tool)
  }
  if (stubs.length) total += estimateClaudeInputTokens(JSON.stringify(stubs))
  return total
}

function officialUncachedTokens(before, after) {
  if (!after || before === after) return 0
  // Retained caller text is never an injected cost, even if its headings look
  // official or its cache marker changed during request preparation.
  const callerTexts = callerOfficialTexts(before?.system)
  const afterText = officialUncachedText(after.system, callerTexts)
  return estimateClaudeInputTokens(afterText)
}

export function personaHideBreakdown(before, after) {
  const official = officialHideTokens(before, after)
  const uncached = officialUncachedTokens(before, after)
  const overlay = estimateClaudeInputTokens(injectedOverlayText(before, after))
  const tools = injectedToolsHideTokens(before, after)
  return {
    official,
    uncached,
    overlay,
    tools,
    wipeCache: false,
  }
}

function boxHideTokens({ official, uncached, overlay, tools, wipeCache }) {
  const inputHide = uncached + overlay + tools
  const total = official + overlay + tools
  if (!total && !wipeCache) return 0
  const boxed = new Number(total)
  boxed.official = official
  boxed.uncached = uncached
  boxed.overlay = overlay
  boxed.tools = tools
  boxed.wipeCache = !!wipeCache
  boxed.inputHide = inputHide
  return boxed
}

/** Tokens to subtract from client usage. 0 when we did not inject official blocks or overlay. */
export function personaHideInputTokens(before, after) {
  return boxHideTokens(personaHideBreakdown(before, after))
}

function stripParkedReminderFromMessages(messages) {
  if (!Array.isArray(messages)) return messages
  let used = false
  return messages.map((message) => {
    if (used || message?.role !== 'user') return message
    used = true
    if (typeof message.content === 'string') {
      const next = message.content.replace(SYSTEM_REMINDER_RE, '').replace(/^\n+/, '')
      return next === message.content ? message : { ...message, content: next }
    }
    return message
  })
}

/** Caller-visible body: keep caller --system leftover, drop parked overlay reminder. */
export function callerUsageBaseline(body) {
  if (!body || typeof body !== 'object') return { messages: [] }
  return {
    ...(body.system != null ? { system: body.system } : {}),
    messages: stripParkedReminderFromMessages(body.messages),
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    ...(body.tool_choice != null ? { tool_choice: body.tool_choice } : {}),
  }
}

/** Standing constraints the persona put into system that the caller did not send. */
function injectedStandingTokens(before, after, text) {
  const standing = String(text || '').trim()
  if (!standing) return 0
  if (!extractSystemTexts(after?.system).some((t) => t.includes(standing))) return 0
  if (extractSystemTexts(before?.system).some((t) => t.includes(standing))) return 0
  return estimateClaudeInputTokens(standing)
}

/**
 * Hide rewrite for every unofficial /v1 body (messages / chat / completions / responses).
 * Official 4-block is hidden. Caller leftover / tools stay in client usage.
 *
 * `hides` comes from the persona template (any block with hide:true). When it is
 * absent we fall back to the legacy per-mode rule so callers that predate
 * templates keep their behaviour.
 *
 * `standing` ({text, hide}) is the panel standing-constraint mask. It is its own
 * switch: masked even when the template hides nothing, shown even when it does.
 */
export function personaHideForUnofficial(inbound, outbound, { officialClient = false, mode, hides, standing } = {}) {
  if (officialClient || !outbound || inbound === outbound) return 0
  const baseline = callerUsageBaseline(inbound)
  const personaHidden = hides !== false && !(hides == null && normalizePersonaMode(mode) === 'official_prompt')
  const standingTokens = injectedStandingTokens(baseline, outbound, standing?.text)
  const standingHidden = standing?.hide !== false
  // `hides` only governs the persona blocks. Tools we injected were never
  // declared by the caller, so their upstream schema is hidden in every mode.
  if (!personaHidden) {
    return boxHideTokens({
      official: 0,
      uncached: 0,
      overlay: standingHidden ? standingTokens : 0,
      tools: injectedToolsHideTokens(baseline, outbound),
      wipeCache: false,
    })
  }
  const breakdown = personaHideBreakdown(baseline, outbound)
  if (!standingHidden) breakdown.overlay = Math.max(0, breakdown.overlay - standingTokens)
  return boxHideTokens(breakdown)
}

/** Wrap CLI `system_layout=zero` always appends billing + `# Environment`. */
export function zeroCliEnvText(timezone = 'America/New_York') {
  return `# Environment\n - Timezone: ${String(timezone || 'America/New_York').trim() || 'America/New_York'}`
}

/**
 * Billing header is billed far below char/3. No-tool wrap vs Portunex 09-06
 * was +18 on 01/04/05/06; env for America/New_York is ~15 at char/3, rest is billing.
 */
export const ZERO_CLI_BILLING_INPUT_TOKENS = 3

export function zeroCliLayoutHideTokens({ timezone } = {}) {
  return ZERO_CLI_BILLING_INPUT_TOKENS + estimateClaudeInputTokens(zeroCliEnvText(timezone))
}

/**
 * Unofficial wrap 0-inject: hide CLI billing + env, keep leftover, hide injected tools.
 * `overlay` is the gateway text Node already put in the leftover (agent standing).
 * `hides: false` is the panel whole-preset mask off: billing + env count as usage.
 */
export function personaHideForCliZero(
  inbound,
  outbound,
  { officialClient = false, timezone, overlay = 0, hides } = {},
) {
  if (officialClient) return 0
  const official = hides === false ? 0 : zeroCliLayoutHideTokens({ timezone })
  return boxHideTokens({
    official,
    uncached: official,
    overlay: Math.max(0, Math.floor(Number(overlay) || 0)),
    tools: injectedToolsHideTokens(callerUsageBaseline(inbound), outbound),
    wipeCache: false,
  })
}

function num(value) {
  return Number(value) || 0
}

function parseHideTokens(hideTokens) {
  if (hideTokens && typeof hideTokens === 'object') {
    const official = Math.max(0, Math.floor(num(hideTokens.official)))
    const overlay = Math.max(0, Math.floor(num(hideTokens.overlay)))
    const tools = Math.max(0, Math.floor(num(hideTokens.tools)))
    const wipeCache = hideTokens.wipeCache != null ? !!hideTokens.wipeCache : false
    const uncached = hideTokens.uncached != null ? Math.max(0, Math.floor(num(hideTokens.uncached))) : 0
    const inputHide =
      hideTokens.inputHide != null ? Math.max(0, Math.floor(num(hideTokens.inputHide))) : uncached + overlay + tools
    if (official || overlay || tools || wipeCache || inputHide) {
      return { official, overlay, tools, uncached, wipeCache, inputHide }
    }
  }
  const official = Math.max(0, Math.floor(num(hideTokens)))
  return { official, overlay: 0, tools: 0, uncached: official, wipeCache: false, inputHide: official }
}

function wipeOfficialCache(out) {
  if (out.cache_read_input_tokens != null) out.cache_read_input_tokens = 0
  if (out.cache_read_tokens != null) out.cache_read_tokens = 0
  if (out.cache_creation_input_tokens != null) out.cache_creation_input_tokens = 0
  if (out.cache_creation_tokens != null) out.cache_creation_tokens = 0
  if (out.cache_creation && typeof out.cache_creation === 'object') {
    out.cache_creation = { ...out.cache_creation }
    if (out.cache_creation.ephemeral_5m_input_tokens != null) out.cache_creation.ephemeral_5m_input_tokens = 0
    if (out.cache_creation.ephemeral_1h_input_tokens != null) out.cache_creation.ephemeral_1h_input_tokens = 0
  }
  if (out.prompt_tokens_details && typeof out.prompt_tokens_details === 'object') {
    out.prompt_tokens_details = { ...out.prompt_tokens_details, cached_tokens: 0, cache_creation_tokens: 0 }
  }
  if (out.input_tokens_details && typeof out.input_tokens_details === 'object') {
    out.input_tokens_details = { ...out.input_tokens_details, cached_tokens: 0, cache_write_tokens: 0 }
  }
}

export function hidePersonaUsage(usage, hideTokens = 0, cacheTtl = '1h') {
  if (!usage || typeof usage !== 'object') return usage
  const parsed = parseHideTokens(hideTokens)
  const { official, overlay, tools, wipeCache, inputHide } = parsed
  if (!official && !overlay && !tools && !wipeCache && !inputHide) return usage
  const out = { ...usage }
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    out.cache_creation = { ...usage.cache_creation }
  }
  const inputKey =
    out.input_tokens != null ? 'input_tokens' : out.prompt_tokens != null ? 'prompt_tokens' : 'input_tokens'
  if (wipeCache) wipeOfficialCache(out)
  if (inputHide > 0) {
    const take = Math.min(num(out[inputKey]), inputHide)
    if (take > 0) {
      out[inputKey] = num(out[inputKey]) - take
      if (inputKey === 'input_tokens' && out.prompt_tokens != null) {
        out.prompt_tokens = Math.max(0, num(out.prompt_tokens) - take)
      }
    }
  }
  const input = out.input_tokens != null ? num(out.input_tokens) : null
  const prompt = out.prompt_tokens != null ? num(out.prompt_tokens) : null
  const output =
    out.output_tokens != null
      ? num(out.output_tokens)
      : out.completion_tokens != null
        ? num(out.completion_tokens)
        : null
  if (out.total_tokens != null && (input != null || prompt != null) && output != null) {
    out.total_tokens = (input ?? prompt) + output
  }
  return out
}

export function hidePersonaUsageInEvent(event, hideTokens = 0, cacheTtl = '1h') {
  if (!event || typeof event !== 'object' || !hideTokens) return event
  const out = { ...event }
  if (out.usage) out.usage = hidePersonaUsage(out.usage, hideTokens, cacheTtl)
  if (out.message && typeof out.message === 'object' && out.message.usage) {
    out.message = { ...out.message, usage: hidePersonaUsage(out.message.usage, hideTokens, cacheTtl) }
  }
  return out
}

export function hidePersonaUsageInSseLine(line, hideTokens = 0, cacheTtl = '1h') {
  if (!hideTokens || line == null) return line
  const raw = String(line)
  const m = raw.match(/^(data:\s*)(.*)$/)
  if (!m || !m[2] || m[2] === '[DONE]') return raw
  try {
    const evt = JSON.parse(m[2])
    return m[1] + JSON.stringify(hidePersonaUsageInEvent(evt, hideTokens, cacheTtl))
  } catch {
    return raw
  }
}

export function hidePersonaUsageOnMessage(body, hideTokens = 0, cacheTtl = '1h') {
  if (!body || typeof body !== 'object' || !hideTokens || !body.usage) return body
  return { ...body, usage: hidePersonaUsage(body.usage, hideTokens, cacheTtl) }
}
