import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildPayload, extractVars, type HeaderMedia } from './payload.ts'
import { overAllowance, type Allowance } from './allowance.ts'
import { eligibilityError, templateBlock } from './eligibility.ts'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const MAX_RECIPIENTS = 2000
const HOURLY_CAP = 10000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// older templates stored sources like "owner.full_name"; they map onto the field names used now
const LEGACY: Record<string, string> = {
  'owner.full_name': 'owner_name', 'owner.unit_number': 'unit_number', 'owner.phone': 'phone', 'owner.email': 'email',
  'project.name': 'project_name', 'project.code': 'project_code', 'entity.name': 'entity_name',
}
const fieldKey = (v: { name: string; source?: string } | undefined, name: string) => {
  const s = v?.source
  if (!s || s === 'static') return name
  return LEGACY[s] ?? s.replace(/^field\./, '')
}

const BLOCK_TEXT: Record<string, string> = {
  LIMIT_EXCEEDED: 'This send would go over the messaging limit for the business portfolio in the last 24 hours.',
  PHONE_NOT_CONNECTED: 'The WhatsApp number is not connected. Check the company’s WhatsApp link on the Companies page.',
  TOKEN_CANNOT_SEND: 'The access token cannot send messages. Check the token permissions in the company’s WhatsApp link.',
}

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message) }
}

type Db = ReturnType<typeof createClient>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/** Long id lists would make the request address too long, so they are looked up in batches. */
async function inBatches(ids: string[], run: (part: string[]) => PromiseLike<{ data: Row[] | null; error: unknown }>, size = 150): Promise<Row[]> {
  const out: Row[] = []
  for (let i = 0; i < ids.length; i += size) {
    const { data, error } = await run(ids.slice(i, i + size))
    if (error) throw error
    out.push(...(data ?? []))
  }
  return out
}

const CLIENT_COLUMNS = 'owner_id, unit_no, extra, owners(id, full_name, phone, email, whatsapp_opt_in, status)'

/** What the person chose for numbers that appear more than once in a send. */
interface DispatchOpts {
  merge?: Record<string, string[]>   // client id -> other clients whose values are combined into the same one message
  mergeLinks?: Row[]                 // the client rows of those other clients
  eachPhones?: Set<string>           // numbers (digits only) that get one message per entry
  requestId?: string                 // one id per intended send: the same id again returns the batch it already made
}

/** The batch an earlier request with this id already created, shaped like a fresh answer. */
async function existingBatch(svc: Db, uid: string, requestId: string) {
  const { data: b } = await svc.from('dispatch_batches').select('id, total, mode').eq('sender_id', uid).eq('request_id', requestId).maybeSingle()
  if (!b) return null
  const { count } = await svc.from('message_logs').select('id', { count: 'exact', head: true }).eq('batch_id', b.id).eq('status', 'QUEUED')
  return { batch_id: b.id as string, total: b.total as number, queued: count ?? 0, skipped: 0, mode: b.mode as string, sent_from: null, preflight: null, duplicate_request: true }
}

