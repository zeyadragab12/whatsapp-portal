import { createClient } from 'npm:@supabase/supabase-js@2'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WINDOW_MS = 24 * 3600_000

const FRIENDLY: Record<number, string> = {
  130429: 'Sending too fast for this WhatsApp number. Try again in a moment.',
  131056: 'Too many messages to this person in a short time. Wait a few seconds.',
  131047: 'More than 24 hours since this person last replied. Send a template instead.',
  131026: 'The message could not be delivered to this number.',
  131030: 'This recipient is not on the allowed list for the test number.',
  190: 'The access token is invalid or expired.',
  200: 'The access token is missing the whatsapp_business_messaging permission.',
}

// Free-text reply to a person who messaged us. Meta only allows this inside 24 hours of their last message.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const auth = req.headers.get('Authorization') ?? ''
    const url = Deno.env.get('SUPABASE_URL')!
    const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
    const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: ures } = await user.auth.getUser(auth.replace(/^Bearer /i, ''))
    const uid = ures?.user?.id
    if (!uid) return json({ error: 'Not signed in' }, 401)

    const body = await req.json().catch(() => null)
    const text = String(body?.text ?? '').trim()
    if (!UUID.test(body?.conversation_id ?? '')) return json({ error: 'Invalid conversation' }, 400)
    if (!text) return json({ error: 'Write a message first' }, 400)
    if (text.length > 4096) return json({ error: 'Messages can be up to 4096 characters' }, 400)

    // the user client only sees conversations RLS lets them see
    const { data: conv } = await user.from('conversations').select('*').eq('id', body.conversation_id).maybeSingle()
    if (!conv) return json({ error: 'Conversation not found' }, 404)
    const { data: can } = await user.rpc('has_perm', { eid: conv.entity_id, perm: 'inbox.reply' })
    if (!can) return json({ error: 'You are not allowed to reply in this inbox' }, 403)
    if (!conv.last_inbound_at || Date.now() - new Date(conv.last_inbound_at).getTime() > WINDOW_MS) {
      return json({ error: 'The 24-hour reply window has closed. Send an approved template from Dispatch instead.', code: 'WINDOW_CLOSED' }, 400)
    }
    const { data: optout } = conv.owner_id ? await svc.from('owner_optouts').select('owner_id').eq('entity_id', conv.entity_id).eq('owner_id', conv.owner_id).maybeSingle() : { data: null }
    if (optout) return json({ error: 'This person opted out. Messages are blocked until they send START.' }, 400)

    const { data: cfg } = await svc.from('whatsapp_config').select('*').eq('id', 1).single()
    const { data: acct } = await svc.from('whatsapp_accounts').select('*').eq('entity_id', conv.entity_id).maybeSingle()
    const token = acct?.access_token ?? cfg?.access_token ?? null
    const version = acct?.api_version ?? cfg?.api_version
    const live = cfg?.mode === 'live' && acct?.mode === 'live' && !!acct?.phone_number_id && !!acct?.waba_id && !!token

    const now = new Date().toISOString()
    let wamid: string
    if (!live) {
      wamid = `demo.${crypto.randomUUID()}`
    } else {
      const res = await fetch(`https://graph.facebook.com/${version}/${acct.phone_number_id}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: conv.phone_number.replace(/^\+/, ''), type: 'text', text: { preview_url: false, body: text } }),
      })
      const j = await res.json().catch(() => ({}))
      if (!(res.ok && j?.messages?.[0]?.id)) {
        const code = Number(j?.error?.code ?? 0)
        return json({ error: FRIENDLY[code] ?? j?.error?.message ?? `Meta returned HTTP ${res.status}` }, 400)
      }
      wamid = j.messages[0].id
    }

    const { data: msg, error: iErr } = await svc.from('conversation_messages').insert({
      conversation_id: conv.id, direction: 'out', type: 'text', body: text, wamid, status: 'SENT', sent_by: uid,
    }).select('id').single()
    if (iErr) throw iErr
    await svc.from('conversations').update({
      last_message_at: now, last_message_preview: text.slice(0, 120), unread_count: 0, status: 'open', assigned_to: conv.assigned_to ?? uid,
    }).eq('id', conv.id)
    // in demo mode the worker walks the reply through delivered and read
    if (!live && cfg?.worker_secret) {
      EdgeRuntime.waitUntil(fetch(`${url}/functions/v1/process-queue`, { method: 'POST', headers: { 'x-worker-secret': cfg.worker_secret } }).catch(() => {}))
    }
    return json({ ok: true, id: msg.id, mode: live ? 'live' : 'demo' })
  } catch (e) {
    console.error(e)
    return json({ error: 'Reply failed' }, 500)
  }
})
