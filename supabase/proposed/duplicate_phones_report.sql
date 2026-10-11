-- READ-ONLY. Run in the Supabase SQL editor to see how many phones are stored on more than one client row.
-- This is the data you must decide about before phone can become a database-level unique key (see the audit report, finding F-1).
select o.phone, count(*) as client_rows, count(distinct o.full_name) as names,
       bool_or(not o.whatsapp_opt_in) as any_opted_out, bool_and(not o.whatsapp_opt_in) as all_opted_out
from public.owners o
group by o.phone
having count(*) > 1
order by client_rows desc;