/** The part both ways of sending share: limits, connection checks, one log row per client, and waking the queue worker. */
async function dispatch(svc: Db, cfg: Row, uid: string, tpl: Row, project: Row, ownerIds: string[], links: Row[], pre: Row | null, listIds: string[] = [], opts: DispatchOpts = {}) {
  const entityName = (project.entities as { name?: string } | null)?.name ?? ''

  const since = new Date(Date.now() - 3600_000).toISOString()
  const { count: recent } = await svc.from('message_logs').select('id', { count: 'exact', head: true }).eq('sender_id', uid).gte('created_at', since)
  if ((recent ?? 0) + links.length > HOURLY_CAP) throw new HttpError(429, 'Hourly sending limit reached')

  const { data: acct } = await svc.from('whatsapp_accounts').select('*').eq('entity_id', tpl.entity_id).maybeSingle()
  const token = acct?.access_token ?? cfg?.access_token ?? null
  const live = cfg?.mode === 'live' && acct?.mode === 'live' && !!acct?.phone_number_id && !!acct?.waba_id && !!token
  if (cfg?.mode === 'live' && acct?.mode === 'live' && !live) throw new HttpError(400, `${entityName} is set to Live but its WhatsApp connection is incomplete`)
  const sentFrom = live ? (acct.display_phone ?? acct.phone_number_id) : 'demo'
  if (live) checkTemplate(tpl, project, true)   // sending for real needs Meta's own approval on record

  if (live && pre?.blocking) {
    const first = (pre.warnings as string[]).find((w) => BLOCK_TEXT[w])
    throw new HttpError(400, first ? BLOCK_TEXT[first] : 'The pre-send check failed', { preflight: pre })
  }

  const { data: price } = await svc.from('message_pricing').select('rate').eq('category', tpl.category).maybeSingle()
  const rate = Number(price?.rate ?? 0)
  const needed = [...new Set([...extractVars(tpl.header_text), ...extractVars(tpl.body_text)])]
  const defs = (tpl.variables ?? []) as { name: string; source?: string }[]
  const { data: fieldDefs } = await svc.from('owner_fields').select('key, label').eq('entity_id', tpl.entity_id)
  const labelOf = (k: string) => fieldDefs?.find((f) => f.key === k)?.label ?? k.replace(/_/g, ' ')
  const optoutRows = await inBatches(ownerIds, (part) => svc.from('owner_optouts').select('owner_id').eq('entity_id', tpl.entity_id).in('owner_id', part))
  const optedOut = new Set(optoutRows.map((o) => o.owner_id as string))
  // an opt-out belongs to the phone: another client row with the same number being opted out blocks this one too
  const phones = [...new Set(links.map((l) => (l.owners as { phone: string }).phone))]
  const suppressed = new Set<string>()
  for (let i = 0; i < phones.length; i += 150) {
    const { data, error } = await svc.rpc('suppressed_phones', { p_entity: tpl.entity_id, p_phones: phones.slice(i, i + 150) })
    if (error) throw error   // when consent cannot be checked, nothing is sent
    for (const p of (data ?? []) as string[]) suppressed.add(p)
  }

  // an image or video header is sent as a link to the file in Storage, so every message in the queue carries it
  let media: HeaderMedia | null = null
  if (tpl.header_media_id) {
    const { data: asset } = await svc.from('media_assets').select('kind, path').eq('id', tpl.header_media_id).eq('entity_id', tpl.entity_id).maybeSingle()
    if (!asset) throw new HttpError(400, 'The image or video of this template is no longer in the media library')
    media = { kind: asset.kind as HeaderMedia['kind'], url: `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/template-media/${asset.path}` }
  }

  const mergeById = new Map((opts.mergeLinks ?? []).map((l) => [l.owner_id as string, l]))
  const dataOf = (l: Row): Record<string, string> => {
    const o = l.owners as { full_name: string; phone: string; email: string | null }
    // every value comes from the client's own data: built-in fields first, then columns imported from their file
    return {
      ...((l.extra ?? {}) as Record<string, string>),
      owner_name: o.full_name, unit_number: l.unit_no ?? '', phone: o.phone, email: o.email ?? '',
      project_name: entityName, project_code: project.code, entity_name: entityName,
    }
  }

  const rows = links.map((l) => {
    const o = l.owners as { id: string; full_name: string; phone: string; email: string | null; whatsapp_opt_in: boolean; status: string }
    // clients combined into one message: each value lists every distinct value, for example two units
    const group = [dataOf(l), ...(opts.merge?.[o.id] ?? []).map((id) => mergeById.get(id)).filter(Boolean).map((x) => dataOf(x as Row))]
    const values: Record<string, string> = {}
    const absent: string[] = []
    for (const n of needed) {
      const key = fieldKey(defs.find((d) => d.name === n), n)
      values[n] = [...new Set(group.map((d) => String(d[key] ?? '').trim()).filter(Boolean))].join(', ')
      if (!values[n]) absent.push(labelOf(key))
    }
    const payload = buildPayload(tpl as never, values, o.phone, media)
    const error = eligibilityError(o, optedOut, suppressed, absent)
    const status = error ? 'FAILED' : 'QUEUED'
    return {
      batch_id: '', entity_id: tpl.entity_id, project_id: project.id, template_id: tpl.id, sender_id: uid,
      owner_id: o.id, phone_number: o.phone, payload, status, error_details: error, cost_estimate: rate, sent_from: sentFrom,
    }
  })

  // one number gets one message per send, even if several clients share it; the first one keeps it, the rest are logged as skipped
  const claimed = new Set<string>()
  for (const r of rows) {
    if (r.status !== 'QUEUED') continue
    const digits = String(r.phone_number).replace(/\D/g, '')
    if (opts.eachPhones?.has(digits)) continue   // the person chose one message per entry for this number
    if (claimed.has(digits)) { r.status = 'FAILED'; r.error_details = { code: 'DUPLICATE_PHONE', message: 'Same phone number already in this send, so it was only messaged once' } }
    else claimed.add(digits)
  }

  // the company's daily cap and warm-up limit protect the number's reputation; only real sends count, demo sends never do
  if (live) {
    const toSend = rows.filter((r) => r.status === 'QUEUED').length
    const { data: al, error: alErr } = await svc.rpc('send_allowance', { p_entity: tpl.entity_id })
    if (alErr) throw alErr
    const refusal = overAllowance(al as Allowance, toSend)
    if (refusal) throw new HttpError(429, refusal, { allowance: al })
  }

  // History shows which groups the send went to; an empty list means everyone
  const { data: grp } = listIds.length ? await svc.from('client_lists').select('name').eq('entity_id', tpl.entity_id).in('id', listIds).order('name') : { data: [] }
  const { data: batch, error: bErr } = await svc.from('dispatch_batches').insert({
    entity_id: tpl.entity_id, project_id: project.id, template_id: tpl.id, sender_id: uid,
    variable_map: {}, mode: live ? 'live' : 'demo', total: links.length, group_names: (grp ?? []).map((g) => g.name as string), request_id: opts.requestId ?? null,
  }).select('id').single()
  if (bErr) {
    // the same request arrived twice at once: the other one won, so report its batch and queue nothing more
    if ((bErr as { code?: string }).code === '23505' && opts.requestId) { const done = await existingBatch(svc, uid, opts.requestId); if (done) return done }
    throw bErr
  }
  for (const r of rows) r.batch_id = batch.id

  let queued = 0
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await svc.from('message_logs').insert(rows.slice(i, i + 200)).select('status')
    if (error) throw error
    queued += (data ?? []).filter((r) => r.status === 'QUEUED').length
  }

  if (queued > 0 && cfg?.worker_secret) {
    const url = Deno.env.get('SUPABASE_URL')!
    EdgeRuntime.waitUntil(fetch(`${url}/functions/v1/process-queue`, { method: 'POST', headers: { 'x-worker-secret': cfg.worker_secret } }).catch(() => {}))
  }

  return { batch_id: batch.id as string, total: rows.length, queued, skipped: rows.length - queued, mode: live ? 'live' : 'demo', sent_from: sentFrom, preflight: pre }
}

