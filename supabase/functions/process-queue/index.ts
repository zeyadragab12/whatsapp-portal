import { createClient } from 'npm:@supabase/supabase-js@2'
import { classifySend, MAX_ATTEMPTS } from './outcome.ts'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

// Drains message_logs rows that are QUEUED. Triggered right after a dispatch and once a minute by pg_cron.
const BUDGET_MS = 100_000
const CLAIM = 40
const POOL = 12
const SPACING_MS = 15            // about 66 sends a second per number, under Meta's 80 a second default
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const FRIENDLY: Record<number, string> = {
  130429: 'Sending too fast for this WhatsApp number (throughput limit).',
  131056: 'Too many messages to the same person in a short time.',
  132018: 'The template parameters do not match the approved template.',
  132000: 'The number of template parameters does not match the template.',
  132001: 'This template does not exist in this language on the WhatsApp account.',
  132012: 'A template parameter has the wrong format.',
  131026: 'The message could not be delivered to this number.',
  131030: 'This recipient is not on the allowed list for the test number.',
  131047: 'More than 24 hours since the person last replied; only templates can be sent.',
  190: 'The access token is invalid or expired.',
  200: 'The access token is missing a required permission (whatsapp_business_messaging).',
  100: 'Meta rejected the request parameters.',
}

Deno.serve(async (req) => {
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: cfg } = await svc.from('whatsapp_config').select('*').eq('id', 1).single()
  if (!cfg || req.headers.get('x-worker-secret') !== cfg.worker_secret) return new Response('Unauthorized', { status: 401 })

  const run = async () => {
    const started = Date.now()
    const slots = new Map<string, number>()
    const { data: accts } = await svc.from('whatsapp_accounts').select('*')
    const byEntity = new Map((accts ?? []).map((a) => [a.entity_id as string, a]))
    const conn = (entityId: string) => {
      const a = byEntity.get(entityId)
      const token = a?.access_token ?? cfg.access_token ?? null
      const live = cfg.mode === 'live' && a?.mode === 'live' && !!a?.phone_number_id && !!a?.waba_id && !!token
      return { live, token, version: a?.api_version ?? cfg.api_version, phoneId: a?.phone_number_id as string | undefined }
    }

    const finish = (id: string, patch: Record<string, unknown>) =>
      svc.from('message_logs').update({ ...patch, locked_until: null, send_started_at: null, updated_at: new Date().toISOString() }).eq('id', id)

    const one = async (m: { id: string; entity_id: string; payload: unknown; attempts: number; sent_from: string | null }) => {
      const c = conn(m.entity_id)
      const wasLive = m.sent_from !== 'demo'
      if (!wasLive) {
        await finish(m.id, { status: 'SENT', wamid: `demo.${crypto.randomUUID()}`, sent_at: new Date().toISOString(), last_error: null })
        return
      }
      if (!c.live) {
        await finish(m.id, { status: 'FAILED', error_details: { code: 'CONNECTION_UNAVAILABLE', message: 'The WhatsApp connection was switched off or changed before this message was sent.' } })
        return
      }
      // pace each number
      const now = Date.now(); const slot = Math.max(slots.get(c.phoneId!) ?? 0, now)
      slots.set(c.phoneId!, slot + SPACING_MS)
      if (slot > now) await sleep(slot - now)
      // consent is checked again at the moment of sending: the person may have opted out while the message waited in the queue
      const { data: blocked, error: sErr } = await svc.rpc('suppressed_phones', { p_entity: m.entity_id, p_phones: [m.phone_number] })
      if (sErr) { await finish(m.id, { next_attempt_at: new Date(Date.now() + 60_000).toISOString(), last_error: 'Could not check consent, so the message was held back.' }); return }
      if ((blocked ?? []).length) {
        await finish(m.id, { status: 'FAILED', error_details: { code: 'OPT_OUT', message: 'Client opted out before this message was sent' } })
        return
      }
      await svc.from('message_logs').update({ send_started_at: new Date().toISOString() }).eq('id', m.id)   // from here on a crash leaves the result unknown
      let reply: { status: number; body: any } | undefined
      try {
        const res = await fetch(`https://graph.facebook.com/${c.version}/${c.phoneId}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(m.payload),
          signal: AbortSignal.timeout(30_000),
        })
        reply = { status: res.status, body: await res.json().catch(() => ({})) }
      } catch { /* no answer: the message may or may not have reached Meta */ }
      const out = classifySend(reply, m.attempts)
      if (out.action === 'sent') {
        await finish(m.id, { status: 'SENT', wamid: out.wamid, sent_at: new Date().toISOString(), last_error: null })
      } else if (out.action === 'retry') {
        const friendly = FRIENDLY[Number(reply?.body?.error?.code ?? 0)] ?? 'Too many requests.'
        await finish(m.id, { next_attempt_at: new Date(Date.now() + out.delaySec * 1000).toISOString(), last_error: `${friendly} Retry ${m.attempts} of ${MAX_ATTEMPTS}.` })
      } else if (out.action === 'unconfirmed') {
        // never resent on its own: Meta may already have it. Check the number's sent messages before sending this one again
        const message = 'Could not confirm whether WhatsApp received this message, so it was not sent again. Check before resending.'
        await finish(m.id, { status: 'FAILED', last_error: message, error_details: { code: 'UNCONFIRMED', message, http: reply?.status ?? null, attempts: m.attempts } })
      } else {
        const j = reply!.body
        const friendly = FRIENDLY[out.code] ?? j?.error?.message ?? `HTTP ${reply!.status}`
        await finish(m.id, { status: 'FAILED', last_error: friendly, error_details: { code: out.code, message: friendly, raw: j?.error ?? null, attempts: m.attempts } })
      }
    }

    while (Date.now() - started < BUDGET_MS) {
      const { data: claimed } = await svc.rpc('claim_messages', { p_limit: CLAIM, p_lock_seconds: 120 })
      const { data: demoPending } = await svc.rpc('demo_advance')
      if (!claimed?.length) {
        const { count } = await svc.from('message_logs').select('id', { count: 'exact', head: true }).eq('status', 'QUEUED')
        if (!count && !demoPending) break          // nothing left to do
        await sleep(1500)                           // waiting on a retry delay or the 7 second pair spacing
        continue
      }
      let next = 0
      await Promise.all(Array.from({ length: Math.min(POOL, claimed.length) }, async () => {
        while (next < claimed.length) { const m = claimed[next++]; await one(m) }
      }))
    }
  }
  EdgeRuntime.waitUntil(run().catch((e) => console.error(e)))
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { 'Content-Type': 'application/json' } })
})
