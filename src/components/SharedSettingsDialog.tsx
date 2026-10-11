import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import { ErrorNote, Field, Loading, Notice } from './ui'
import { Modal } from './Dialog'

interface Status { mode: 'demo' | 'live'; api_version: string; verify_token: string }

/** Settings that apply to every company: the master switch, the webhook Meta calls, and message prices. */
export default function SharedSettingsDialog({ onClose }: { onClose: () => void }) {
  const { L } = useI18n()
  const [st, setSt] = useState<Status | null>(null)
  const [mode, setMode] = useState<'demo' | 'live'>('demo')
  const [version, setVersion] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [copied, setCopied] = useState('')

  const load = async () => {
    const { data: s } = await supabase.rpc('get_whatsapp_status')
    const status = s as Status
    setSt(status); setMode(status.mode); setVersion(status.api_version)
  }
  useEffect(() => { load() }, [])

  async function saveGlobal(e: FormEvent) {
    e.preventDefault(); setError(''); setInfo('')
    // blank token and secret keep what is stored; they are edited from a company's WhatsApp link
    const { error } = await supabase.rpc('save_whatsapp_global', { p_mode: mode, p_api_version: version, p_access_token: '', p_app_secret: '' })
    if (error) { setError(error.message); return }
    setInfo(L('Saved.')); load()
  }

  const webhook = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-webhook`
  const copy = (key: string, text: string) => { navigator.clipboard?.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 1500) }

  return (
    <Modal title={L('Shared settings')} onClose={onClose} size="wide">
      {!st ? <Loading /> : (
        <div className="space-y-8">
          {error && <ErrorNote>{error}</ErrorNote>}
          {info && <Notice tone="ok">{info}</Notice>}

          <form onSubmit={saveGlobal} className="space-y-4">
            <h4 className="text-ink font-bold">{L('Sending')}</h4>
            <fieldset className="border-0 p-0 m-0">
              <legend className="text-sm text-ink-75 mb-2">{L('Master switch')}</legend>
              <div className="space-y-1">
                {(['demo', 'live'] as const).map((m) => (
                  <label key={m} className="flex items-center gap-3 min-h-9">
                    <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
                    <span>{m === 'demo' ? L('Demo for every company') : L('Allow companies set to Live to send')}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="max-w-xs">
              <Field label={L('Graph API version')} hint={L('Check Meta’s changelog and use a version that has not expired.')}>
                <input dir="ltr" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v23.0" />
              </Field>
            </div>
            <button className="btn btn-quiet">{L('Save')}</button>
          </form>

          <section>
            <h4 className="text-ink font-bold mb-1">{L('Webhook')}</h4>
            <p className="text-sm text-ink-50 mb-3">{L('One webhook serves every company. In the Meta App dashboard, open WhatsApp > Configuration and paste these two values. Subscribe to the messages and message_template_status_update fields. Do this for each Meta app you use.')}</p>
            <dl className="grid grid-cols-1 gap-y-3 text-sm">
              {[[L('Callback URL'), webhook, 'url'], [L('Verify token'), st.verify_token, 'token']].map(([label, value, key]) => (
                <div key={key} className="rounded-xl bg-card px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <dt className="text-ink-50">{label}</dt>
                    <dd className="text-ink break-all" dir="ltr">{value}</dd>
                  </div>
                  <button type="button" className="link-btn" onClick={() => copy(key, value)}>{copied === key ? L('Copied') : L('Copy')}</button>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
    </Modal>
  )
}
