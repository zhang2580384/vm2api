/** The scheduler and manual refresh share the Codex credential store and rotation lock. */
import { getVm } from '../vm/vm-registry.mjs'
import { codexCredentialPath, codexAccessExpiresAt, readCodexAccounts, upsertCodexAccount } from '../vm/codex-slot.mjs'
import { withVmLock } from '../vm/vm-file.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { vmHasProxyPath } from './credential-refresh-monitor.mjs'
import { refreshCodexAccessToken } from '../protocol/codex-models.mjs'

export const CODEX_REFRESH_SKEW_MS = 10 * 60_000

function summary(account) {
  const expires = codexAccessExpiresAt(account)
  return {
    has_access: !!account.access_token,
    has_refresh: !!account.refresh_token,
    expires_at: expires || null,
    ttl_seconds: expires ? Math.round((expires - Date.now()) / 1000) : null,
  }
}

export async function ensureCodexCredential(
  projectRoot,
  vmId,
  { force = false, allowResting = false, timeoutMs = 20_000, refresh = refreshCodexAccessToken } = {},
) {
  const snapshot = readCodexAccounts(projectRoot, vmId)[0] || {}
  return withVmLock(codexCredentialPath(projectRoot, vmId), async () => {
    const vm = getVm(projectRoot, vmId)
    if (!vm) return { ok: false, refresh_class: 'fatal', error: { code: 'vm_not_found' } }
    if (vm.schedulable === false && !allowResting)
      return {
        ok: false,
        refresh_class: 'skipped',
        error: { code: 'slot_resting', message: 'Slot scheduling is disabled' },
      }
    const account = readCodexAccounts(projectRoot, vmId)[0] || {}
    if (!account.refresh_token) {
      return {
        ok: false,
        refresh_class: 'unsupported',
        error: { code: 'missing_refresh_token', message: 'GPT 槽没有 Refresh Token，请重新授权。' },
      }
    }
    // Another caller/import may already have replaced this grant while we waited.
    if (
      snapshot.refresh_token !== account.refresh_token ||
      snapshot.access_token !== account.access_token ||
      (!force && account.access_token && codexAccessExpiresAt(account) - Date.now() > CODEX_REFRESH_SKEW_MS)
    ) {
      return {
        ok: true,
        refreshed: false,
        refresh_class: 'already_fresh',
        platform: 'openai',
        credential: summary(account),
      }
    }
    if (!vmHasProxyPath(vm)) {
      return {
        ok: false,
        refresh_class: 'retryable',
        error: { code: 'proxy_required', message: '请先恢复该账号的代理连接。' },
      }
    }
    const tok = await refresh({ refreshToken: account.refresh_token, proxyUrl: hostProxyUrlForVm(vm), timeoutMs })
    const current = readCodexAccounts(projectRoot, vmId)[0] || {}
    // Imports and the kernel can write outside the control-plane mutex. Never overwrite a newer grant.
    if (current.refresh_token !== account.refresh_token || current.access_token !== account.access_token) {
      return {
        ok: true,
        refreshed: false,
        refresh_class: 'already_fresh',
        platform: 'openai',
        credential: summary(current),
      }
    }
    if (!tok.ok) {
      const fatal = /^(refresh_rejected|invalid_grant|refresh_token_reused)$/.test(tok.error || '')
      if (fatal)
        upsertCodexAccount(projectRoot, vmId, { refresh_error: tok.error, refresh_error_at: new Date().toISOString() })
      return {
        ok: false,
        refresh_class: fatal ? 'fatal' : 'retryable',
        error: {
          code: tok.error || 'refresh_failed',
          message: fatal
            ? 'GPT 授权已失效，请重新授权；这不代表订阅已到期。'
            : tok.error === 'timeout'
              ? 'GPT 凭证刷新超时，请检查该槽代理后重试。'
              : 'GPT 令牌刷新暂时失败，请稍后重试。',
        },
      }
    }
    const next = upsertCodexAccount(projectRoot, vmId, {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || account.refresh_token,
      id_token: tok.id_token || account.id_token,
      expires_at: tok.expires_at || codexAccessExpiresAt({ access_token: tok.access_token }),
      refreshed_at: new Date().toISOString(),
    })
    return { ok: true, refreshed: true, refresh_class: 'rotated', platform: 'openai', credential: summary(next) }
  })
}
