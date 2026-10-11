export interface Recipient { id: string; phone: string; whatsapp_opt_in: boolean; status: string }
export interface SendError { code: string; message: string }

/** Why a client must not get this message, or null when they are eligible. Opt-out is checked per client AND per phone, so a second row with the same number cannot get around it. */
export function eligibilityError(o: Recipient, optedOutIds: ReadonlySet<string>, suppressedPhones: ReadonlySet<string>, missing: string[]): SendError | null {
  if (!o.whatsapp_opt_in || optedOutIds.has(o.id) || suppressedPhones.has(o.phone)) return { code: 'OPT_OUT', message: 'Client has opted out of WhatsApp messages' }
  if (!/^\+[1-9]\d{7,14}$/.test(o.phone)) return { code: 'INVALID_PHONE', message: 'The phone number is not a valid international number' }
  if (o.status !== 'active') return { code: 'INACTIVE', message: 'Client is inactive' }
  if (missing.length) return { code: 'MISSING_VARIABLE', message: `Missing in the client data: ${missing.join(', ')}` }
  return null
}

/** Meta statuses a template can still be sent in. FLAGGED is a warning from Meta, not a block. */
export const SENDABLE_META = new Set(['APPROVED', 'FLAGGED'])

/** Why a template cannot be sent, or null. In live mode Meta's own status must be known and sendable: a local "approved" is not enough. */
export function templateBlock(tpl: { status: string; meta_status: string | null; entity_id: string; category?: string } | null, project: { entity_id: string } | null, live: boolean): string | null {
  if (!tpl || !project) return 'Template or client list not found'
  if (tpl.status !== 'APPROVED') return 'Only approved templates can be sent'
  if (tpl.category === 'AUTHENTICATION') return 'Authentication templates carry a one-time code, which sending to owner lists does not support'
  if (tpl.meta_status ? !SENDABLE_META.has(tpl.meta_status) : live) return `Meta has this template as ${tpl.meta_status ?? 'unknown'}, so it cannot be sent`
  if (tpl.entity_id !== project.entity_id) return 'Template belongs to a different entity'
  return null
}
