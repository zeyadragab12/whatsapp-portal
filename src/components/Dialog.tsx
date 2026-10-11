import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useI18n } from '../lib/i18n'

interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  danger?: boolean
  /** The person must type this exact text before the button works. Use it for removing many things at once. */
  requireText?: string
}
interface PromptOptions {
  title: string
  label: string
  initial?: string
  confirmLabel?: string
  required?: boolean
}
interface DialogApi {
  confirm: (o: ConfirmOptions) => Promise<boolean>
  prompt: (o: PromptOptions) => Promise<string | null>
}

type Open = (ConfirmOptions & { kind: 'confirm'; done: (v: boolean) => void }) | (PromptOptions & { kind: 'prompt'; done: (v: string | null) => void })

const Ctx = createContext<DialogApi | null>(null)

export function useDialog(): DialogApi {
  const c = useContext(Ctx)
  if (!c) throw new Error('useDialog needs DialogProvider')
  return c
}

/** Replaces the browser's confirm() and prompt() boxes with a popup that matches the app. */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null)

  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((done) => setOpen({ ...o, kind: 'confirm', done })), [])
  const prompt = useCallback((o: PromptOptions) => new Promise<string | null>((done) => setOpen({ ...o, kind: 'prompt', done })), [])

  function close(value: boolean | string | null) {
    if (!open) return
    if (open.kind === 'confirm') open.done(value === true)
    else open.done(typeof value === 'string' ? value : null)
    setOpen(null)
  }

  return (
    <Ctx.Provider value={{ confirm, prompt }}>
      {children}
      {open && <Popup key={open.title} open={open} close={close} />}
    </Ctx.Provider>
  )
}

/** A popup window for forms and longer content. Esc or a click outside closes it. */
const openModals: symbol[] = []   // the last one is on top; Esc closes only that one

export function Modal({ title, onClose, children, wide, size }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; size?: 'md' | 'wide' | 'xl' }) {
  const box = useRef<HTMLDivElement>(null)
  const width = size === 'xl' ? '!max-w-5xl' : size === 'wide' || wide ? '!max-w-2xl' : ''
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const me = Symbol('modal')
    openModals.push(me)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && openModals[openModals.length - 1] === me) onClose() }
    document.addEventListener('keydown', onKey)
    box.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      openModals.splice(openModals.indexOf(me), 1)
      previous?.focus?.()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`dialog dialog-scroll outline-none ${width}`}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <h3>{title}</h3>
          <button type="button" className="link-btn !px-2" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Popup({ open, close }: { open: Open; close: (v: boolean | string | null) => void }) {
  const { L, t } = useI18n()
  const [text, setText] = useState(open.kind === 'prompt' ? open.initial ?? '' : '')
  const input = useRef<HTMLInputElement>(null)
  const cancelValue = open.kind === 'confirm' ? false : null

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    const me = Symbol('popup')
    openModals.push(me)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && openModals[openModals.length - 1] === me) close(cancelValue) }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); openModals.splice(openModals.indexOf(me), 1); previous?.focus?.() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const needsText = open.kind === 'confirm' && !!open.requireText
  const ready = open.kind === 'confirm'
    ? !needsText || text.trim() === open.requireText
    : !open.required || text.trim() !== ''

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    close(open.kind === 'confirm' ? true : text.trim())
  }

  const danger = open.kind === 'confirm' && open.danger

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(cancelValue) }}>
      <form role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="dialog" onSubmit={submit}>
        <h3 id="dialog-title">{open.title}</h3>
        {open.kind === 'confirm' && open.message && <div className="text-ink-75 mt-2">{open.message}</div>}
        {open.kind === 'prompt' && (
          <label className="field mt-4">
            <span>{open.label}</span>
            <input ref={input} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        {needsText && (
          <label className="field mt-4">
            <span>{L('Type')} <strong className="text-ink">{open.requireText}</strong> {L('to confirm')}</span>
            <input ref={input} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          </label>
        )}
        <div className="flex flex-wrap justify-end gap-3 mt-6">
          <button type="button" className="btn btn-quiet" onClick={() => close(cancelValue)}>{t('cancel')}</button>
          <button className={`btn ${danger ? 'btn-danger' : ''}`} disabled={!ready} autoFocus={open.kind === 'confirm' && !needsText}>
            {open.confirmLabel ?? L('Confirm')}
          </button>
        </div>
      </form>
    </div>
  )
}
