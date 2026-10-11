import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'

export default function PendingPage() {
  const { profile, reload, signOut } = useAuth()
  const { t, toggle } = useI18n()
  const body = profile?.status === 'rejected' ? t('rejectedBody')
    : profile?.status === 'suspended' ? t('suspendedBody') : t('pendingBody')
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <section className="sheet w-full max-w-md p-8 md:p-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <img src="/brand/g-developments-logo-black.png" alt="G Developments" className="h-7 w-auto logo-light" />
            <img src="/brand/g-developments-logo-white.png" alt="G Developments" className="h-7 w-auto logo-dark" />
          </div>
          <button className="link-btn text-sm" onClick={toggle}>{t('language')}</button>
        </div>
        <h1 className="mb-3">{profile?.status === 'pending' || !profile ? t('pendingTitle') : t(profile.status)}</h1>
        <p className="mb-2 text-ink-75">{body}</p>
        <p className="text-ink-50 mb-7">{profile?.email}</p>
        <div className="flex gap-3 items-center">
          <button className="btn" onClick={reload}>{t('refresh')}</button>
          <button className="btn btn-quiet" onClick={signOut}>{t('signOut')}</button>
        </div>
      </section>
    </div>
  )
}
