import { useState, type ReactNode } from 'react'
import { parseFormatting, type FmtNode } from '../lib/waFormat'
import { useI18n } from '../lib/i18n'

export type PreviewButtonType = 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY' | 'COPY_CODE' | 'AUTOFILL'
export interface PreviewMedia { kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; url?: string | null; name?: string }
export interface PreviewProps {
  header?: string | null
  body: string
  footer?: string | null
  buttons?: { type: PreviewButtonType; text: string }[]
  dir?: 'ltr' | 'rtl'
  media?: PreviewMedia | null
  /** When given, header, body and footer are the raw template text and {{name}} is replaced by these examples. */
  examples?: Record<string, string>
  businessName?: string
  /** shown instead of the body when it is empty */
  placeholder?: string
  wide?: boolean
}

/** WhatsApp's button icons, drawn as outlines. */
const ICON: Record<PreviewButtonType, ReactNode> = {
  URL: <><path d="M10 5H6.5A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15h7a1.5 1.5 0 0 0 1.5-1.5V10" /><path d="M12 4h4v4M16 4l-6 6" /></>,
  PHONE_NUMBER: <path d="M6.6 3.5 8.4 7.3 6.9 8.6a9 9 0 0 0 4.5 4.5l1.3-1.5 3.8 1.8-.4 2.3c-.1.6-.6 1-1.200 1A12.700 12.700 0 0 1 3.200 5.500c0-.6.4-1.100 1-1.200z" />,
  QUICK_REPLY: <path d="M8 5 3.500 9.500 8 14M3.500 9.500H12a4.500 4.500 0 0 1 4.500 4.500v1.500" />,
  COPY_CODE: <><rect x="7" y="7" width="9" height="9" rx="1.500" /><path d="M13 7V5.500A1.500 1.500 0 0 0 11.500 4h-6A1.500 1.500 0 0 0 4 5.500v6A1.500 1.500 0 0 0 5.500 13H7" /></>,
  AUTOFILL: <><rect x="3.500" y="5" width="13" height="10" rx="2" /><path d="M7 10h6M11 8l2 2-2 2" /></>,
}
const Icon = ({ type }: { type: PreviewButtonType }) => (
  <svg data-icon={type} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[type]}</svg>
)

/** Draws the formatting tree as React elements. Text goes in as text, never as HTML. */
function Nodes({ nodes, examples }: { nodes: FmtNode[]; examples?: Record<string, string> }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text': return n.text
      case 'var': {
        const v = examples?.[n.name]
        return v ? <span key={i} className="wa-var">{v}</span> : <span key={i} className="wa-var wa-var-empty" dir="ltr">{`{{${n.name}}}`}</span>
      }
      case 'b': return <strong key={i}><Nodes nodes={n.children} examples={examples} /></strong>
      case 'i': return <em key={i}><Nodes nodes={n.children} examples={examples} /></em>
      case 's': return <s key={i}><Nodes nodes={n.children} examples={examples} /></s>
      case 'm': return <code key={i} className="wa-mono"><Nodes nodes={n.children} examples={examples} /></code>
    }
  })
}

/** An image or video header. Shows what is happening to the file: nothing yet, loading, or failed. */
function MediaBlock({ media }: { media: PreviewMedia }) {
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading')
  if (media.kind === 'DOCUMENT') {
    return <div className="wa-doc" role="img" aria-label="Document"><span aria-hidden="true">▤</span><span className="truncate">{media.name || 'Document'}</span></div>
  }
  if (!media.url) return <div className="wa-media wa-media-empty">{media.kind === 'VIDEO' ? 'Video' : 'Image'} · no file yet</div>
  if (state === 'failed') return <div className="wa-media wa-media-empty" role="alert">The {media.kind === 'VIDEO' ? 'video' : 'image'} could not be loaded.</div>
  return (
    <div className="wa-media">
      {state === 'loading' && <div className="wa-media-skel" aria-hidden="true" />}
      {media.kind === 'VIDEO'
        ? <video src={media.url} controls preload="metadata" onLoadedMetadata={() => setState('ok')} onError={() => setState('failed')} />
        : <img src={media.url} alt="" onLoad={() => setState('ok')} onError={() => setState('failed')} />}
    </div>
  )
}

/** A WhatsApp-style conversation showing one incoming business message. A preview only, not the real app. */
export default function PhonePreview({ header, body, footer, buttons, dir, media, examples, businessName, placeholder, wide }: PreviewProps) {
  const { L } = useI18n()
  const shown = (buttons ?? []).filter((b) => b.text.trim())
  const folded = shown.length > 3
  const list = folded ? [...shown.slice(0, 2), { type: 'QUICK_REPLY' as const, text: L('See all options') }] : shown
  const name = businessName?.trim() || L('Your business')
  const rich = (s: string) => <Nodes nodes={parseFormatting(s)} examples={examples} />
  const plainHeader = header && examples ? header.replace(/\{\{([^{}]*)\}\}/g, (m, k) => examples[k.trim()] || m) : header
  return (
    <div className={`phone ${wide ? 'phone-wide' : ''}`} aria-label="WhatsApp preview" role="group">
      <div className="phone-bar"><span>WhatsApp</span><span>12:00</span></div>
      <div className="phone-head">
        <span className="phone-avatar" aria-hidden="true">{[...name][0]?.toUpperCase()}</span>
        <span className="min-w-0"><strong className="block truncate">{name}</strong><small className="block">{L('Business account')}</small></span>
      </div>
      <div className="phone-chat" dir={dir}>
        <p className="phone-day">{L('Today')}</p>
        <div className="bubble">
          <div className="bubble-body">
            {media ? <MediaBlock media={media} />
              : plainHeader ? <p className="text-ink font-bold mb-2 break-words">{plainHeader}</p> : null}
            {body.trim()
              ? <p className="whitespace-pre-wrap break-words text-ink">{rich(body)}</p>
              : <p className="text-ink-50 italic">{placeholder ?? L('Your message appears here as you type.')}</p>}
            {footer && <p className="text-xs text-ink-50 mt-3 break-words">{footer}</p>}
            <span className="bubble-time">12:00</span>
          </div>
          {list.length > 0 && (
            <div className="bubble-btns">
              {list.map((b, i) => <div key={i} className="bubble-btn"><Icon type={b.type} />{b.text}</div>)}
            </div>
          )}
        </div>
      </div>
      <p className="phone-note">{L('Preview only. The real message looks slightly different on each phone.')}</p>
    </div>
  )
}
