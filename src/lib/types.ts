import type { AuthOptions } from '../../supabase/functions/_shared/templateRules'
export type Perm =
  | 'template.read' | 'template.create' | 'template.update' | 'template.archive' | 'template.submit'
  | 'message.send' | 'owner.read' | 'owner.manage' | 'member.manage' | 'log.read' | 'log.all' | 'analytics.read' | 'inbox.read' | 'inbox.reply'

export const ALL_PERMS: Perm[] = [
  'template.read', 'template.create', 'template.update', 'template.archive', 'template.submit',
  'message.send', 'owner.read', 'owner.manage', 'member.manage', 'log.read', 'log.all', 'analytics.read', 'inbox.read', 'inbox.reply',
]

export interface Profile {
  id: string
  email: string
  full_name: string | null
  status: 'pending' | 'approved' | 'rejected' | 'suspended'
  is_superadmin: boolean
  created_at: string
}
export interface Entity { id: string; name: string; slug: string; status: 'active' | 'inactive' }
export interface Role { id: string; name: string; description: string | null; permissions: Perm[]; is_system: boolean }
export interface Project {
  id: string; entity_id: string; name: string; code: string; location: string | null
  status: 'active' | 'archived'; is_sample: boolean
}
export interface Membership {
  entity_id: string
  role_id: string
  roles: { name: string; permissions: Perm[] } | null
}

export type TStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'ARCHIVED'
export type Category = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
export type MsgStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'

