import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { openaiPlanLabel } from '@/lib/vm-status'

export function openaiAccountTone(vm: Vm): StatusTone {
  const status = vm.openai_account_status
  if (!vm.has_token || status?.credential_status === 'missing')
    return { key: 'none', text: '缺少访问凭证', cls: 'none' }
  if (status?.error)
    return {
      key: 'warn',
      text:
        status.credential_status === 'rejected'
          ? '访问凭证被拒绝'
          : '查询失败，待确认',
      cls: 'warn',
    }
  if (status?.credential_status === 'expired')
    return { key: 'warn', text: '访问凭证已过期', cls: 'warn' }
  if (status?.subscription_status === 'paid' && !status.stale)
    return {
      key: 'ok',
      text: `${openaiPlanLabel(status.plan_type)} · 上游已确认`,
      cls: 'ok',
    }
  if (status?.subscription_status === 'free' && !status.stale)
    return { key: 'warn', text: 'Free · 当前非付费套餐', cls: 'warn' }
  if (status?.subscription_status === 'claim_elapsed')
    return { key: 'warn', text: '凭证记载订阅已到期，待确认', cls: 'warn' }
  if (status?.last_success_at)
    return { key: 'caution', text: '套餐状态待更新', cls: 'caution' }
  return { key: 'unknown', text: '当前套餐待查询', cls: 'none' }
}

export function openaiAccountHint(vm: Vm): string {
  const status = vm.openai_account_status
  if (status?.credential_status === 'rejected')
    return '请先刷新访问凭证；凭证被拒绝不代表订阅到期。'
  if (status?.credential_status === 'expired')
    return '访问凭证过期不代表订阅到期，请先刷新凭证再查询。'
  if (status?.error === 'timeout')
    return '查询超时，请检查该槽代理；无法确认当前订阅。'
  if (status?.error) return '查询失败，历史套餐仅供参考；未判定订阅到期。'
  if (status?.subscription_status === 'free' && !status.stale)
    return '上游当前返回免费套餐；无法据此确定曾经是否订阅或何时到期。'
  if (status?.subscription_status === 'paid' && !status.stale)
    return status.usage_allowed === false || status.limit_reached
      ? '套餐已确认，当前使用额度受限。'
      : '套餐已确认；是否可接单还取决于额度、调度和内核状态。'
  return '到期时间来自签发时的凭证；点击查询核对当前套餐，无需打开浏览器。'
}
