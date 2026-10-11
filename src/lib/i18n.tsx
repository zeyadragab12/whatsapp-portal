import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { AR as AR_BASE } from './ar'
import { AR2 } from './ar2'

const AR: Record<string, string> = { ...AR2, ...AR_BASE }

export type Lang = 'en' | 'ar'

const dict = {
  en: {
    appName: 'Owner messaging',
    templates: 'Templates', send: 'Send', log: 'Delivery log', requests: 'Requests', members: 'Members',
    entities: 'Entities', roles: 'Roles', signOut: 'Sign out', language: 'العربية',
    signIn: 'Sign in', signUp: 'Create account', email: 'Work email', password: 'Password', fullName: 'Full name',
    noAccount: 'No account yet?', haveAccount: 'Already registered?',
    domainOnly: 'Only @thegdevelopments.com addresses can register.',
    checkEmail: 'Check your inbox to confirm your email, then sign in. An administrator must approve your account before you can use it.',
    pendingTitle: 'Waiting for approval', pendingBody: 'Your account is registered. A G Developments administrator needs to approve it and assign your role.',
    rejectedBody: 'Your registration was not approved. Contact your administrator.',
    suspendedBody: 'Your account is suspended. Contact your administrator.',
    refresh: 'Check again',
    newTemplate: 'New template', edit: 'Edit', archive: 'Archive', restore: 'Restore', save: 'Save', cancel: 'Cancel',
    active: 'Active', archived: 'Archived', name: 'Name', entity: 'Entity', language_: 'Language', status: 'WhatsApp status',
    version: 'Version', updated: 'Updated', actions: 'Actions', allEntities: 'All entities',
    body: 'Message text', variables: 'Insert variable', preview: 'Preview', previewNote: 'Preview with sample values.',
    submitApproval: 'Submit for approval', approveDemo: 'Approve (demo)',
    draft: 'Draft', pending: 'Pending', approved: 'Approved', rejected: 'Rejected', suspended: 'Suspended',
    editNote: 'Editing the text creates a new version and returns the template to Draft.',
    noTemplates: 'No templates yet.',
    step: 'Step', project: 'Project', template: 'Template', review: 'Review',
    chooseProject: 'Choose the project', chooseTemplate: 'Choose an approved template',
    recipients: 'Recipients', owners: 'owners', sendTo: 'Send to', next: 'Next', back: 'Back',
    demoBanner: 'Demo mode. Messages are recorded but not sent to WhatsApp.',
    noProjects: 'No projects are assigned to you.', noApproved: 'No approved templates for this entity.',
    sent: 'Sent', sentBody: 'Message recorded for', viewLog: 'View delivery log',
    date: 'Date', count: 'Recipients', mode: 'Mode', sentBy: 'Sent by', phone: 'Phone', unit: 'Unit',
    sample: 'Sample', approve: 'Approve', reject: 'Reject', pendingRequests: 'Pending requests',
    noPending: 'No pending requests.', assignAccess: 'Assign access', addEntity: 'Add entity', role: 'Role',
    projectsAllowed: 'Projects this member can send for', superadmin: 'Super admin', suspend: 'Suspend', reactivate: 'Reactivate',
    permissions: 'Permissions', addProject: 'Add project', location: 'Location', addAccess: 'Add entity access',
    loading: 'Loading', error: 'Something went wrong', 'p.template.read': 'Read templates', 'p.template.create': 'Create templates',
    'p.template.update': 'Update templates', 'p.template.archive': 'Archive templates', 'p.message.send': 'Send messages',
    'p.member.manage': 'Manage members', 'p.log.read': 'Read delivery log', remove: 'Remove', typeToConfirm: 'Type the name to confirm',
    noAccess: 'You do not have access to this page.', welcome: 'Signed in as',
    overview: 'Overview', administration: 'Administration', menu: 'Menu', close: 'Close',
    approvedTemplates: 'Approved templates', pendingApproval: 'Pending approval', sentLast30: 'Sends, last 30 days',
    pendingRequestsKpi: 'Pending requests', recentSends: 'Recent sends', noSends: 'No messages sent yet.',
  },
  ar: {
    appName: 'مراسلة الملاك',
    templates: 'القوالب', send: 'إرسال', log: 'سجل الإرسال', requests: 'الطلبات', members: 'الأعضاء',
    entities: 'الكيانات', roles: 'الأدوار', signOut: 'تسجيل الخروج', language: 'English',
    signIn: 'تسجيل الدخول', signUp: 'إنشاء حساب', email: 'البريد الإلكتروني للعمل', password: 'كلمة المرور', fullName: 'الاسم الكامل',
    noAccount: 'ليس لديك حساب؟', haveAccount: 'لديك حساب بالفعل؟',
    domainOnly: 'التسجيل متاح فقط لعناوين @thegdevelopments.com.',
    checkEmail: 'تحقق من بريدك لتأكيد العنوان ثم سجّل الدخول. يجب أن يوافق المسؤول على حسابك قبل استخدامه.',
    pendingTitle: 'بانتظار الموافقة', pendingBody: 'تم تسجيل حسابك. يحتاج مسؤول G Developments إلى الموافقة عليه وتحديد دورك.',
    rejectedBody: 'لم تتم الموافقة على تسجيلك. تواصل مع المسؤول.',
    suspendedBody: 'حسابك موقوف. تواصل مع المسؤول.',
    refresh: 'تحقق مرة أخرى',
    newTemplate: 'قالب جديد', edit: 'تعديل', archive: 'أرشفة', restore: 'استعادة', save: 'حفظ', cancel: 'إلغاء',
    active: 'نشط', archived: 'مؤرشف', name: 'الاسم', entity: 'الكيان', language_: 'اللغة', status: 'حالة واتساب',
    version: 'الإصدار', updated: 'آخر تحديث', actions: 'إجراءات', allEntities: 'كل الكيانات',
    body: 'نص الرسالة', variables: 'إدراج متغير', preview: 'معاينة', previewNote: 'معاينة بقيم تجريبية.',
    submitApproval: 'إرسال للموافقة', approveDemo: 'موافقة (تجريبي)',
    draft: 'مسودة', pending: 'قيد المراجعة', approved: 'موافق عليه', rejected: 'مرفوض', suspended: 'موقوف',
    editNote: 'تعديل النص ينشئ إصدارًا جديدًا ويعيد القالب إلى حالة المسودة.',
    noTemplates: 'لا توجد قوالب بعد.',
    step: 'الخطوة', project: 'المشروع', template: 'القالب', review: 'مراجعة',
    chooseProject: 'اختر المشروع', chooseTemplate: 'اختر قالبًا موافقًا عليه',
    recipients: 'المستلمون', owners: 'ملاك', sendTo: 'إرسال إلى', next: 'التالي', back: 'السابق',
    demoBanner: 'وضع تجريبي. يتم تسجيل الرسائل ولا تُرسل إلى واتساب.',
    noProjects: 'لا توجد مشاريع مخصصة لك.', noApproved: 'لا توجد قوالب موافق عليها لهذا الكيان.',
    sent: 'تم', sentBody: 'تم تسجيل الرسالة لعدد', viewLog: 'عرض سجل الإرسال',
    date: 'التاريخ', count: 'المستلمون', mode: 'الوضع', sentBy: 'المرسل', phone: 'الهاتف', unit: 'الوحدة',
    sample: 'نموذج', approve: 'موافقة', reject: 'رفض', pendingRequests: 'الطلبات المعلقة',
    noPending: 'لا توجد طلبات معلقة.', assignAccess: 'تحديد الصلاحيات', addEntity: 'إضافة كيان', role: 'الدور',
    projectsAllowed: 'المشاريع التي يمكن للعضو الإرسال لها', superadmin: 'مسؤول عام', suspend: 'إيقاف', reactivate: 'إعادة تفعيل',
    permissions: 'الصلاحيات', addProject: 'إضافة مشروع', location: 'الموقع', addAccess: 'إضافة صلاحية كيان',
    loading: 'جارٍ التحميل', error: 'حدث خطأ', 'p.template.read': 'قراءة القوالب', 'p.template.create': 'إنشاء القوالب',
    'p.template.update': 'تحديث القوالب', 'p.template.archive': 'أرشفة القوالب', 'p.message.send': 'إرسال الرسائل',
    'p.member.manage': 'إدارة الأعضاء', 'p.log.read': 'قراءة سجل الإرسال', remove: 'إزالة', typeToConfirm: 'اكتب الاسم للتأكيد',
    noAccess: 'ليس لديك صلاحية لهذه الصفحة.', welcome: 'مسجل الدخول باسم',
    overview: 'نظرة عامة', administration: 'الإدارة', menu: 'القائمة', close: 'إغلاق',
    approvedTemplates: 'القوالب الموافق عليها', pendingApproval: 'بانتظار الموافقة', sentLast30: 'الرسائل، آخر 30 يومًا',
    pendingRequestsKpi: 'الطلبات المعلقة', recentSends: 'آخر الرسائل', noSends: 'لم تُرسل رسائل بعد.',
  },
} as const

export type Key = keyof (typeof dict)['en']

interface Ctx { lang: Lang; t: (k: Key) => string; L: (en: string) => string; toggle: () => void }
const I18n = createContext<Ctx>(null as never)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    try { return localStorage.getItem('lang') === 'ar' ? 'ar' : 'en' } catch { return 'en' }
  })
  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    try { localStorage.setItem('lang', lang) } catch { /* storage unavailable */ }
  }, [lang])
  const value: Ctx = {
    lang,
    t: (k) => dict[lang][k] ?? dict.en[k],
    // English text is the key; strings without an Arabic entry stay in English
    L: (en) => (lang === 'ar' ? AR[en] ?? en : en),
    toggle: () => setLang((l) => (l === 'en' ? 'ar' : 'en')),
  }
  return <I18n.Provider value={value}>{children}</I18n.Provider>
}
export const useI18n = () => useContext(I18n)
