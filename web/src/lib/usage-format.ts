/**
 * 用量数字的统一格式化，口径移植自 claude-code-hub
 * （`token.ts` / `currency.ts` / `performance-formatter.ts`）。
 * 日志页、统计页共用；面板只结算美元。
 */

const TOKEN_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
}

/** <1K 原值，<1M 为 `x.xxK`，其余 `x.xxM`；空值 `-`。 */
export function formatTokenAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-'
  const abs = Math.abs(n)
  if (abs < 1000) return n.toLocaleString(undefined, TOKEN_FORMAT)
  if (abs < 1_000_000)
    return `${(n / 1000).toLocaleString(undefined, TOKEN_FORMAT)}K`
  return `${(n / 1_000_000).toLocaleString(undefined, TOKEN_FORMAT)}M`
}

/** `$` + 固定小数位（en-US 千分位）；空值按 0 计，与 hub 一致。 */
export function formatCurrency(
  v: number | null | undefined,
  digits = 2
): string {
  const value = v != null && Number.isFinite(v) ? v : 0
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`
}

/** ≥1000ms 显示 `1.23s`，否则 `850ms`；空值 / 非有限 / 负数为 `-`。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

/**
 * 输出速率 tok/s = 实际输出 tokens / 上游输出窗口。
 * 窗口是实测 `generationMs`（首个协议事件 → 终止生成事件，含不可见推理），
 * 缺失、0、负、非有限都不估（不用总耗时减 TTFT / TTFB）。
 */
export function calculateOutputRate(
  outputTokens: number | null | undefined,
  generationMs: number | null | undefined
): number | null {
  if (
    outputTokens == null ||
    !Number.isFinite(outputTokens) ||
    outputTokens <= 0
  ) {
    return null
  }
  if (
    generationMs == null ||
    !Number.isFinite(generationMs) ||
    generationMs <= 0
  ) {
    return null
  }
  const rate = outputTokens / (generationMs / 1000)
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

const NON_BILLING_ENDPOINTS: Record<string, true> = {
  '/v1/messages/count_tokens': true,
  '/v1/responses/compact': true,
}

/** 不计费端点：行置灰、成本列显示 `-`。 */
export function isNonBillingEndpoint(endpoint: string | null | undefined) {
  if (!endpoint) return false
  const normalized = endpoint.trim().toLowerCase().replace(/\/+$/, '')
  return NON_BILLING_ENDPOINTS[normalized] === true
}
