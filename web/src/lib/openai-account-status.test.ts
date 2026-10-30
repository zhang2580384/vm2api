import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { openaiAccountHint, openaiAccountTone } from './openai-account-status'
import { claudeTier } from './vm-status'

function slot(
  patch: Partial<NonNullable<Vm['openai_account_status']>> = {}
): Vm {
  return {
    id: 'vm-fixture',
    platform: 'openai',
    family: 'codex',
    has_token: true,
    plan_type: 'pro',
    chatgpt_plan_type: 'pro',
    openai_account_status: {
      plan_type: 'prolite',
      subscription_status: 'paid',
      credential_status: 'valid',
      source: 'usage',
      checked_at: '2026-10-30T00:00:00Z',
      last_success_at: '2026-10-30T00:00:00Z',
      subscription_active_until: null,
      credential_expires_at: null,
      usage_allowed: true,
      limit_reached: false,
      stale: false,
      error: null,
      http_status: 200,
      ...patch,
    },
  } as Vm
}

describe('OpenAI account status copy', () => {
  it('confirms Pro only with a recent live observation', () => {
    expect(openaiAccountTone(slot()).text).toBe('Pro · 上游已确认')
    expect(openaiAccountTone(slot({ stale: true })).text).toBe('套餐状态待更新')
    expect(
      openaiAccountTone({ ...slot(), openai_account_status: null }).text
    ).toBe('当前套餐待查询')
  })
  it('a live Free plan wins over saved Pro and does not invent an expiry date', () => {
    const vm = slot({ plan_type: 'free', subscription_status: 'free' })
    expect(claudeTier(vm).label).toBe('Free')
    expect(openaiAccountTone(vm).text).toContain('当前非付费套餐')
    expect(openaiAccountHint(vm)).toContain('无法据此确定')
  })
  it('timeout, forbidden access and expired credentials never claim the subscription expired', () => {
    for (const error of ['timeout', 'upstream_forbidden', 'upstream_error']) {
      const vm = slot({ error, stale: true })
      expect(openaiAccountTone(vm).text).toBe('查询失败，待确认')
      expect(openaiAccountHint(vm)).toMatch(/无法确认|未判定/)
    }
    const vm = slot({ credential_status: 'expired', stale: true })
    expect(openaiAccountTone(vm).text).toBe('访问凭证已过期')
    expect(openaiAccountHint(vm)).toContain('不代表订阅到期')
  })
  it('a paid but quota-limited account shows the separate limit', () => {
    const vm = slot({ usage_allowed: false, limit_reached: true })
    expect(openaiAccountTone(vm).text).toContain('Pro')
    expect(openaiAccountHint(vm)).toContain('额度受限')
  })
  it('an elapsed claim requires current confirmation', () => {
    expect(
      openaiAccountTone(
        slot({ subscription_status: 'claim_elapsed', stale: true })
      ).text
    ).toBe('凭证记载订阅已到期，待确认')
  })
})
