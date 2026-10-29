import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { loginLabel } from './login-labels'

export type BrowserEnvironment = {
  os?: string
  os_version?: string
  supported?: boolean
  installed?: boolean
  version?: string | null
  revision?: number | null
  graphical?: boolean
  native_input?: boolean
  needs_upgrade?: boolean
  running: boolean
  stage?: string
  error_code?: string | null
}

export function BrowserEnvironmentControls({
  vm,
  loginRunning,
  onBusyChange,
}: {
  vm: Vm
  loginRunning: boolean
  onBusyChange: (busy: boolean) => void
}) {
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/login/browser-environment`
  const [submitting, setSubmitting] = useState(false)
  const enabled =
    ['running', 'ok', 'paused'].includes(vm.status || '') &&
    vm.runtime?.stopped !== true
  const query = useQuery({
    queryKey: ['browser-environment', vm.id, endpoint],
    queryFn: () => api<BrowserEnvironment>(endpoint),
    enabled,
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
    retry: false,
  })
  const busy = submitting || query.data?.running === true
  useEffect(() => {
    onBusyChange(busy)
    return () => onBusyChange(false)
  }, [busy, onBusyChange])
  async function perform(action: 'install' | 'uninstall') {
    setSubmitting(true)
    try {
      await api(`${endpoint}/${action}`, { method: 'POST', body: '{}' })
      await query.refetch()
      toast.success(
        action === 'install' ? '已开始安装浏览器环境' : '已开始卸载浏览器环境'
      )
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setSubmitting(false)
    }
  }
  const disabled = !enabled || loginRunning || busy || query.isPending
  const info = query.data
  return (
    <>
      <Button
        size='sm'
        variant='outline'
        disabled={disabled || info?.supported === false}
        onClick={() => void perform('install')}
      >
        {info?.needs_upgrade
          ? '升级浏览器环境'
          : info?.installed
            ? '重新安装浏览器环境'
            : '安装浏览器环境'}
      </Button>
      <Button
        size='sm'
        variant='outline'
        disabled={disabled || !info?.installed || info?.supported === false}
        onClick={() => void perform('uninstall')}
      >
        卸载浏览器环境
      </Button>
      <div
        className='w-full space-y-1 text-xs text-muted-foreground'
        aria-live='polite'
      >
        <p>
          浏览器环境：
          {!enabled
            ? '槽位未开机，请先开机'
            : query.isPending
              ? '检测中'
              : info?.running
                ? loginLabel(info.stage || '')
                : info?.installed
                  ? info.needs_upgrade
                    ? '已安装，需升级原生操控环境'
                    : info.graphical
                      ? info.native_input
                        ? '已安装 · 原生人工授权'
                        : '已安装 · 图形模式'
                      : '已安装'
                  : info
                    ? '未安装'
                    : '检测失败'}
          {info?.installed &&
            typeof info.revision === 'number' &&
            ` · r${info.revision}`}
          {info?.os &&
            ` · ${info.os === 'ubuntu' ? 'Ubuntu' : info.os === 'debian' ? 'Debian' : info.os} ${info.os_version || ''}`}
        </p>
        {info?.needs_upgrade && (
          <p className='text-amber-600'>
            点击登录时会自动准备原生操控环境，也可手动升级；会话资料会保留。
          </p>
        )}
        {info?.supported === false && (
          <p className='text-amber-600'>
            当前支持 Ubuntu 22.04 / 24.04、Debian 12 / 13 的标准 Python
            环境（amd64 / arm64）。
          </p>
        )}
        {(query.error || info?.error_code) && (
          <p className='text-amber-600'>
            {loginLabel(query.error?.message || info?.error_code || '')}
          </p>
        )}
        {info?.stage === 'browser_runtime_installed' && !info.error_code && (
          <p>浏览器启动检查已通过，未执行账号登录。</p>
        )}
        <p>
          登录时按需安装，授权后保留浏览器和环境。请先手动关闭浏览器，再按需卸载；关闭释放运行资源，卸载保留凭据和会话资料。全局同时只运行一个浏览器任务。
        </p>
      </div>
    </>
  )
}
