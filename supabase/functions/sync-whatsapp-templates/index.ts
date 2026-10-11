import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAGES = 10   // management calls are limited to 200 an hour per app per WABA

interface MetaTemplate {
  id: string; name: string; status: string; category: string; language: string; parameter_format?: string; rejected_reason?: string
  components?: { type: string; format?: string; text?: string; buttons?: { type: string; text: string; url?: string; phone_number?: string }[]; example?: Record<string, unknown> }[]
}

// Reconciles our templates with the real status on Meta. With import=true (Entity Admin only) it also brings in
// text templates that were created in WhatsApp Manager.
async function syncEntity(svc: ReturnType<typeof createClient>, cfg: Record<string, any>, acct: Record<string, any>, doImport: boolean) {
  const token = acct.access_token ?? cfg.access_token
  const version = acct.api_version ?? cfg.api_version
  const all: MetaTemplate[] = []
  let next: string | null = `https://graph.facebook.com/${version}/${acct.waba_id}/message_templates?limit=100&fields=id,name,status,category,language,parameter_format,rejected_reason,components`
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const r = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j?.error?.error_user_msg || j?.error?.message || `Meta returned HTTP ${r.status}`)
    all.push(...(j.data ?? []))
    next = j?.paging?.next ?? null
  }
  const result = { entity_id: acct.entity_id, fetched: all.length, updated: 0, unmatched: [] as { id: string; name: string; language: string; status: string }[], imported: 0, skipped: [] as { name: string; reason: string }[] }
  for (const t of all) {
    const { data: mine } = await svc.from('whatsapp_templates').select('id, category, meta_status').eq('meta_template_id', String(t.id)).maybeSingle()
    if (mine) {
      if (mine.meta_status !== t.status) { await svc.rpc('apply_template_status', { p_meta_id: String(t.id), p_event: t.status, p_reason: t.rejected_reason ?? null }); result.updated++ }
      if (t.category && mine.category !== t.category && ['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(t.category)) {
        await svc.from('whatsapp_templates').update({ category: t.category }).eq('id', mine.id); result.updated++
      }
      continue
    }
    result.unmatched.push({ id: String(t.id), name: t.name, language: t.language, status: t.status })
    if (!doImport) continue

    const lang = t.language?.startsWith('ar') ? 'ar' : t.language?.startsWith('en') ? 'en' : null
    const header = t.components?.find((c) => c.type === 'HEADER'), body = t.components?.find((c) => c.type === 'BODY')
    const footer = t.components?.find((c) => c.type === 'FOOTER'), btns = t.components?.find((c) => c.type === 'BUTTONS')
    if (!lang) { result.skipped.push({ name: t.name, reason: `Language ${t.language} is not supported yet` }); continue }
    if (!body?.text) { result.skipped.push({ name: t.name, reason: 'No text body' }); continue }
    if (header && header.format !== 'TEXT') { result.skipped.push({ name: t.name, reason: `${header.format} headers are not supported yet` }); continue }
    if (!['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(t.category) || t.category === 'AUTHENTICATION') { result.skipped.push({ name: t.name, reason: `${t.category} templates are not supported yet` }); continue }
    if (['DELETED'].includes(t.status)) continue

    const positional = t.parameter_format === 'POSITIONAL' || !t.parameter_format
    const names = [...new Set([...(header?.text ?? '').matchAll(/\{\{(\w+)\}\}/g), ...body.text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))]
    const ex = body.example as Record<string, any> | undefined
    const named = (ex?.body_text_named_params ?? []) as { param_name: string; example: string }[]
    const pos = ((ex?.body_text ?? [[]])[0] ?? []) as string[]
    const variables = names.map((n, i) => ({ name: n, example: positional ? (pos[Number(n) - 1] ?? pos[i] ?? 'Sample') : (named.find((p) => p.param_name === n)?.example ?? 'Sample'), source: 'static' }))
    const mapped = t.status === 'APPROVED' || t.status === 'REINSTATED' ? 'APPROVED' : t.status === 'REJECTED' ? 'REJECTED' : t.status === 'PENDING' ? 'PENDING_APPROVAL' : 'APPROVED'
    const { error } = await svc.from('whatsapp_templates').insert({
      entity_id: acct.entity_id, name: t.name, category: t.category, language: lang, header_text: header?.text ?? null, body_text: body.text, footer_text: footer?.text ?? null,
      variables, parameter_format: positional ? 'POSITIONAL' : 'NAMED',
      buttons: (btns?.buttons ?? []).map((b) => ({ type: b.type, text: b.text, url: b.url, phone: b.phone_number })),
      status: mapped, meta_name: t.name, meta_template_id: String(t.id), meta_submitted_at: new Date().toISOString(), meta_status: t.status,
      meta_status_at: new Date().toISOString(), meta_approved_once: t.status === 'APPROVED', rejection_reason: t.rejected_reason ?? null,
    })
    if (error) result.skipped.push({ name: t.name, reason: error.message }); else result.imported++
  }
  return result
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: cfg } = await svc.from('whatsapp_config').select('*').eq('id', 1).single()
    if (!cfg) return json({ error: 'Not configured' }, 500)
    const isWorker = req.headers.get('x-worker-secret') === cfg.worker_secret
    let entityId: string | null = null, doImport = false
    if (!isWorker) {
      const auth = req.headers.get('Authorization') ?? ''
      const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
      const { data: ures } = await user.auth.getUser(auth.replace(/^Bearer /i, ''))
      if (!ures?.user) return json({ error: 'Not signed in' }, 401)
      const body = await req.json().catch(() => null)
      entityId = body?.entity_id ?? null; doImport = body?.import === true
      if (!UUID.test(entityId ?? '')) return json({ error: 'Invalid entity' }, 400)
      const { data: ok } = await user.rpc('has_perm', { eid: entityId, perm: 'template.submit' })
      if (!ok) return json({ error: 'Only an Entity Admin can sync templates' }, 403)
    }
    let q = svc.from('whatsapp_accounts').select('*').not('waba_id', 'is', null)
    if (entityId) q = q.eq('entity_id', entityId); else q = q.eq('mode', 'live')
    const { data: accts } = await q
    const results = []
    const seenWaba = new Set<string>()
    for (const a of accts ?? []) {
      if (!entityId && seenWaba.has(a.waba_id)) continue   // entities sharing a WABA are synced once in the scheduled run
      seenWaba.add(a.waba_id)
      if (cfg.mode !== 'live' && !entityId) continue
      if (!(a.access_token ?? cfg.access_token)) { results.push({ entity_id: a.entity_id, error: 'No access token' }); continue }
      try { results.push(await syncEntity(svc, cfg, a, doImport)) } catch (e) { results.push({ entity_id: a.entity_id, error: String((e as Error).message) }) }
    }
    return json({ ok: true, results })
  } catch (e) {
    console.error(e)
    return json({ error: 'Sync failed' }, 500)
  }
})
