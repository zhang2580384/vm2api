import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RefusalGuardConfig } from '@/types/panel-routing'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Group, ToggleItem, ToggleList } from './blocks'
import { refusalGuardsQueryOptions } from './queries'

const SIMILARITY_CHOICES = [80, 85, 90, 95] as const

function shortFp(fp: string) {
  const s = String(fp || '')
  if (s.length <= 16) return s
  return `${s.slice(0, 10)}…${s.slice(-6)}`
}

/** Changes here save immediately: each switch and list action is one PUT/DELETE. */
export function RefusalSettings() {
  const qc = useQueryClient()
  const q = useQuery(refusalGuardsQueryOptions())
  const [clearOpen, setClearOpen] = useState(false)
  const [clearDevicesOpen, setClearDevicesOpen] = useState(false)
  const [deleteFp, setDeleteFp] = useState<string | null>(null)
  const [unblockId, setUnblockId] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (patch: Partial<RefusalGuardConfig>) =>
      api<RefusalGuardConfig>('/api/panel/refusal-guards', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: async (data) => {
      toast.success('已保存拒答设置')
      qc.setQueryData(refusalGuardsQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (fingerprint: string) =>
      api<RefusalGuardConfig>(`/api/panel/refusal-guards/${fingerprint}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('已删除指纹')
      setDeleteFp(null)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const clear = useMutation({
    mutationFn: () =>
      api<RefusalGuardConfig>('/api/panel/refusal-guards', {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      toast.success('已清空拒答缓存')
      setClearOpen(false)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const unblock = useMutation({
    mutationFn: (deviceId: string) =>
      api<RefusalGuardConfig>('/api/panel/refusal-device-blocks', {
        method: 'DELETE',
        body: JSON.stringify({ device_id: deviceId }),
      }),
    onSuccess: async () => {
      toast.success('已解除 device 封禁')
      setUnblockId(null)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const clearDevices = useMutation({
    mutationFn: () =>
      api<RefusalGuardConfig>('/api/panel/refusal-device-blocks', {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      toast.success('已清空 device 封禁')
      setClearDevicesOpen(false)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!q.data) return <div className='h-40 animate-pulse bg-muted/40' />
  const data = q.data
  const devices = data.devices ?? []
  const deviceCount = data.device_count ?? devices.length
  const similarity = data.similarity ?? 90
  const deleting = data.items.find((item) => item.fingerprint === deleteFp)

  return (
    <div className='space-y-8 p-4'>
      <Group
        title='何时拦截'
        hint='上游拒答过的正文记成指纹。精确命中直接 503；近似只比较用户正文，短于 512 字不做。改动立即生效。'
      >
        <ToggleList>
          <ToggleItem label='拦截重复拒答' desc='REFUSAL_GUARD=0 会关掉整关'>
            <Switch
              checked={data.enabled}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate({ enabled: v })}
            />
          </ToggleItem>
          <ToggleItem label='近似拦截' desc='不含共享 system'>
            <Switch
              checked={data.similarity_enabled !== false}
              disabled={save.isPending || !data.enabled}
              onCheckedChange={(v) => save.mutate({ similarity_enabled: v })}
            />
          </ToggleItem>
          <ToggleItem
            label='封禁 device'
            desc='命中任一关后，这个 device 的任意 prompt 都不再 hop'
          >
            <Switch
              checked={data.device_block_enabled !== false}
              disabled={save.isPending || !data.enabled}
              onCheckedChange={(v) => save.mutate({ device_block_enabled: v })}
            />
          </ToggleItem>
          <ToggleItem label='相似度' desc='越高越不容易误伤'>
            <div
              role='radiogroup'
              aria-label='相似度'
              className='flex rounded-lg bg-muted p-0.5'
            >
              {SIMILARITY_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type='button'
                  role='radio'
                  aria-checked={similarity === choice}
                  disabled={
                    save.isPending ||
                    !data.enabled ||
                    data.similarity_enabled === false
                  }
                  onClick={() => save.mutate({ similarity: choice })}
                  className='cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums transition-colors duration-200 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm'
                >
                  {choice}%
                </button>
              ))}
            </div>
          </ToggleItem>
        </ToggleList>
      </Group>

      <div className='grid gap-8 xl:grid-cols-2'>
        <Group
          title='已封禁 device'
          hint={
            deviceCount
              ? devices.length < deviceCount
                ? `显示最近 ${devices.length} / ${deviceCount}`
                : `${deviceCount} 个`
              : '还没有'
          }
          action={
            <Button
              size='sm'
              variant='outline'
              className='cursor-pointer'
              disabled={!deviceCount || clearDevices.isPending}
              onClick={() => setClearDevicesOpen(true)}
            >
              全部解除
            </Button>
          }
        >
          {devices.length ? (
            <ul className='max-h-80 divide-y overflow-y-auto rounded-xl border'>
              {devices.map((item) => (
                <li
                  key={item.device_id}
                  className='flex items-center justify-between gap-2 px-3 py-2'
                >
                  <div className='min-w-0 flex-1'>
                    <p className='truncate font-mono text-xs'>
                      {item.device_id}
                    </p>
                    <p className='text-xs text-muted-foreground tabular-nums'>
                      {item.reason || 'refusal_guard'} · 命中 {item.hit_count} ·{' '}
                      {fmtExpiresAt(item.last_seen_at)}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer'
                    onClick={() => setUnblockId(item.device_id)}
                  >
                    解除
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Group>
        <Group
          title='拒答指纹'
          hint={
            data.count
              ? data.items.length < data.count
                ? `显示最近 ${data.items.length} / ${data.count}`
                : `${data.count} 条`
              : '还没有上游拒答'
          }
          action={
            <Button
              size='sm'
              variant='outline'
              className='cursor-pointer'
              disabled={!data.count || clear.isPending}
              onClick={() => setClearOpen(true)}
            >
              清空指纹
            </Button>
          }
        >
          {data.items.length ? (
            <ul className='max-h-80 divide-y overflow-y-auto rounded-xl border'>
              {data.items.map((item) => (
                <li
                  key={item.fingerprint}
                  className='flex items-center justify-between gap-2 px-3 py-2'
                >
                  <div className='min-w-0 flex-1'>
                    <p
                      className='line-clamp-3 text-sm break-words'
                      title={item.preview || undefined}
                    >
                      {item.preview || '（无预览）'}
                    </p>
                    {item.error_message ? (
                      <p
                        className='line-clamp-2 text-xs break-words text-muted-foreground'
                        title={item.error_message}
                      >
                        {item.error_message}
                      </p>
                    ) : null}
                    <p className='truncate font-mono text-xs text-muted-foreground tabular-nums'>
                      {item.model || '—'} · {shortFp(item.fingerprint)} · 命中{' '}
                      {item.hit_count} · {fmtExpiresAt(item.last_seen_at)}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer'
                    onClick={() => setDeleteFp(item.fingerprint)}
                  >
                    删除
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Group>
      </div>
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title='清空拒答缓存'
        desc='清空后同样请求会再次 hop 上游。已封禁的 device 不会一起解除。'
        confirmText='清空'
        cancelBtnText='取消'
        destructive
        isLoading={clear.isPending}
        handleConfirm={() => clear.mutate()}
      />
      <ConfirmDialog
        open={clearDevicesOpen}
        onOpenChange={setClearDevicesOpen}
        title='解除全部 device 封禁'
        desc='解除后这些 device 可以再次请求。拒答指纹还在，相同或足够近似的正文仍会被拦。'
        confirmText='全部解除'
        cancelBtnText='取消'
        destructive
        isLoading={clearDevices.isPending}
        handleConfirm={() => clearDevices.mutate()}
      />
      <ConfirmDialog
        open={!!deleteFp}
        onOpenChange={(open) => {
          if (!open) setDeleteFp(null)
        }}
        title='删除这条指纹'
        desc={`删除后「${deleting?.preview || shortFp(deleteFp || '')}」会再次打上游。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (deleteFp) remove.mutate(deleteFp)
        }}
      />
      <ConfirmDialog
        open={!!unblockId}
        onOpenChange={(open) => {
          if (!open) setUnblockId(null)
        }}
        title='解除这个 device'
        desc={`解除后 ${unblockId || ''} 的新请求不再因为 device 封禁被拦。`}
        confirmText='解除'
        cancelBtnText='取消'
        destructive
        isLoading={unblock.isPending}
        handleConfirm={() => {
          if (unblockId) unblock.mutate(unblockId)
        }}
      />
    </div>
  )
}
