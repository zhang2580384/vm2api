import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PoolCredential } from '@/features/credentials'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { BrowserEnvironmentControls } from './browser-environment-controls'
import { CodexRegistrationControls } from './codex-registration-controls'
import { loginLabel } from './login-labels'
import { vmQueryOptions } from './queries'

export type LoginStatus = {
  registration?: {
    email: string
    phase: string
    credential_id: string | null
    password_verified: boolean
    mfa_verified: boolean
  } | null
  credential_id: string | null
  login_armed: boolean
  configured: boolean
  email: string
  mode: string
  has_password: boolean
  has_totp: boolean
  auto_reauthorize: boolean
  subscription?: {
    enabled: boolean
    checked_at: string
    period_end: string
  } | null
  browser: {
    active: boolean
    ready: boolean
    remote: boolean
    native?: boolean
    retained?: boolean
  }
  state: {
    running: boolean
    status: string
    stage: string
    error_code?: string
    cleanup_error_code?: string | null
    browser_error_code?: string | null
    job_id?: string
  }
}
export { loginLabel } from './login-labels'

export function CodexPasswordPanel({ vm }: { vm: Vm }) {
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/login`
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['codex-login', vm.id],
    queryFn: () => api<LoginStatus>(endpoint),
    refetchInterval: 2000,
  })
  const pool = useQuery({
    queryKey: ['login-credentials'],
    queryFn: () =>
      api<{ credentials: PoolCredential[] }>('/api/panel/login-credentials'),
  })
  const [selected, setSelected] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [environmentBusy, setEnvironmentBusy] = useState(false)
  const notified = useRef('')
  const slotRunning =
    ['running', 'ok', 'paused'].includes(vm.status || '') &&
    vm.runtime?.stopped !== true
  useEffect(() => {
    setSelected(status.data?.credential_id || '')
    void qc.invalidateQueries({ queryKey: ['login-credentials'] })
  }, [status.data?.credential_id, qc])
  useEffect(() => {
    const signature =
      status.data?.state.status === 'succeeded' &&
      status.data.state.stage === 'completed'
        ? status.data.state.job_id
        : ''
    if (!signature || notified.current === signature) return
    notified.current = signature
    void qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    void qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey })
    void qc.invalidateQueries({ queryKey: ['login-credentials'] })
    void qc.invalidateQueries({ queryKey: ['browser-environment', vm.id] })
  }, [status.data, qc, vm.id])
  async function perform(action: string) {
    setBusy(true)
    try {
      await api(action === 'remove' ? endpoint : `${endpoint}/${action}`, {
        method: action === 'remove' ? 'DELETE' : 'POST',
        body:
          action === 'remove'
            ? undefined
            : JSON.stringify(
                action === 'bind'
                  ? { credential_id: selected }
                  : action === 'verify'
                    ? { code }
                    : {}
              ),
      })
      setCode('')
      if (action === 'start')
        window.dispatchEvent(
          new CustomEvent('codex-open-browser', { detail: vm.id })
        )
      await Promise.all([status.refetch(), pool.refetch()])
      toast.success(
        action === 'bind'
          ? '已绑定凭据，点击登录后才会执行'
          : action === 'start'
            ? '已开始使用当前槽位环境登录'
            : '操作已完成'
      )
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy(false)
    }
  }
  const running = status.data?.state.running === true
  const occupied = running || status.data?.browser.active === true
  const locked = busy || environmentBusy
  return (
    <div className='space-y-3 rounded border p-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <span className='text-sm font-medium'>绑定的登录凭据</span>
        <Link to='/credentials' className='text-xs underline'>
          管理账号池
        </Link>
      </div>
      {status.data?.configured ? (
        <div className='space-y-1 text-sm'>
          <p className='break-all'>{status.data.email}</p>
          <p className='text-xs text-muted-foreground'>
            {status.data.mode === 'password_totp'
              ? 'GPT 密码：已保存 · 2FA 密钥：已保存'
              : '微软邮箱密码：已保存'}{' '}
            · {status.data.login_armed ? '已完成登录' : '等待手动点击登录'}
          </p>
        </div>
      ) : (
        <p className='text-xs text-muted-foreground'>
          尚未绑定登录凭据。导入和绑定均不执行登录。
        </p>
      )}
      <div className='flex flex-wrap gap-2'>
        <select
          aria-label='选择账号池凭据'
          className='h-9 min-w-0 flex-1 rounded border bg-background px-2 text-sm'
          value={selected}
          disabled={locked || occupied}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value=''>从账号池选择凭据</option>
          {pool.data?.credentials.map((item) => (
            <option
              key={item.id}
              value={item.id}
              disabled={
                item.bound_vm_ids.length > 0 &&
                !item.bound_vm_ids.includes(vm.id)
              }
            >
              {item.email}
              {item.bound_vm_ids.length
                ? ` · ${item.bound_vm_ids.join(', ')}`
                : ''}
            </option>
          ))}
        </select>
        <Button
          size='sm'
          variant='outline'
          disabled={
            !selected ||
            locked ||
            occupied ||
            selected === status.data?.credential_id
          }
          onClick={() => void perform('bind')}
        >
          绑定凭据
        </Button>
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          disabled={
            !status.data?.configured ||
            locked ||
            occupied ||
            !slotRunning ||
            vm.can_import_credential === false
          }
          onClick={() => void perform('start')}
        >
          登录
        </Button>
        <CodexRegistrationControls
          key={vm.id}
          vm={vm}
          status={status.data}
          locked={locked || occupied}
        />
        {status.data?.configured && (
          <Button
            size='sm'
            variant='ghost'
            disabled={locked || occupied}
            onClick={() => void perform('remove')}
          >
            解除绑定
          </Button>
        )}
        {occupied && (
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => void perform('cancel')}
          >
            {status.data?.browser.retained ? '关闭浏览器' : '停止任务'}
          </Button>
        )}
        <BrowserEnvironmentControls
          key={vm.id}
          vm={vm}
          loginRunning={busy || occupied}
          onBusyChange={setEnvironmentBusy}
        />
      </div>
      <p className='text-xs text-muted-foreground'>
        点击登录后，使用当前槽位的浏览器、代理及网络环境完成授权。首次登录成功后才允许授权失效自动重登；关闭调度时不执行自动任务和接单，仍可手动注册或登录。
      </p>
      {vm.schedulable === false && (
        <p className='text-xs text-amber-600'>
          调度已关闭，手动注册和登录不会开启调度。授权完成后请按需手动开启。
        </p>
      )}
      {!slotRunning && (
        <p className='text-xs text-amber-600'>
          槽位未开机，请先开机。空槽无需账号凭据即可开机，绑定代理后可注册或登录。
        </p>
      )}
      {status.data && (
        <div aria-live='polite' className='text-xs'>
          {loginLabel(status.data.state.stage)}
          {status.data.state.error_code && (
            <p className='text-amber-600'>
              {loginLabel(status.data.state.error_code)}
            </p>
          )}
          {status.data.state.cleanup_error_code && (
            <p className='text-amber-600'>
              {status.data.state.cleanup_error_code ===
              'browser_resources_failed'
                ? '授权已保存；临时资源恢复失败，已保留浏览器环境，请检查槽位资源状态。'
                : '授权已保存；浏览器清理出现异常，请检查槽位后再手动卸载。'}
            </p>
          )}
          {status.data.state.browser_error_code && (
            <p className='text-amber-600'>
              授权已保存；浏览器已结束：
              {loginLabel(status.data.state.browser_error_code)}
            </p>
          )}
        </div>
      )}
      {running && status.data?.state.stage === 'waiting_mfa' && (
        <div className='flex gap-2'>
          <Input
            aria-label='手动验证码'
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete='one-time-code'
          />
          <Button
            size='sm'
            disabled={!code || busy}
            onClick={() => void perform('verify')}
          >
            提交验证码
          </Button>
        </div>
      )}
      {(status.error || pool.error) && (
        <p className='text-xs text-destructive'>
          {loginLabel((status.error || pool.error)?.message || '')}
        </p>
      )}
    </div>
  )
}