function checkTemplate(tpl: Row | null, project: Row | null, live = false) {
  const why = templateBlock(tpl as never, project as never, live)
  if (why) throw new HttpError(!tpl || !project ? 404 : 400, why)
}

/** Every page of a query, because the database returns at most 1000 rows at a time. */
async function allRows(page: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw error
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  return out
}

/** Runs one saved schedule. The timer has already marked it "sending". Nobody is signed in, so everything is checked here. */
async function runScheduled(svc: Db, cfg: Row, scheduledId: string) {
  const { data: row } = await svc.from('scheduled_sends').select('*').eq('id', scheduledId).maybeSingle()
  if (!row || row.status !== 'sending') return json({ error: 'Nothing to run' }, 404)
  // the database decides what happens next: a one-off send is finished, a repeating one moves to its next time
  const fail = async (message: string) => { await svc.rpc('finish_scheduled_send', { p_id: scheduledId, p_ok: false, p_error: message }); return json({ ok: false, error: message }) }

  try {
    // is the person who scheduled this still allowed to send for this company?
    const { data: prof } = await svc.from('profiles').select('status, is_superadmin').eq('id', row.sender_id).maybeSingle()
    if (prof?.status !== 'approved') return fail('The person who scheduled this no longer has access.')
    let allowed = !!prof.is_superadmin
    if (!allowed) {
      const { data: m } = await svc.from('entity_members').select('roles(permissions)').eq('user_id', row.sender_id).eq('entity_id', row.entity_id).maybeSingle()
      allowed = !!((m?.roles as { permissions?: string[] } | null)?.permissions ?? []).includes('message.send')
    }
    if (!allowed) return fail('The person who scheduled this is no longer allowed to send for this company.')

    const { data: tpl } = await svc.from('whatsapp_templates').select('*').eq('id', row.template_id).maybeSingle()
    const { data: project } = await svc.from('projects').select('id, name, code, entity_id, entities(name)').eq('id', row.project_id).maybeSingle()
    try { checkTemplate(tpl, project) } catch (e) { return fail(`${(e as Error).message}.`.replace('..', '.')) }

    // the clients are looked up now, so people added to a group since scheduling are included
    let ids: string[]
    if (row.all_clients) {
      ids = (await allRows((a, b) => svc.from('project_owners').select('owner_id').eq('project_id', row.project_id).order('owner_id').range(a, b))).map((r) => r.owner_id as string)
    } else {
      ids = (await allRows((a, b) => svc.from('client_list_members').select('owner_id').in('list_id', row.list_ids).order('owner_id').range(a, b))).map((r) => r.owner_id as string)
    }
    ids = [...new Set(ids)]
    if (!prof.is_superadmin) {
      const { data: scope } = await svc.from('member_scope').select('list_ids').eq('user_id', row.sender_id).eq('entity_id', row.entity_id).maybeSingle()
      if (scope) {
        const ok = new Set((await allRows((a, b) => svc.from('client_list_members').select('owner_id').in('list_id', scope.list_ids).order('owner_id').range(a, b))).map((r) => r.owner_id as string))
        ids = ids.filter((id) => ok.has(id))
      }
    }
    if (!ids.length) return fail('There were no clients left in the chosen groups.')
    if (ids.length > MAX_RECIPIENTS) return fail(`The groups now hold ${ids.length} clients, and at most ${MAX_RECIPIENTS} can be sent at a time.`)

    const links = await inBatches(ids, (part) => svc.from('project_owners').select(CLIENT_COLUMNS).eq('project_id', row.project_id).in('owner_id', part))
    if (!links.length) return fail('No matching clients in this list.')
    const { data: pre } = await svc.rpc('dispatch_preflight_core', { p_project: row.project_id, p_owner_ids: ids })

    const res = await dispatch(svc, cfg, row.sender_id, tpl!, project!, ids, links, pre, row.all_clients ? [] : (row.list_ids ?? []))
    await svc.rpc('finish_scheduled_send', { p_id: scheduledId, p_ok: true, p_batch: res.batch_id, p_result: { total: res.total, queued: res.queued, skipped: res.skipped, mode: res.mode } })
    return json({ ok: true, ...res })
  } catch (e) {
    console.error(e)
    return fail(e instanceof HttpError ? e.message : 'The scheduled send failed.')
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const auth = req.headers.get('Authorization') ?? ''
    const url = Deno.env.get('SUPABASE_URL')!
    const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: cfg } = await svc.from('whatsapp_config').select('*').eq('id', 1).single()
    const body = await req.json().catch(() => null)

    // the once-a-minute timer runs saved schedules with the worker secret instead of a login
    const secret = req.headers.get('x-worker-secret')
    if (secret) {
      if (!cfg?.worker_secret || secret !== cfg.worker_secret) return json({ error: 'Unauthorized' }, 401)
      if (!UUID.test(body?.scheduled_id ?? '')) return json({ error: 'Invalid schedule' }, 400)
      return await runScheduled(svc, cfg, body.scheduled_id)
    }

    const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
    const { data: ures } = await user.auth.getUser(auth.replace(/^Bearer /i, ''))
    const uid = ures?.user?.id
    if (!uid) return json({ error: 'Not signed in' }, 401)

    const templateId = body?.template_id, projectId = body?.project_id
    const ownerIds: string[] = Array.isArray(body?.owner_ids) ? body.owner_ids : []
    if (!UUID.test(templateId ?? '') || !UUID.test(projectId ?? '')) return json({ error: 'Invalid template or client list' }, 400)
    if (!ownerIds.length || !ownerIds.every((x) => UUID.test(x))) return json({ error: 'Select at least one recipient' }, 400)
    if (ownerIds.length > MAX_RECIPIENTS) return json({ error: `Send to at most ${MAX_RECIPIENTS} clients at a time` }, 400)

    const { data: allowed } = await user.rpc('can_access_project', { pid: projectId, perm: 'message.send' })
    if (!allowed) return json({ error: 'You are not allowed to send to this client list' }, 403)

    const { data: tpl } = await user.from('whatsapp_templates').select('*').eq('id', templateId).maybeSingle()
    const { data: project } = await user.from('projects').select('id, name, code, entity_id, entities(name)').eq('id', projectId).maybeSingle()
    checkTemplate(tpl, project)

    // read as the signed-in person, so they can only reach clients their access allows
    const links = await inBatches(ownerIds, (part) => user.from('project_owners').select(CLIENT_COLUMNS).eq('project_id', projectId).in('owner_id', part))
    if (!links.length) return json({ error: 'No matching clients in this list' }, 400)

    const { data: pre } = await user.rpc('dispatch_preflight', { p_project: projectId, p_owner_ids: ownerIds })
    // choices for numbers that appear more than once: combine several clients into one message, or send one per entry
    const inSend = new Set(ownerIds)
    const merge: Record<string, string[]> = {}
    if (body?.merge && typeof body.merge === 'object') {
      for (const [primary, others] of Object.entries(body.merge as Record<string, unknown>).slice(0, MAX_RECIPIENTS)) {
        if (!inSend.has(primary) || !Array.isArray(others)) continue
        const ok = others.filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, 20)
        if (ok.length) merge[primary] = ok
      }
    }
    const mergeIds = [...new Set(Object.values(merge).flat())]
    const mergeLinks = mergeIds.length ? await inBatches(mergeIds, (part) => user.from('project_owners').select(CLIENT_COLUMNS).eq('project_id', projectId).in('owner_id', part)) : []
    const eachPhones = new Set<string>((Array.isArray(body?.each_phones) ? body.each_phones : []).filter((x: unknown): x is string => typeof x === 'string' && /^\d{6,20}$/.test(x)).slice(0, MAX_RECIPIENTS))
    const requestId: string | undefined = UUID.test(body?.request_id ?? '') ? body.request_id : undefined
    if (requestId) { const done = await existingBatch(svc, uid, requestId); if (done) return json(done) }   // a retry or double click
    const listIds: string[] = Array.isArray(body?.list_ids) ? body.list_ids.filter((x: unknown) => typeof x === 'string' && UUID.test(x)).slice(0, 100) : []
    return json(await dispatch(svc, cfg, uid, tpl!, project!, ownerIds, links, pre, listIds, { merge, mergeLinks, eachPhones, requestId }))
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status)
    console.error(e)
    return json({ error: 'Dispatch failed' }, 500)
  }
})
