import type { Vm } from '@/types/panel-vm'
import { expiresAtToMs } from '@/lib/fable-status'
import { isCodexVm } from '@/lib/vm-kind'

export type SubscriptionTone = 'muted' | 'warn' | 'bad'

const NEAR_DAYS = 7

/** List/rack label. GPT uses the credential end date only. Claude has no upstream field. */
export function subscriptionListLabel(
  vm: Vm,
  now: number
): { text: string; title: string; tone: SubscriptionTone } {
  const unknown = {
    text: '订阅 未知',
    title: isCodexVm(vm)
      ? '凭证没有 chatgpt_subscription_active_until，不用 access token 或额度重置推算'
      : 'Claude 没有上游订阅到期字段',
    tone: 'muted' as const,
  }
  if (!isCodexVm(vm)) return unknown
  const raw = vm.chatgpt_subscription_active_until
  const ms = expiresAtToMs(raw)
  if (!raw || !ms) return unknown
  const date = new Date(ms)
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  if (ms <= now) {
    return {
      text: `订阅 ${stamp} 已过期`,
      title: '以凭证为准，不是额度窗口重置',
      tone: 'bad',
    }
  }
  const days = Math.ceil((ms - now) / 86_400_000)
  return {
    text: `订阅 ${stamp} · ${days}d`,
    title: '以凭证为准，不是 access token 到期或额度窗口重置',
    tone: days <= NEAR_DAYS ? 'warn' : 'muted',
  }
}
