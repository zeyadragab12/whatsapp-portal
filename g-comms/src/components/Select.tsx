import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Opt { value: string; label: ReactNode; text: string; disabled: boolean }
interface Pos { left: number; width: number; top?: number; bottom?: number; maxH: number }

const textOf = (n: ReactNode) => Children.toArray(n).filter((x) => typeof x === 'string' || typeof x === 'number').join('')

/** Reads the <option> children, so a Select is written exactly like a native <select>. */
function collect(children: ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return
    const p = c.props as { value?: string | number; disabled?: boolean; children?: ReactNode }
    if (c.type === Fragment) collect(p.children, out)
    else if (c.type === 'option') out.push({ value: String(p.value ?? textOf(p.children)), label: p.children, text: textOf(p.children), disabled: !!p.disabled })
  })
  return out
}

interface Props {
  value: string | number
  onChange: (e: { target: { value: string }; currentTarget: { value: string } }) => void
  children: ReactNode
  disabled?: boolean
  required?: boolean
  className?: string
  id?: string
  'aria-label'?: string
}

/** One dropdown for the whole app: same look, same open animation, works with the keyboard. */
export default function Select({ value, onChange, children, disabled, className = '', id, 'aria-label': ariaLabel }: Props) {
  const options = collect(children)
  const uid = useId()
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<Pos | null>(null)

  const selected = options.findIndex((o) => o.value === String(value))
  const current = options[selected >= 0 ? selected : 0]

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12
    const down = below >= 200 || below >= above
    const maxH = Math.max(120, Math.min(288, down ? below : above))
    setPos(down ? { left: r.left, width: r.width, top: r.bottom + 6, maxH } : { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 6, maxH })
  }, [])

  function show() {
    if (disabled) return
    setActive(selected >= 0 ? selected : Math.max(0, options.findIndex((o) => !o.disabled)))
    place(); setOpen(true)
  }
  const hide = () => setOpen(false)
  function choose(i: number) {
    const o = options[i]
    if (!o || o.disabled) return
    hide()
    if (o.value !== String(value)) onChange({ target: { value: o.value }, currentTarget: { value: o.value } })
    btn.current?.focus()
  }

  useLayoutEffect(() => { if (open) place() }, [open, place])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      const t = e.target as Node
      if (!btn.current?.contains(t) && !panel.current?.contains(t)) hide()
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, place])
  useEffect(() => { if (open) panel.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [open, active])

  function step(from: number, dir: 1 | -1) {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i].disabled) return i
    return from
  }
  function onKeyDown(e: React.KeyboardEvent) {
    const k = e.key
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); show() }
      return
    }
    if (k === 'Escape') { e.preventDefault(); e.nativeEvent.stopPropagation(); hide() }
    else if (k === 'Tab') hide()
    else if (k === 'ArrowDown') { e.preventDefault(); setActive(step(active, 1)) }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive(step(active, -1)) }
    else if (k === 'Home') { e.preventDefault(); setActive(step(-1, 1)) }
    else if (k === 'End') { e.preventDefault(); setActive(step(options.length, -1)) }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(active) }
    else if (k.length === 1) {
      const n = options.findIndex((o, i) => i !== active && !o.disabled && o.text.toLowerCase().startsWith(k.toLowerCase()))
      if (n >= 0) setActive(n)
    }
  }

  return (
    <>
      <button ref={btn} type="button" id={id} disabled={disabled} className={`select-btn ${className}`} aria-label={ariaLabel}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${uid}-list` : undefined} aria-activedescendant={open ? `${uid}-${active}` : undefined}
        onClick={() => (open ? hide() : show())} onKeyDown={onKeyDown}>
        <span className="truncate">{current ? current.label : ''}{!current?.text && !current?.label ? ' ' : ''}</span>
        <svg className={`menu-chevron shrink-0 text-ink-50 ${open ? 'rotate-180' : ''}`} width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={panel} id={`${uid}-list`} role="listbox" className="select-panel menu-panel"
          style={{ left: pos.left, width: Math.max(pos.width, 160), top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH, transformOrigin: pos.top !== undefined ? 'top center' : 'bottom center' }}>
          {options.map((o, i) => (
            <div key={`${o.value}-${i}`} id={`${uid}-${i}`} data-i={i} role="option" aria-selected={i === selected} aria-disabled={o.disabled || undefined}
              data-active={i === active} className="select-option menu-item" style={{ animationDelay: `${Math.min(i, 8) * 18}ms` }}
              onPointerEnter={() => !o.disabled && setActive(i)} onClick={() => choose(i)}>
              <span className="min-w-0 break-words">{o.label}</span>
              {i === selected && (
                <svg className="shrink-0" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M4.5 10.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
