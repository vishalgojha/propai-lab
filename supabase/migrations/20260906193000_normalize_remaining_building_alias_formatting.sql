-- The first cleanup intentionally skipped alias collisions. Alias rows do not
-- define building identity, so normalize all remaining outer WhatsApp
-- formatting now; no aliases or buildings are deleted.
begin;

update public.building_name_aliases
set alias = nullif(btrim(regexp_replace(regexp_replace(btrim(alias), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')), ''),
    canonical_name = nullif(btrim(regexp_replace(regexp_replace(btrim(canonical_name), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')), '')
where alias ~ '(^[*_~`]+|[*_~`]+$)'
   or canonical_name ~ '(^[*_~`]+|[*_~`]+$)';

commit;
