import type { Vm, VmDetailPayload } from '@/types/panel-vm'
import { telemetryEnabled } from '@/features/vm/telemetry-policy'
import {
  telemetryPolicyConfirmed,
  telemetryStatusLabel,
} from '@/features/vm/telemetry-status'

export type LiveKey = 'live' | 'idle' | 'blocked' | 'parked' | 'unknown' | 'off'
export const LIVE_ORDER: LiveKey[] = [
  'live',
  'idle',
  'blocked',
  'parked',
  'unknown',
  'off',
]
export type SlotState = {
  vm: Vm
  on: boolean
  live: LiveKey
  label: string
  probing: boolean
  confirmed: boolean
}

export function slotState(
  vm: Vm,
  detail: { data?: VmDetailPayload; isPending: boolean } | undefined
): SlotState {
  const on = telemetryEnabled(vm.seed_policy)
  const observed = detail?.data?.kernel?.telemetry
  const confirmed = telemetryPolicyConfirmed(observed, on)
  const base = { vm, on, confirmed, probing: false }
  if (observed?.state === 'unsupported') {
    return { ...base, live: 'blocked', label: '此运行环境不支持' }
  }
  if (!detail || detail.isPending) {
    return { ...base, live: 'unknown', label: '探测原生状态', probing: true }
  }
  if (!observed) {
    return {
      ...base,
      live: vm.status === 'stopped' ? 'parked' : 'unknown',
      label: telemetryStatusLabel(observed, on),
    }
  }
  if (!confirmed)
    return {
      ...base,
      live: 'unknown',
      label: telemetryStatusLabel(observed, on),
    }
  if (!on)
    return { ...base, live: 'off', label: telemetryStatusLabel(observed, on) }
  const live =
    observed.state === 'uploading'
      ? 'live'
      : observed.state === 'idle'
        ? 'idle'
        : 'blocked'
  return { ...base, live, label: telemetryStatusLabel(observed, on) }
}
