import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Reads token permissions, number quality and the messaging limit for an entity's WhatsApp account.
// Callable by a signed-in Entity Admin / Superadmin for one entity, or by pg_cron (worker secret) for all live entities.
async function check(svc: ReturnType<typeof createClient>, cfg: Record<string, any>, acct: Record<string, any>) {
  const token = acct.access_token ?? cfg.access_token
  const version = acct.api_version ?? cfg.api_version
  const row: Record<string, unknown> = { entity_id: acct.entity_id, checked_at: new Date().toISOString(), token_ok: false, management_ok: false, messaging_ok: false, error: null }
  if (!token || !acct.phone_number_id) { row.error = 'No access token or Phone Number ID stored'; await svc.from('whatsapp_health').upsert(row); return row }
  const g = async (path: string) => {
    const r = await fetch(`https://graph.facebook.com/${version}/${path}`, { headers: { Authorization: `Bearer ${token}` } })
    return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) as Record<string, any> }
  }
  const errText = (r: { j: Record<string, any> }) => r.j?.error?.error_user_msg || r.j?.error?.message || 'Request failed'

  const phone = await g(`${acct.phone_number_id}?fields=display_phone_number,verified_name,quality_rating,status,name_status`)
  if (phone.ok) {
    row.token_ok = true; row.messaging_ok = true
    row.quality_rating = phone.j.quality_rating ?? null
    row.phone_status = phone.j.status ?? null
    row.name_status = phone.j.name_status ?? null
  } else {
    const code = Number(phone.j?.error?.code ?? 0)
    row.token_ok = ![190, 102].includes(code)
    row.error = code === 190 ? 'The access token is invalid or expired.' : code === 200 || code === 10 ? 'The access token cannot read this number. It needs whatsapp_business_messaging.' : errText(phone)
  }

  if (acct.waba_id) {
    // management permission is what template changes need; error 200 means it is missing
    const t = await g(`${acct.waba_id}/message_templates?limit=1&fields=id`)
    row.management_ok = t.ok
    if (!t.ok && !row.error) row.error = Number(t.j?.error?.code) === 200 ? 'The access token is missing whatsapp_business_management, which templates need.' : errText(t)
    let w = await g(`${acct.waba_id}?fields=id,name,account_review_status,whatsapp_business_manager_messaging_limit`)
    if (!w.ok) w = await g(`${acct.waba_id}?fields=id,name,account_review_status`)
    if (w.ok) {
      row.review_status = w.j.account_review_status ?? null
      const raw = JSON.stringify(w.j.whatsapp_business_manager_messaging_limit ?? '')
      const m = raw.match(/TIER_(UNLIMITED|\d+K?)/i)
      if (m) {
        row.limit_tier = `TIER_${m[1].toUpperCase()}`
        row.limit_value = m[1].toUpperCase() === 'UNLIMITED' ? 1_000_000_000_000 : m[1].toUpperCase().endsWith('K') ? parseInt(m[1]) * 1000 : parseInt(m[1])
      }
    }
  }
  await svc.from('whatsapp_health').upsert(row)
  return row
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: cfg } = await svc.from('whatsapp_config').select('*').eq('id', 1).single()
    if (!cfg) return json({ error: 'Not configured' }, 500)

    const isWorker = req.headers.get('x-worker-secret') === cfg.worker_secret
    let entityId: string | null = null
    if (!isWorker) {
      const auth = req.headers.get('Authorization') ?? ''
      const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
      const { data: ures } = await user.auth.getUser(auth.replace(/^Bearer /i, ''))
      if (!ures?.user) return json({ error: 'Not signed in' }, 401)
      const body = await req.json().catch(() => null)
      entityId = body?.entity_id ?? null
      if (!UUID.test(entityId ?? '')) return json({ error: 'Invalid entity' }, 400)
      const { data: ok } = await user.rpc('has_perm', { eid: entityId, perm: 'template.submit' })
      if (!ok) return json({ error: 'Only an Entity Admin can run this check' }, 403)
    }

    let q = svc.from('whatsapp_accounts').select('*').not('phone_number_id', 'is', null)
    if (entityId) q = q.eq('entity_id', entityId); else q = q.eq('mode', 'live')
    const { data: accts } = await q
    const out = []
    for (const a of accts ?? []) out.push(await check(svc, cfg, a))
    return json({ ok: true, checked: out.length, results: out.map((r) => ({ entity_id: r.entity_id, token_ok: r.token_ok, management_ok: r.management_ok, messaging_ok: r.messaging_ok, quality: r.quality_rating, status: r.phone_status, limit: r.limit_tier, error: r.error })) })
  } catch (e) {
    console.error(e)
    return json({ error: 'Health check failed' }, 500)
  }
})
