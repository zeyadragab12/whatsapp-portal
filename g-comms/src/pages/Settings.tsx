import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import { ErrorNote, Field, Loading, Notice, PageHead } from '../components/ui'

interface Status { mode: 'demo' | 'live'; api_version: string; has_token: boolean; has_secret: boolean; verify_token: string }
interface Price { category: string; rate: number; currency: string }

export default function Settings() {
  const { L } = useI18n()
  const [st, setSt] = useState<Status | null>(null)
  const [mode, setMode] = useState<'demo' | 'live'>('demo')
  const [version, setVersion] = useState('')
  const [token, setToken] = useState('')
  const [secret, setSecret] = useState('')
  const [prices, setPrices] = useState<Price[]>([])
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [copied, setCopied] = useState(false)

  const load = async () => {
    const [{ data: s }, { data: p }] = await Promise.all([supabase.rpc('get_whatsapp_status'), supabase.from('message_pricing').select('*').order('category')])
    const status = s as Status
    setSt(status); setMode(status.mode); setVersion(status.api_version)
    setPrices((p as Price[]) ?? [])
  }
  useEffect(() => { load() }, [])

  async function saveGlobal(e: FormEvent) {
    e.preventDefault(); setError(''); setInfo('')
    const { error } = await supabase.rpc('save_whatsapp_global', { p_mode: mode, p_api_version: version, p_access_token: token, p_app_secret: secret })
    if (error) { setError(error.message); return }
    setToken(''); setSecret(''); setInfo(L('Saved.')); load()
  }

  async function savePrice(p: Price) {
    setError(''); setInfo('')
    const { error } = await supabase.from('message_pricing').update({ rate: p.rate, currency: p.currency, updated_at: new Date().toISOString() }).eq('category', p.category)
    if (error) setError(error.message); else setInfo(L('Saved.'))
  }

  if (!st) return <Loading />
  const webhook = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-webhook`

  return (
    <>
      <PageHead title={L('Settings')} sub={L('Settings that apply to every company. Each company’s own WhatsApp number is set from the Companies page.')} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {info && <Notice>{info}</Notice>}

      <form onSubmit={saveGlobal} className="space-y-6 max-w-2xl mb-14">
        <h2>{L('Shared settings')}</h2>
        <fieldset className="border-0 p-0 m-0">
          <legend className="text-sm text-ink-75 mb-2">{L('Master switch')}</legend>
          <div className="flex flex-wrap gap-8">
            {(['demo', 'live'] as const).map((m) => (
              <label key={m} className="flex items-center gap-3 min-h-9">
                <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
                <span>{m === 'demo' ? L('Demo for every entity') : L('Allow entities set to Live to send')}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid sm:grid-cols-2 gap-6">
          <Field label={L('Graph API version')} hint={L('Check Meta’s changelog and use a version that has not expired.')}><input dir="ltr" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v23.0" /></Field>
          <span />
          <Field label={L('Shared access token')} hint={st.has_token ? L('A token is stored. Leave blank to keep it.') : L('Optional. Used by entities without their own token, for example a system-user token that covers several WABAs.')}>
            <input type="password" autoComplete="off" dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <Field label={L('Shared app secret')} hint={st.has_secret ? L('A secret is stored. Leave blank to keep it.') : L('Needed to verify webhooks from your Meta app.')}>
            <input type="password" autoComplete="off" dir="ltr" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
        </div>
        <button className="btn">{L('Save')}</button>
      </form>

      <section className="max-w-2xl mb-14">
        <h2 className="mb-2">{L('Webhook')}</h2>
        <p className="text-sm text-ink-50 mb-4">{L('One webhook serves every entity. In the Meta App dashboard, open WhatsApp > Configuration and paste these two values. Subscribe to the messages and message_template_status_update fields. Do this for each Meta app you use.')}</p>
        <dl className="grid grid-cols-[9rem_1fr] gap-y-3 text-sm">
          <dt className="text-ink-50">{L('Callback URL')}</dt><dd className="text-ink break-all" dir="ltr">{webhook}</dd>
          <dt className="text-ink-50">{L('Verify token')}</dt>
          <dd className="text-ink break-all" dir="ltr">{st.verify_token} <button type="button" className="link-btn ms-3" onClick={() => { navigator.clipboard?.writeText(st.verify_token); setCopied(true) }}>{copied ? L('Copied') : L('Copy')}</button></dd>
        </dl>
      </section>

      <section className="max-w-2xl">
        <h2 className="mb-2">{L('Pricing')}</h2>
        <p className="text-sm text-ink-50 mb-4">{L('Cost per message by category, used for the estimate on the overview. Enter the rates from your Meta rate card; they start at zero.')}</p>
        <table className="grid-table">
          <thead><tr><th>{L('Category')}</th><th>{L('Rate per message')}</th><th>{L('Currency')}</th><th /></tr></thead>
          <tbody>
            {prices.map((p, i) => (
              <tr key={p.category}>
                <td className="cell-title">{L(p.category.charAt(0) + p.category.slice(1).toLowerCase())}</td>
                <td data-label={L('Rate per message')}><Field label=""><input type="number" step="0.0001" min="0" aria-label={`${p.category} rate`} value={p.rate} onChange={(e) => setPrices(prices.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)))} /></Field></td>
                <td data-label={L('Currency')}><Field label=""><input maxLength={3} aria-label={`${p.category} currency`} value={p.currency} onChange={(e) => setPrices(prices.map((x, j) => (j === i ? { ...x, currency: e.target.value.toUpperCase() } : x)))} /></Field></td>
                <td className="cell-actions"><button className="link-btn" onClick={() => savePrice(p)}>{L('Save')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}
