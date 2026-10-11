import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { useDialog } from './Dialog'
import { MEDIA_BUCKET, MEDIA_LIMITS, MEDIA_TYPES, type MediaAsset } from '../lib/types'
import { ErrorNote } from './ui'

export const mediaUrl = (path: string) => supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl
const mb = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`

/** The company's saved images and videos. Pick one for a template header, or upload a new one that stays here for everyone in the company to reuse. */
export default function MediaPicker({ entityId, value, onChange, canRemove = true }: {
  entityId: string; value: string | null; onChange: (asset: MediaAsset | null) => void; canRemove?: boolean
}) {
  const { L } = useI18n()
  const { session } = useAuth()
  const { confirm } = useDialog()
  const [items, setItems] = useState<MediaAsset[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!entityId) return
    const { data, error } = await supabase.from('media_assets').select('*').eq('entity_id', entityId).order('created_at', { ascending: false })
    if (error) setError(error.message)
    setItems((data as MediaAsset[]) ?? [])
  }, [entityId])
  useEffect(() => { setItems(null); load() }, [load])

  async function upload(f: File) {
    setError('')
    const kind = MEDIA_TYPES[f.type]
    if (!kind) { setError(L('Use a JPG or PNG image, or an MP4 video.')); return }
    if (f.size > MEDIA_LIMITS[kind]) { setError(`${kind === 'IMAGE' ? L('Images') : L('Videos')} ${L('can be up to')} ${mb(MEDIA_LIMITS[kind])}.`); return }
    setBusy(true)
    const path = `${entityId}/${crypto.randomUUID()}.${f.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || (kind === 'IMAGE' ? 'jpg' : 'mp4')}`
    const up = await supabase.storage.from(MEDIA_BUCKET).upload(path, f, { contentType: f.type, upsert: false })
    if (up.error) { setBusy(false); setError(up.error.message); return }
    const { data, error } = await supabase.from('media_assets').insert({
      entity_id: entityId, kind, name: f.name.replace(/\.[^.]+$/, '').slice(0, 120) || f.name, path, mime_type: f.type, size_bytes: f.size, created_by: session?.user.id,
    }).select('*').single()
    if (error) { await supabase.storage.from(MEDIA_BUCKET).remove([path]); setBusy(false); setError(error.message); return }
    setBusy(false)
    await load()
    onChange(data as MediaAsset)
  }

  async function remove(a: MediaAsset) {
    const ok = await confirm({
      title: L('Delete this file?'), danger: true, confirmLabel: L('Delete'),
      message: `${a.name} ${L('will be removed from the media library for everyone in this company.')}`,
    })
    if (!ok) return
    setError('')
    const { error } = await supabase.from('media_assets').delete().eq('id', a.id)
    if (error) { setError(error.code === '23503' ? L('A template still uses this file. Change that template first.') : error.message); return }
    await supabase.storage.from(MEDIA_BUCKET).remove([a.path])
    if (value === a.id) onChange(null)
    load()
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input ref={file} type="file" accept="image/jpeg,image/png,video/mp4" className="sr-only" aria-label={L('Upload an image or video')}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f) }} />
        <button type="button" className="btn btn-quiet btn-sm" disabled={busy || !entityId} onClick={() => file.current?.click()}>
          {busy ? L('Uploading…') : L('Upload new')}
        </button>
        {value && <button type="button" className="link-btn" onClick={() => onChange(null)}>{L('Send without an image or video')}</button>}
        <span className="text-sm text-ink-50">{L('JPG or PNG up to 5 MB, MP4 up to 16 MB.')}</span>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {items === null ? <p className="text-sm text-ink-50">…</p> : items.length === 0 ? (
        <p className="text-sm text-ink-50">{L('No saved files yet. Upload one and it stays here for your company to reuse.')}</p>
      ) : (
        <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {items.map((a) => {
            const on = a.id === value
            return (
              <li key={a.id} className={`rounded-xl border p-2 ${on ? 'border-ink ring-2 ring-ink' : 'border-ink-25'}`}>
                <button type="button" className="block w-full text-start" aria-pressed={on} onClick={() => onChange(a)}>
                  {a.kind === 'VIDEO'
                    ? <video src={`${mediaUrl(a.path)}#t=0.1`} preload="metadata" muted className="w-full h-24 object-cover rounded-lg bg-black pointer-events-none" />
                    : <img src={mediaUrl(a.path)} alt="" loading="lazy" className="w-full h-24 object-cover rounded-lg" />}
                  <span className="block text-sm text-ink truncate mt-1" title={a.name}>{a.name}</span>
                  <span className="block text-xs text-ink-50">{a.kind === 'VIDEO' ? L('Video') : L('Image')} · {mb(a.size_bytes)}</span>
                </button>
                {canRemove && <button type="button" className="link-btn text-xs mt-1" onClick={() => remove(a)}>{L('Delete')}</button>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
