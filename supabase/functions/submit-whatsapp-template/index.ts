import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildCreatePayload, buildEditPayload, draftFromRow, hasErrors, metaNameFor, validateTemplate, type DraftMedia } from '../_shared/templateRules.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EDITABLE = new Set(['APPROVED', 'REJECTED', 'PAUSED'])
const META_TIMEOUT_MS = 25_000
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80008, 130429])

const META_ERRORS: Record<number, string> = {
  200: 'The access token is missing the whatsapp_business_management permission, which template changes need.',
  190: 'The access token is invalid or expired.',
  10: 'The access token does not have permission to manage templates on this WhatsApp account.',
  100: 'Meta rejected the template. Check the name, language and text.',
}

/** Meta's resumable upload: finds the app behind the token, opens an upload session, sends the bytes and returns the handle templates use as their example. */
async function uploadExample(version: string, token: string, bytes: ArrayBuffer, mime: string): Promise<{ handle: string } | { error: string }> {
  const g = `https://graph.facebook.com/${version}`
  const dbg = await fetch(`${g}/debug_token?input_token=${encodeURIComponent(token)}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => null)
  const appId = dbg?.data?.app_id
  if (!appId) return { error: 'Could not find the Meta app behind the access token, which is needed to upload the template image or video.' }
  const session = await fetch(`${g}/${appId}/uploads?file_length=${bytes.byteLength}&file_type=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.json()).catch(() => null)
  if (!session?.id) return { error: session?.error?.message ?? 'Meta did not accept the upload of the template image or video.' }
  const sent = await fetch(`${g}/${session.id}`, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_offset: '0' }, body: bytes })
    .then((r) => r.json()).catch(() => null)
  if (!sent?.h) return { error: sent?.error?.message ?? 'Meta did not accept the upload of the template image or video.' }
  return { handle: sent.h as string }
}

