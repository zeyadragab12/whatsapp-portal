import { useState, type FormEvent } from 'react'
import { supabase, isCompanyEmail } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import { Field } from '../components/ui'

export default function AuthPage() {
  const { t, toggle } = useI18n()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(''); setInfo('')
    if (mode === 'up' && !isCompanyEmail(email)) { setError(t('domainOnly')); return }
    setBusy(true)
    if (mode === 'in') {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (error) setError(error.message)
    } else {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(), password, options: { data: { full_name: fullName.trim() } },
      })
      if (error) setError(error.message)
      else if (!data.session) setInfo(t('checkEmail'))
    }
    setBusy(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <section className="sheet w-full max-w-md p-8 md:p-10">
        <div className="w-full">
          <div className="flex items-center justify-between mb-8">
            <div>
              <img src="/brand/g-developments-logo-black.png" alt="G Developments" className="h-7 w-auto logo-light" />
              <img src="/brand/g-developments-logo-white.png" alt="G Developments" className="h-7 w-auto logo-dark" />
            </div>
            <button className="link-btn text-sm" onClick={toggle}>{t('language')}</button>
          </div>
          <h1 className="mb-1">{mode === 'in' ? t('signIn') : t('signUp')}</h1>
          <p className="text-ink-50 mb-7">{t('appName')}</p>
          <form onSubmit={submit} className="space-y-6">
            {mode === 'up' && (
              <Field label={t('fullName')}>
                <input required value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" />
              </Field>
            )}
            <Field label={t('email')}>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="email" placeholder="name@thegdevelopments.com" dir="ltr" />
            </Field>
            <Field label={t('password')}>
              <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'in' ? 'current-password' : 'new-password'} dir="ltr" />
            </Field>
            {error && <p role="alert" className="notice notice-bad">{error}</p>}
            {info && <p role="status" className="notice">{info}</p>}
            <button className="btn w-full" disabled={busy}>{mode === 'in' ? t('signIn') : t('signUp')}</button>
          </form>
          <p className="mt-7 text-sm text-ink-75">
            {mode === 'in' ? t('noAccount') : t('haveAccount')}{' '}
            <button className="link-btn" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(''); setInfo('') }}>
              {mode === 'in' ? t('signUp') : t('signIn')}
            </button>
          </p>
          {mode === 'up' && <p className="mt-3 text-sm text-ink-50">{t('domainOnly')}</p>}
        </div>
      </section>
    </div>
  )
}
