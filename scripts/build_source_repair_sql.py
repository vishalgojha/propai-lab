#!/usr/bin/env python3
"""Convert the approved repair CSV into one guarded SQL transaction."""
import csv
import json
from collections import defaultdict
import sys


def quote(value):
    if value in (None, ""):
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def build(path):
    localities = defaultdict(list)
    prices = defaultdict(list)
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            table = row["table"]
            tenant = quote(row["tenant_id"])
            row_id = int(row["id"])
            if row["action"] == "set_locality_fields":
                localities[table].append(
                    f"({row_id},{tenant},{int(row['new_locality_id'])},"
                    f"{quote(row['new_locality'])},{quote(row['locality_confidence'] or 'medium')})"
                )
            else:
                prices[table].append(
                    f"({row_id},{tenant},{float(row['new_price'])},{quote(row['price_source'])})"
                )
    statements = []
    for table, values in localities.items():
        statements.append(f"""
with v(id, tenant_id, new_id, new_loc, new_conf) as (values {','.join(values)})
update public.{table} x
set locality_id = v.new_id,
    locality_resolved = v.new_loc,
    micro_market = v.new_loc,
    locality_match_status = 'matched',
    locality_confidence = v.new_conf,
    validation_flags = coalesce((select array_agg(f) from unnest(coalesce(x.validation_flags, array[]::text[])) f where f not in ('locality_unresolved', 'locality_resolution_ambiguous', 'building_places_locality_ambiguous')), array[]::text[]),
    corrected_fields = array(select distinct f from unnest(coalesce(x.corrected_fields, array[]::text[]) || array['source_attached_locality_repair']) f),
    corrected_at = now()
from v
where x.id = v.id and x.tenant_id is not distinct from v.tenant_id and x.locality_id is null;
""")
    for table, values in prices.items():
        field = "monthly_rent" if "_rent_" in table else "total_asking_price"
        statements.append(f"""
with v(id, tenant_id, new_price, price_text) as (values {','.join(values)})
update public.{table} x
set {field} = v.new_price,
    price_raw_text = v.price_text,
    corrected_fields = array(select distinct f from unnest(coalesce(x.corrected_fields, array[]::text[]) || array['source_attached_price_repair']) f),
    corrected_at = now()
from v
where x.id = v.id and x.tenant_id is not distinct from v.tenant_id and x.{field} is null;
""")
    return "begin;" + "".join(statements) + "commit;"


if __name__ == "__main__":
    print(json.dumps({"query": build(sys.argv[1])}))