export interface TemplateVar { name: string; example: string; source: string }
export interface TButton { type: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY'; text: string; url?: string; phone?: string }
export interface Template {
  id: string
  entity_id: string
  project_ids: string[]
  name: string
  category: Category
  language: 'en' | 'ar'
  header_text: string | null
  body_text: string
  footer_text: string | null
  variables: TemplateVar[]
  buttons: TButton[]
  status: TStatus
  previous_status: TStatus | null
  meta_name: string | null
  meta_template_id: string | null
  meta_submitted_at: string | null
  rejection_reason: string | null
  meta_status: string | null
  meta_status_prev: string | null
  meta_approved_once: boolean
  parameter_format: 'NAMED' | 'POSITIONAL'
  header_media_id: string | null
  auth_options: Partial<AuthOptions> | null
  version: number
  updated_at: string
}

/** An image or video in a company's media library, usable as a template header. */
export interface MediaAsset {
  id: string
  entity_id: string
  kind: 'IMAGE' | 'VIDEO'
  name: string
  path: string
  mime_type: string
  size_bytes: number
  created_at: string
}
export const MEDIA_BUCKET = 'template-media'
export const MEDIA_LIMITS = { IMAGE: 5 * 1024 * 1024, VIDEO: 16 * 1024 * 1024 }
export const MEDIA_TYPES: Record<string, 'IMAGE' | 'VIDEO'> = { 'image/jpeg': 'IMAGE', 'image/png': 'IMAGE', 'video/mp4': 'VIDEO', 'video/3gpp': 'VIDEO' }

/** Meta statuses that still allow sending. Anything else (paused, disabled, archived, ...) blocks it. */
export const metaSendable = (s: string | null) => s === null || s === 'APPROVED' || s === 'FLAGGED'
export const isSendable = (t: Pick<Template, 'status' | 'meta_status'> & { category?: Category }) => t.status === 'APPROVED' && t.category !== 'AUTHENTICATION' && metaSendable(t.meta_status)

export interface Owner {
  id: string; full_name: string; phone: string; email: string | null
  whatsapp_opt_in: boolean; status: 'active' | 'inactive'
}
export interface ProjectOwner { unit_no: string | null; extra: Record<string, string>; owners: Owner }

export interface MessageLog {
  id: string; batch_id: string | null; entity_id: string; project_id: string; template_id: string
  owner_id: string | null; sender_id: string; phone_number: string; payload: unknown; wamid: string | null
  status: MsgStatus; error_details: { code?: string; message?: string } | null
  cost_estimate: number; created_at: string; updated_at: string
  attempts: number; last_error: string | null; sent_at: string | null
}

export interface Conversation {
  id: string; entity_id: string; phone_number: string; owner_id: string | null; contact_name: string | null; project_ids: string[]
  last_inbound_at: string | null; last_message_at: string; last_message_preview: string | null; unread_count: number
  status: 'open' | 'closed'; assigned_to: string | null
}
export interface ConvMessage {
  id: string; conversation_id: string; direction: 'in' | 'out'; type: string; body: string | null; wamid: string | null
  status: MsgStatus | null; error: string | null; sent_by: string | null; created_at: string
}
export interface AppNotification {
  id: string; entity_id: string | null; kind: string; severity: 'info' | 'warning' | 'critical'
  title: string; body: string | null; link: string | null; created_at: string
}

/** How many live messages a company may still send today (from the send_allowance function). */
export interface SendAllowance {
  warmup_on: boolean; warmup_day: number | null; warmup_done: boolean; warmup_limit: number | null
  daily_cap: number | null; limit: number | null; reason: 'warmup' | 'cap' | null; used: number; remaining: number | null
}

export interface Preflight {
  mode: 'demo' | 'live'; portfolio: string; limit: number | null; unique_24h: number; new_unique: number
  quality: string | null; phone_status: string | null; checked_at: string | null; warnings: string[]; blocking: boolean
}

/* ---------- variables and payload (mirrors the send-whatsapp-template function) ---------- */

export const extractVars = (s: string | null | undefined): string[] =>
  [...new Set([...(s ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))]

export const templateVarNames = (t: { header_text: string | null; body_text: string }) =>
  [...new Set([...extractVars(t.header_text), ...extractVars(t.body_text)])]

/** Fields every owner has. Imported columns add more (see OwnerField). */
export const BUILTIN_FIELDS: { key: string; label: string; example: string; legacy?: boolean }[] = [
  { key: 'owner_name', label: 'Owner name', example: 'Sara Hassan' },
  { key: 'unit_number', label: 'Unit number', example: 'A-101' },
  { key: 'project_name', label: 'Company name', example: 'G Communities', legacy: true },
  { key: 'project_code', label: 'Project code', example: 'GC', legacy: true },
  { key: 'entity_name', label: 'Company name', example: 'G Communities' },
  { key: 'phone', label: 'Phone number', example: '+201000000000' },
  { key: 'email', label: 'Email', example: 'owner@example.com' },
]
export const RESERVED_FIELD_KEYS = BUILTIN_FIELDS.map((f) => f.key)
export interface OwnerField { key: string; label: string; example: string; builtin: boolean; legacy?: boolean }

const LEGACY_SOURCES: Record<string, string> = {
  'owner.full_name': 'owner_name', 'owner.unit_number': 'unit_number', 'owner.phone': 'phone', 'owner.email': 'email',
  'project.name': 'project_name', 'project.code': 'project_code', 'entity.name': 'entity_name',
}
/** Which owner field fills a placeholder. Named placeholders use their own name. */
export const fieldKeyOf = (v: { name: string; source?: string } | undefined, name: string): string => {
  const s = v?.source
  if (!s || s === 'static') return name
  return LEGACY_SOURCES[s] ?? s.replace(/^field\./, '')
}
/** Turns a spreadsheet heading into a safe field name, for example "Due Date" becomes due_date. */
export const slugField = (heading: string): string => {
  let k = heading.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (/^\d/.test(k)) k = 'f_' + k
  return k.slice(0, 40)
}

export const langCode = (l: string) => (l === 'ar' ? 'ar' : 'en_US')
export const cleanParam = (v: string) => v.replace(/[\r\n\t]+/g, ' ').replace(/ {5,}/g, '    ').trim()

export function buildPayload(
  tpl: { meta_name: string | null; name: string; language: string; header_text: string | null; body_text: string; parameter_format?: string },
  values: Record<string, string>, phone: string, media?: { kind: 'IMAGE' | 'VIDEO'; url: string } | null,
) {
  const positional = tpl.parameter_format === 'POSITIONAL'
  const order = (names: string[]) => (positional ? [...names].sort((a, b) => Number(a) - Number(b)) : names)
  const params = (names: string[]) => order(names).map((n) => (positional
    ? { type: 'text', text: cleanParam(values[n] ?? '') }
    : { type: 'text', parameter_name: n, text: cleanParam(values[n] ?? '') }))
  const components: unknown[] = []
  const header = extractVars(tpl.header_text), body = extractVars(tpl.body_text)
  if (media) components.push({ type: 'header', parameters: [media.kind === 'VIDEO' ? { type: 'video', video: { link: media.url } } : { type: 'image', image: { link: media.url } }] })
  else if (header.length) components.push({ type: 'header', parameters: params(header) })
  if (body.length) components.push({ type: 'body', parameters: params(body) })
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone.replace(/^\+/, ''),
    type: 'template',
    template: { name: tpl.meta_name ?? tpl.name, language: { code: langCode(tpl.language) }, components },
  }
}

export const fillText = (text: string | null, values: Record<string, string>) =>
  (text ?? '').replace(/\{\{(\w+)\}\}/g, (m, k) => values[k] || m)

/* ---------- phone helpers ---------- */

export { normalizePhone, isE164, phoneProblem, parsePhone } from './phone'
export const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, 3)}${'•'.repeat(p.length - 7)}${p.slice(-4)}` : p)

export const OPTOUT_RE = /^(opted[\s_-]*out|opt[\s_-]*out|unsubscribed?|stop|do[\s_-]*not[\s_-]*(contact|message|call))$/i
