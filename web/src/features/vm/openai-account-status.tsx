import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import {
  openaiAccountHint,
  openaiAccountTone,
} from '@/lib/openai-account-status'
import { Button } from '@/components/ui/button'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export function OpenaiAccountStatus({
  vm,
  allowQuery = true,
  showExpiry = false,
}: {
  vm: Vm
  allowQuery?: boolean
  showExpiry?: boolean
}) {
  const qc = useQueryClient()
  const perms = useVmPerms()
  const status = vm.openai_account_status
  const query = useMutation({
    mutationKey: ['panel', 'account-status', vm.id],
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/account-status`, {
        method: 'POST',
        signal: AbortSignal.timeout(25_000),
      }),
    onSuccess: () => toast.success('账号状态已查询'),
    onError: (error: Error) =>
      toast.error(
        error.name === 'TimeoutError'
          ? '账号状态查询超时，请检查该槽代理后重试'
          : error.message
      ),
    onSettled: () => {
      // Do not keep the button spinning while unrelated dashboard/proxy requests reload.
      void qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey })
      void qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey })
      void qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    },
  })
  return (
    <div className='space-y-1.5'>
      <div className='flex flex-wrap items-center gap-2'>
        <StatusMark tone={openaiAccountTone(vm)} variant='pill' />
        {allowQuery && perms.credential ? (
          <Button
            size='sm'
            variant='outline'
            loading={query.isPending}
            disabled={!vm.has_token || query.isPending}
            onClick={() => query.mutate()}
          >
            {query.isPending ? '查询中…' : '查询账号状态'}
          </Button>
        ) : null}
      </div>
      <p className='text-[11px] text-muted-foreground'>
        {openaiAccountHint(vm)}
      </p>
      {showExpiry ? (
        <p className='text-[11px] text-muted-foreground'>
          订阅到期（凭证记录）
          {fmtExpiresAt(
            status?.subscription_active_until ||
              vm.chatgpt_subscription_active_until
          )}
        </p>
      ) : null}
      {status?.checked_at ? (
        <p className='text-[11px] text-muted-foreground'>
          最近查询 {fmtExpiresAt(status.checked_at)}
          {status.stale ? ' · 当前结果待确认' : ''}
        </p>
      ) : null}
      {status?.last_success_at &&
      status.last_success_at !== status.checked_at ? (
        <p className='text-[11px] text-muted-foreground'>
          上次确认 {fmtExpiresAt(status.last_success_at)}
        </p>
      ) : null}
    </div>
  )
}
