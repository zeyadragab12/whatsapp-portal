import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './lib/auth'
import { I18nProvider, useI18n } from './lib/i18n'
import { ThemeProvider } from './lib/theme'
import Shell from './components/Shell'
import { DialogProvider } from './components/Dialog'
import AuthPage from './pages/Auth'
import PendingPage from './pages/Pending'
import Overview from './pages/Overview'
import { TemplateEditor, TemplateList } from './pages/Templates'
import OwnersPage from './pages/Owners'
import SendPage from './pages/Send'
import AlertsPage from './pages/Alerts'
import LogPage from './pages/Log'
import { PeoplePage } from './pages/People'
import { Entities } from './pages/Entities'
import Settings from './pages/Settings'
import { Loading, Notice } from './components/ui'

function Guard({ ok, children }: { ok: boolean; children: ReactNode }) {
  const { t } = useI18n()
  return ok ? <>{children}</> : <Notice>{t('noAccess')}</Notice>
}

function Routed() {
  const { session, profile, loading, can, entitiesWith, isSuper } = useAuth()
  if (loading) return <div className="p-12"><Loading /></div>
  if (!session) return <AuthPage />
  if (profile?.status !== 'approved') return <PendingPage />
  const manager = isSuper || entitiesWith('member.manage').length > 0
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/overview" element={<Overview />} />
        <Route path="/templates" element={<Guard ok={can('template.read')}><TemplateList /></Guard>} />
        <Route path="/templates/new" element={<Guard ok={entitiesWith('template.create').length > 0}><TemplateEditor /></Guard>} />
        <Route path="/templates/:id" element={<Guard ok={can('template.read')}><TemplateEditor /></Guard>} />
        <Route path="/owners" element={<Guard ok={can('owner.read')}><OwnersPage /></Guard>} />
        <Route path="/send" element={<Guard ok={can('message.send')}><SendPage /></Guard>} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/log" element={<Guard ok={can('log.read')}><LogPage /></Guard>} />
        <Route path="/admin/people" element={<Guard ok={manager}><PeoplePage /></Guard>} />
        <Route path="/admin/requests" element={<Navigate to="/admin/people?tab=requests" replace />} />
        <Route path="/admin/members" element={<Navigate to="/admin/people?tab=members" replace />} />
        <Route path="/admin/roles" element={<Navigate to="/admin/people?tab=roles" replace />} />
        <Route path="/admin/entities" element={<Guard ok={isSuper}><Entities /></Guard>} />
        <Route path="/admin/access" element={<Navigate to="/admin/people" replace />} />
        <Route path="/admin/settings" element={<Guard ok={isSuper}><Settings /></Guard>} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <DialogProvider><BrowserRouter><Routed /></BrowserRouter></DialogProvider>
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
