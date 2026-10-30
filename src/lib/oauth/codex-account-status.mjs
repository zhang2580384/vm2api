/** Explicit, read-only ChatGPT entitlement query over the selected slot's egress. */
import { getVm } from '../vm/vm-registry.mjs'
import { isCodexVm, readCodexAccounts, recordCodexAccountObservation, summarizeCodexSlot } from '../vm/codex-slot.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { buildOpenaiQuotaHeaders, CHATGPT_USAGE_URL } from './openai-quota.mjs'
import { fetchCodexJson } from '../protocol/codex-models.mjs'

export const CODEX_ACCOUNT_QUERY_TIMEOUT_MS = 20_000
const inFlight = new Map()

export const ACCOUNT_QUERY_MESSAGES = {
  timeout: '账号状态查询超时，请检查该槽代理后重试；未判定订阅到期。',
  fetch_failed: '无法连接账号状态接口，请检查该槽代理；未判定订阅到期。',
  credential_rejected: '访问凭证被上游拒绝，请先刷新凭证；这不代表订阅已到期。',
  upstream_forbidden: '上游拒绝状态查询，可能是访问限制；无法确认当前订阅。',
  upstream_rate_limited: '账号状态查询被限流，请稍后重试。',
  upstream_error: '上游状态接口暂时不可用，无法确认当前订阅。',
  invalid_response: '上游未返回有效的账号状态，无法确认当前订阅。',
  account_changed: '查询期间凭证发生变化，请重新查询。',
}

export function queryCodexAccountStatus({
  projectRoot,
  vmId,
  fetchImpl,
  timeoutMs = CODEX_ACCOUNT_QUERY_TIMEOUT_MS,
} = {}) {
  const key = `${projectRoot}\0${vmId}`
  if (inFlight.has(key)) return inFlight.get(key)
  const pending = query({ projectRoot, vmId, fetchImpl, timeoutMs }).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key)
  })
  inFlight.set(key, pending)
  return pending
}

async function query({ projectRoot, vmId, fetchImpl, timeoutMs }) {
  const vm = getVm(projectRoot, vmId)
  if (!vm) return { ok: false, status: 404, error: { code: 'vm_not_found', message: '槽位不存在' } }
  if (!isCodexVm(vm)) return { ok: false, status: 400, error: { code: 'not_gpt_slot', message: '仅 GPT 槽支持此查询' } }
  const account = readCodexAccounts(projectRoot, vmId)[0] || {}
  if (!account.access_token)
    return { ok: false, status: 400, error: { code: 'no_access_token', message: '请先导入或刷新访问凭证' } }
  const proxyUrl = hostProxyUrlForVm(vm)
  if (!proxyUrl && !isLocalEgressProxy(vm.proxy))
    return { ok: false, status: 400, error: { code: 'proxy_required', message: '请先绑定该槽代理' } }
  let result
  try {
    const { status, payload } = await fetchCodexJson(
      CHATGPT_USAGE_URL,
      {
        headers: buildOpenaiQuotaHeaders({ accessToken: account.access_token, accountId: account.chatgpt_account_id }),
      },
      { proxyUrl, fetchImpl, timeoutMs },
    )
    const error =
      status === 401
        ? 'credential_rejected'
        : status === 403
          ? 'upstream_forbidden'
          : status === 429
            ? 'upstream_rate_limited'
            : status !== 200
              ? 'upstream_error'
              : !payload ||
                  typeof payload !== 'object' ||
                  Array.isArray(payload) ||
                  !(payload.plan_type || payload.planType)
                ? 'invalid_response'
                : null
    result = { payload, status, error }
  } catch (e) {
    result = { error: e?.name === 'AbortError' ? 'timeout' : 'fetch_failed' }
  }
  if (!recordCodexAccountObservation(projectRoot, vmId, account, result)) {
    return {
      ok: false,
      status: 409,
      error: { code: 'account_changed', message: ACCOUNT_QUERY_MESSAGES.account_changed },
    }
  }
  const accountStatus = summarizeCodexSlot(projectRoot, getVm(projectRoot, vmId)).account_status
  if (result.error)
    return {
      ok: false,
      status: result.error === 'timeout' ? 504 : 502,
      error: { code: result.error, message: ACCOUNT_QUERY_MESSAGES[result.error] },
      account_status: accountStatus,
    }
  return { ok: true, account_status: accountStatus }
}
