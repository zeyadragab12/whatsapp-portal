// A stand-in for @supabase/supabase-js so edge functions run in tests with synthetic data and no network.
export const db = {
  tables: {} as Record<string, unknown[]>,
  rpc: [] as { name: string; args: unknown }[],
  updates: [] as { table: string; values: unknown }[],
  inserts: [] as { table: string; values: unknown }[],
  user: null as { id: string } | null,
  rpcResults: {} as Record<string, unknown>,
  reset() { this.tables = {}; this.rpc = []; this.updates = []; this.inserts = []; this.user = null; this.rpcResults = {} },
}

const result = (table: string) => ({ data: db.tables[table] ?? [], error: null })

function builder(table: string): any {
  const b: any = {
    select: () => b, eq: () => b, not: () => b, in: () => b, order: () => b, limit: () => b,
    insert: (values: unknown) => { db.inserts.push({ table, values }); return b },
    gte: () => b, neq: () => b, is: () => b,
    update: (values: unknown) => { db.updates.push({ table, values }); return b },
    single: () => Promise.resolve({ data: (db.tables[table] ?? [])[0] ?? null, error: null }),
    maybeSingle: () => Promise.resolve({ data: (db.tables[table] ?? [])[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result(table)).then(ok, bad),
  }
  return b
}

export const createClient = () => ({
  from: (table: string) => builder(table),
  rpc: (name: string, args: unknown) => { db.rpc.push({ name, args }); return Promise.resolve({ data: db.rpcResults[name] ?? null, error: null }) },
  auth: { getUser: () => Promise.resolve({ data: { user: db.user } }) },
})
