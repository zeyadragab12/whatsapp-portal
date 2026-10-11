import { createClient } from 'npm:@supabase/supabase-js@2'

const enc = new TextEncoder()
const MAP: Record<string, string> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' }

async function signatureMatches(raw: string, header: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(raw)))
  const expected = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
  const got = header.slice(7)
  if (got.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

// Pulls readable text out of every inbound message type Meta can send.
function inboundBody(m: any): string {
  switch (m?.type) {
    case 'text': return String(m.text?.body ?? '')
    case 'button': return String(m.button?.text ?? m.button?.payload ?? '')
    case 'interactive': return String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '')
    case 'image': case 'video': case 'document': return String(m[m.type]?.caption ?? '')
    case 'reaction': return String(m.reaction?.emoji ?? '')
    case 'location': return [m.location?.name, m.location?.address].filter(Boolean).join(', ')
    default: return ''
  }
}

Deno.serve(async (req) => {
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: cfg } = await svc.from('whatsapp_config').select('verify_token, app_secret').eq('id', 1).single()

  if (req.method === 'GET') {
    const p = new URL(req.url).searchParams
    if (p.get('hub.mode') === 'subscribe' && cfg?.verify_token && p.get('hub.verify_token') === cfg.verify_token) {
      return new Response(p.get('hub.challenge') ?? '', { status: 200 })
    }
    return new Response('Forbidden', { status: 403 })
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const raw = await req.text()
  const header = req.headers.get('x-hub-signature-256')
  if (!header?.startsWith('sha256=')) return new Response('Invalid signature', { status: 401 })
  const { data: accts } = await svc.from('whatsapp_accounts').select('app_secret').not('app_secret', 'is', null)
  const secrets = [cfg?.app_secret, ...(accts ?? []).map((a) => a.app_secret)].filter(Boolean) as string[]
  let ok = false
  for (const s of new Set(secrets)) { if (await signatureMatches(raw, header, s)) { ok = true; break } }
  if (!ok) return new Response('Invalid signature', { status: 401 })

  let body: any
  try { body = JSON.parse(raw) } catch { return new Response('Bad request', { status: 400 }) }

  const statuses: { wamid: string; status: string; errors: unknown }[] = []
  const inbound: Record<string, unknown>[] = []
  const templateEvents: { id: string; event: string; reason: string | null }[] = []
  const categoryChanges: { id: string; category: string }[] = []
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {}
      if (change.field === 'messages') {
        for (const s of v.statuses ?? []) { const st = MAP[s.status]; if (st && s.id) statuses.push({ wamid: s.id, status: st, errors: s.errors ?? null }) }
        const pnid = v?.metadata?.phone_number_id
        for (const m of v.messages ?? []) {
          if (!m?.from || !pnid) continue
          const name = (v.contacts ?? []).find((c: any) => c.wa_id === m.from)?.profile?.name ?? null
          inbound.push({
            pnid: String(pnid), from: String(m.from), name, wamid: m.id ?? null, type: String(m.type ?? 'text'), body: inboundBody(m),
            raw: { type: m.type, timestamp: m.timestamp, context: m.context?.id ?? null, payload: m.button?.payload ?? m.interactive?.button_reply?.id ?? null },
          })
        }
      } else if (change.field === 'message_template_status_update') {
        if (v.message_template_id) templateEvents.push({ id: String(v.message_template_id), event: String(v.event ?? ''), reason: v.reason ?? null })
      } else if (change.field === 'template_category_update') {
        const cat = String(v.new_category ?? '').toUpperCase()
        if (v.message_template_id && ['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(cat)) categoryChanges.push({ id: String(v.message_template_id), category: cat })
      }
    }
  }
  const jobs: PromiseLike<unknown>[] = []
  if (statuses.length) jobs.push(svc.rpc('apply_status_updates', { p_items: statuses }))
  if (inbound.length) jobs.push(svc.rpc('ingest_inbound_batch', { p_items: inbound }))
  for (const t of templateEvents) jobs.push(svc.rpc('apply_template_status', { p_meta_id: t.id, p_event: t.event, p_reason: t.reason }))
  for (const c of categoryChanges) jobs.push(svc.from('whatsapp_templates').update({ category: c.category }).eq('meta_template_id', c.id))
  await Promise.all(jobs)
  return new Response('ok', { status: 200 })
})