/** Looks the template up on Meta by its name. The name is generated from the template's id, so a match can only be ours. */
async function findOnMeta(version: string, token: string, waba: string, metaName: string): Promise<{ id: string; status: string } | null> {
  try {
    const r = await fetch(`https://graph.facebook.com/${version}/${waba}/message_templates?name=${encodeURIComponent(metaName)}&fields=id,status&limit=5`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(META_TIMEOUT_MS) })
    const j = await r.json()
    const hit = (j?.data ?? [])[0]
    return hit?.id ? { id: String(hit.id), status: String(hit.status ?? 'PENDING') } : null
  } catch { return null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const auth = req.headers.get('Authorization') ?? ''
    const url = Deno.env.get('SUPABASE_URL')!
    const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
    const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: ures } = await user.auth.getUser(auth.replace(/^Bearer /i, ''))
    if (!ures?.user) return json({ error: 'Not signed in' }, 401)

    const body = await req.json().catch(() => null)
    if (!UUID.test(body?.template_id ?? '')) return json({ error: 'Invalid template' }, 400)
    const { data: tpl } = await user.from('whatsapp_templates').select('*').eq('id', body.template_id).maybeSingle()
    if (!tpl) return json({ error: 'Template not found' }, 404)
    const { data: allowed } = await user.rpc('has_perm', { eid: tpl.entity_id, perm: 'template.submit' })
    if (!allowed) return json({ error: 'Only an Entity Admin can submit templates to Meta' }, 403)
    if (tpl.status !== 'DRAFT' && !(tpl.status === 'PENDING_APPROVAL' && !tpl.meta_submitted_at)) {
      return json({ error: 'This template has no changes waiting to be sent to Meta' }, 400)
    }

    const { data: cfg } = await svc.from('whatsapp_config').select('*').eq('id', 1).single()
    const { data: acct } = await svc.from('whatsapp_accounts').select('*').eq('entity_id', tpl.entity_id).maybeSingle()
    const token = acct?.access_token ?? cfg?.access_token ?? null
    const version = acct?.api_version ?? cfg?.api_version
    const live = cfg?.mode === 'live' && acct?.mode === 'live' && !!acct?.waba_id && !!token
    const editing = !!tpl.meta_template_id
    const metaName = tpl.meta_name ?? metaNameFor(tpl.name, tpl.id)   // stable for the life of the template, so a retry can never create a second one
    const now = new Date().toISOString()

    // The same rules the editor shows, run again here. The browser is never trusted.
    let media: DraftMedia | null = null
    let asset: { kind: 'IMAGE' | 'VIDEO'; path: string; mime_type: string; size_bytes: number } | null = null
    if (tpl.header_media_id) {
      const { data: a } = await svc.from('media_assets').select('kind, path, mime_type, name, size_bytes').eq('id', tpl.header_media_id).eq('entity_id', tpl.entity_id).maybeSingle()
      if (!a) return json({ error: 'The image or video of this template is no longer in the media library' }, 400)
      asset = a
      media = { kind: a.kind, mime: a.mime_type, size: a.size_bytes, uploaded: true }
    }
    const { data: siblings } = await svc.from('whatsapp_templates').select('id, name').eq('entity_id', tpl.entity_id).neq('id', tpl.id).neq('status', 'ARCHIVED')
    const draft = draftFromRow(tpl, media)
    const issues = validateTemplate(draft, { apiVersion: version, existingNames: (siblings ?? []).filter((x: { id: string }) => x.id !== tpl.id).map((x: { name: string }) => x.name) })
    if (hasErrors(issues)) {
      const n = issues.filter((i) => i.severity === 'error').length
      return json({ error: `This template has ${n} problem${n === 1 ? '' : 's'} to fix before it can be sent to Meta.`, issues }, 422)
    }

    if (!live) {
      const { error } = await svc.from('whatsapp_templates').update({
        meta_name: metaName, meta_template_id: tpl.meta_template_id ?? `demo_${tpl.id}`, meta_submitted_at: now, status: 'PENDING_APPROVAL', meta_status: 'PENDING', meta_status_at: now,
      }).eq('id', tpl.id)
      if (error) throw error
      return json({ ok: true, mode: 'demo', meta_name: metaName, edited: editing })
    }

    // Meta limits: 100 creations an hour, a template cap per account, and edit rules
    const waba = acct.waba_id as string
    if (editing) {
      if (!EDITABLE.has(tpl.meta_status ?? '')) return json({ error: `Meta only allows edits while a template is Approved, Rejected or Paused. It is ${tpl.meta_status ?? 'unknown'} now.` }, 400)
      if (tpl.meta_status === 'APPROVED') {
        const { data: ev } = await svc.from('template_meta_events').select('created_at').eq('template_id', tpl.id).eq('kind', 'edit').eq('was_approved', true)
          .gte('created_at', new Date(Date.now() - 30 * 86400_000).toISOString())
        const day = (ev ?? []).filter((e) => Date.now() - new Date(e.created_at).getTime() < 86400_000).length
        if (day >= 1) return json({ error: 'Meta allows one edit per 24 hours on an approved template. Try again tomorrow.' }, 400)
        if ((ev ?? []).length >= 10) return json({ error: 'Meta allows 10 edits per 30 days on an approved template.' }, 400)
      }
    } else {
      const { count: hour } = await svc.from('template_meta_events').select('id', { count: 'exact', head: true }).eq('waba_id', waba).eq('kind', 'create')
        .gte('created_at', new Date(Date.now() - 3600_000).toISOString())
      if ((hour ?? 0) >= 100) return json({ error: 'Meta allows 100 template creations per hour on one account. Try again later.' }, 429)
      const { data: sameWaba } = await svc.from('whatsapp_accounts').select('entity_id').eq('waba_id', waba)
      const { count: used } = await svc.from('whatsapp_templates').select('id', { count: 'exact', head: true })
        .in('entity_id', (sameWaba ?? []).map((a) => a.entity_id)).not('meta_template_id', 'is', null).not('meta_template_id', 'like', 'demo\\_%').neq('meta_status', 'DELETED')
      if ((used ?? 0) >= (acct.template_cap ?? 250)) return json({ error: `This WhatsApp account already holds ${used} templates, its limit. Remove unused templates first.` }, 400)
    }

    // Meta reviews an example of an image or video, so it is handed over through Meta's upload API first
    let headerHandle: string | undefined
    if (asset) {
      const { data: file } = await svc.storage.from('template-media').download(asset.path)
      if (!file) return json({ error: 'The image or video file could not be read' }, 400)
      const up = await uploadExample(version, token as string, await file.arrayBuffer(), asset.mime_type)
      if ('error' in up) return json({ error: up.error }, 400)
      headerHandle = up.handle
    }

    // a new template is created once; every later change edits it in place and keeps its id and name
    const target = editing ? `https://graph.facebook.com/${version}/${tpl.meta_template_id}` : `https://graph.facebook.com/${version}/${waba}/message_templates`
    const opts = { headerHandle, apiVersion: version }
    const payload = editing ? buildEditPayload(draft, !!tpl.meta_approved_once, opts) : buildCreatePayload(draft, metaName, opts)

    const record = async (metaId: string, status: string) => {
      const { error } = await svc.from('whatsapp_templates').update({
        meta_name: metaName, meta_template_id: metaId, meta_submitted_at: now, status: 'PENDING_APPROVAL', meta_status: status, meta_status_at: now,
      }).eq('id', tpl.id)
      if (error) throw error
      await svc.from('template_meta_events').insert({ template_id: tpl.id, entity_id: tpl.entity_id, waba_id: waba, kind: editing ? 'edit' : 'create', was_approved: editing && tpl.meta_status === 'APPROVED' })
    }

    let res: Response
    try {
      res = await fetch(target, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(META_TIMEOUT_MS) })
    } catch {
      // The request may or may not have reached Meta. For a new template, look it up by its generated name before saying anything.
      const found = editing ? null : await findOnMeta(version, token as string, waba, metaName)
      if (found) { await record(found.id, found.status); return json({ ok: true, mode: 'live', meta_name: metaName, edited: false, reconciled: true }) }
      return json({ error: editing
        ? 'Meta did not answer in time. Check the template on Meta before sending the changes again.'
        : 'Meta did not answer in time and the template was not found on the account. It is safe to try again.' }, 504)
    }
    const j = await res.json().catch(() => ({}))
    const ok = res.ok && (editing ? j.success !== false : !!j.id)
    if (!ok) {
      const code = Number(j?.error?.code ?? 0)
      const sub = Number(j?.error?.error_subcode ?? 0)
      // "already exists" on a new template means an earlier attempt got through, and the name is unique to this template
      if (!editing && sub === 2388024) {
        const found = await findOnMeta(version, token as string, waba, metaName)
        if (found) { await record(found.id, found.status); return json({ ok: true, mode: 'live', meta_name: metaName, edited: false, reconciled: true }) }
      }
      if (RATE_LIMIT_CODES.has(code) || res.status === 429) return json({ error: 'Meta is limiting how fast this account can make requests. Wait a few minutes and try again.' }, 429)
      const msg = sub === 2388024 ? 'A template with this name and language already exists on the WhatsApp account.' : j?.error?.error_user_msg || META_ERRORS[code] || j?.error?.message || 'Meta rejected the submission'
      return json({ error: msg }, 400)
    }
    await record(editing ? tpl.meta_template_id : String(j.id), 'PENDING')
    return json({ ok: true, mode: 'live', meta_name: metaName, edited: editing })
  } catch (e) {
    console.error(e)
    return json({ error: 'Submission failed' }, 500)
  }
})
