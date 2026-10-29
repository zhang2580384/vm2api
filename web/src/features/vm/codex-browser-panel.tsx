import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { type LoginStatus, loginLabel } from './codex-password-panel'

type Frame = {
  image: string
  mime?: 'image/png' | 'image/jpeg'
  width: number
  height: number
  active: number
  paused: boolean
  tabs: { index: number; url: string }[]
}
export function CodexBrowserPanel({ vm }: { vm: Vm }) {
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/login`
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [clipboard, setClipboard] = useState('')
  const [readingClipboard, setReadingClipboard] = useState(false)
  const clipboardField = useRef<HTMLTextAreaElement>(null)
  const clipboardGeneration = useRef(0)
  const [url, setUrl] = useState('https://chatgpt.com/')
  const status = useQuery({
    queryKey: ['codex-login', vm.id],
    queryFn: () => api<LoginStatus>(endpoint),
    refetchInterval: open ? 2000 : false,
  })
  const enabled = open && status.data?.browser.ready === true
  useEffect(() => {
    clipboardGeneration.current += 1
    setClipboard('')
    setReadingClipboard(false)
    return () => {
      clipboardGeneration.current += 1
    }
  }, [vm.id, enabled])
  useEffect(() => {
    const connect = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== vm.id) return
      setOpen(true)
    }
    window.addEventListener('codex-open-browser', connect)
    return () => window.removeEventListener('codex-open-browser', connect)
  }, [vm.id])
  const frame = useQuery({
    queryKey: ['codex-browser-frame', vm.id],
    queryFn: () =>
      api<Frame>(`${endpoint}/control`, {
        method: 'POST',
        body: JSON.stringify({ op: 'frame' }),
      }),
    enabled,
    refetchInterval: (q) => (enabled ? (q.state.error ? 5000 : 1000) : false),
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 0,
  })
  async function control(op: string, data: Record<string, unknown> = {}) {
    try {
      await api(`${endpoint}/control`, {
        method: 'POST',
        body: JSON.stringify({ op, ...data }),
      })
      if (op === 'text') setText('')
      await frame.refetch()
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    }
  }
  async function start() {
    setBusy(true)
    setOpen(true)
    try {
      await api<LoginStatus>(`${endpoint}/remote`, {
        method: 'POST',
        body: '{}',
      })
      await status.refetch()
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy(false)
    }
  }
  async function readClipboard() {
    const generation = clipboardGeneration.current
    setReadingClipboard(true)
    setClipboard('')
    try {
      const result = await api<{ text: string }>(`${endpoint}/control`, {
        method: 'POST',
        body: JSON.stringify({ op: 'clipboard' }),
      })
      if (generation === clipboardGeneration.current) setClipboard(result.text)
    } catch (error) {
      if (generation === clipboardGeneration.current)
        toast.error(loginLabel((error as Error).message))
    } finally {
      if (generation === clipboardGeneration.current) setReadingClipboard(false)
    }
  }
  async function copyClipboard() {
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboard)
        toast.success('已复制到本机')
        return
      }
    } catch {
      // LAN panels commonly use HTTP, where the Clipboard API is unavailable.
    }
    clipboardField.current?.focus()
    clipboardField.current?.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      // Keep the text selected for browsers that disable programmatic copying.
    }
    if (copied) toast.success('已复制到本机')
    else toast.info('内容已选中，请按 Ctrl+C 或长按复制')
  }
  async function stop() {
    setBusy(true)
    try {
      await api(`${endpoint}/cancel`, { method: 'POST', body: '{}' })
      setOpen(false)
      await status.refetch()
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy(false)
    }
  }
  const manual =
    status.data?.browser.native ||
    status.data?.browser.remote ||
    frame.data?.paused
  const usable = enabled && manual
  return (
    <div className='space-y-2 border-t pt-3'>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={busy || vm.runtime?.stopped === true}
          onClick={() => void start()}
        >
          {open ? '连接远程屏幕' : '打开远程浏览器'}
        </Button>
        {open && (
          <Button
            size='sm'
            variant='ghost'
            disabled={busy}
            onClick={() => void stop()}
          >
            关闭浏览器
          </Button>
        )}
      </div>
      <p className='text-xs text-muted-foreground'>
        授权成功后保留当前浏览器，可继续续费和管理账号。操作完成后请手动关闭；关闭后可按需卸载环境，凭据和会话资料保留。
      </p>
      {open && (
        <>
          <p aria-live='polite' className='text-xs'>
            {status.data?.browser.retained
              ? '授权已保存，浏览器保持打开，可继续操作'
              : loginLabel(status.data?.state.stage || 'preparing_browser')}
            {status.data?.state.error_code &&
              ` · ${loginLabel(status.data.state.error_code)}`}
          </p>
          <div className='flex flex-wrap gap-2'>
            {!status.data?.browser.remote && !status.data?.browser.native && (
              <Button
                size='sm'
                variant='outline'
                disabled={!enabled}
                onClick={() => void control(manual ? 'resume' : 'takeover')}
              >
                {manual ? '继续自动流程' : '接管鼠标键盘'}
              </Button>
            )}
            <Button
              size='sm'
              variant='outline'
              disabled={!usable}
              onClick={() => void control('back')}
            >
              后退
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={!usable}
              onClick={() => void control('reload')}
            >
              刷新
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={!usable}
              onClick={() => {
                setUrl('https://chatgpt.com/')
                void control('navigate', { url: 'https://chatgpt.com/' })
              }}
            >
              ChatGPT
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={!usable}
              onClick={() => {
                const sessionUrl = 'https://chatgpt.com/api/auth/session'
                setUrl(sessionUrl)
                void control('navigate', { url: sessionUrl })
              }}
            >
              Session 页面
            </Button>
          </div>
          {enabled && !manual && (
            <p className='text-xs text-amber-600' role='status'>
              当前屏幕只读，请先点击“接管鼠标键盘”再操作网页。
            </p>
          )}
          <div className='flex gap-2'>
            <Input
              aria-label='远程浏览器地址'
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button
              size='sm'
              disabled={!usable}
              onClick={() => void control('navigate', { url })}
            >
              前往
            </Button>
          </div>
          {frame.data && enabled && (
            <>
              <div className='flex flex-wrap gap-1'>
                {frame.data.tabs.map((tab) => (
                  <Button
                    key={tab.index}
                    size='sm'
                    variant={
                      tab.index === frame.data.active ? 'default' : 'outline'
                    }
                    className='max-w-64 truncate'
                    onClick={() => void control('tab', { index: tab.index })}
                  >
                    {tab.index + 1}. {tab.url}
                  </Button>
                ))}
              </div>
              <div
                tabIndex={0}
                role='application'
                aria-label='槽位远程屏幕，可点击并输入'
                className='overflow-hidden rounded border bg-black focus:ring-2 focus:ring-primary'
                onKeyDown={(event) => {
                  if (!usable) return
                  event.preventDefault()
                  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key))
                    return
                  if (
                    event.key.length === 1 &&
                    !event.ctrlKey &&
                    !event.altKey &&
                    !event.metaKey
                  ) {
                    void control('text', { text: event.key })
                    return
                  }
                  const key = `${event.ctrlKey ? 'Control+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.metaKey ? 'Meta+' : ''}${event.key === ' ' ? 'Space' : event.key}`
                  void control('key', { key })
                }}
                onWheel={(event) => {
                  if (usable)
                    void control('wheel', { x: event.deltaX, y: event.deltaY })
                }}
              >
                <img
                  alt='槽位浏览器实时屏幕'
                  src={`data:${frame.data.mime === 'image/png' ? 'image/png' : 'image/jpeg'};base64,${frame.data.image}`}
                  className='w-full select-none'
                  draggable={false}
                  onClick={(event) => {
                    const currentFrame = frame.data
                    if (!currentFrame) return
                    if (!usable) {
                      toast.info('请先点击“接管鼠标键盘”再操作网页')
                      return
                    }
                    const rect = event.currentTarget.getBoundingClientRect()
                    event.currentTarget.parentElement?.focus({
                      preventScroll: true,
                    })
                    void control('click', {
                      x:
                        ((event.clientX - rect.left) / rect.width) *
                        currentFrame.width,
                      y:
                        ((event.clientY - rect.top) / rect.height) *
                        currentFrame.height,
                    })
                  }}
                />
              </div>
            </>
          )}
          {frame.error && (
            <p className='text-xs text-amber-600'>
              {loginLabel(frame.error.message)}
            </p>
          )}
          <div className='flex gap-2'>
            <Input
              aria-label='向浏览器输入文字'
              type='text'
              autoComplete='off'
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='向已聚焦的输入框发送文字'
            />
            <Button
              size='sm'
              disabled={!usable || !text}
              onClick={() => void control('text', { text })}
            >
              输入
            </Button>
            <Button
              size='sm'
              disabled={!usable}
              onClick={() => void control('key', { key: 'Enter' })}
            >
              Enter
            </Button>
          </div>
          <div className='space-y-2 rounded border p-2'>
            <div className='flex flex-wrap gap-2'>
              <Button
                size='sm'
                variant='outline'
                disabled={!usable || readingClipboard}
                onClick={() => void readClipboard()}
              >
                {readingClipboard ? '正在读取…' : '读取远程剪贴板'}
              </Button>
              {clipboard && (
                <>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void copyClipboard()}
                  >
                    复制到本机
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setClipboard('')}
                  >
                    清除显示
                  </Button>
                </>
              )}
            </div>
            <p className='text-xs text-muted-foreground'>
              先在远程网页点击复制，再读取到这里。内容仅临时显示，关闭屏幕后清除。
            </p>
            <p className='text-xs text-muted-foreground'>
              导出 Session：先确认 ChatGPT 网页已登录，再打开“Session
              页面”，在远程画面按
              Ctrl+A、Ctrl+C，最后读取远程剪贴板并复制到本机。
            </p>
            {clipboard && (
              <Textarea
                ref={clipboardField}
                aria-label='远程剪贴板内容'
                value={clipboard}
                readOnly
                autoComplete='off'
                spellCheck={false}
                className='font-mono'
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
