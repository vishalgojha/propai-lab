-- Phase 4 compensating control.
-- pg_net is non-relocatable on this project, so it must remain in public.
-- Its helper and HTTP functions are not used by application code; keep them
-- available to trusted server calls only.

revoke all on function net.check_worker_is_up() from public, anon, authenticated;
revoke all on function net._await_response(bigint) from public, anon, authenticated;
revoke all on function net._urlencode_string(character varying) from public, anon, authenticated;
revoke all on function net._encode_url_with_params_array(text, text[]) from public, anon, authenticated;
revoke all on function net.worker_restart() from public, anon, authenticated;
revoke all on function net.wait_until_running() from public, anon, authenticated;
revoke all on function net.wake() from public, anon, authenticated;
revoke all on function net.http_get(text, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function net.http_post(text, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function net.http_delete(text, jsonb, jsonb, integer, jsonb) from public, anon, authenticated;
revoke all on function net._http_collect_response(bigint, boolean) from public, anon, authenticated;
revoke all on function net.http_collect_response(bigint, boolean) from public, anon, authenticated;

grant execute on function net.check_worker_is_up() to service_role;
grant execute on function net._await_response(bigint) to service_role;
grant execute on function net._urlencode_string(character varying) to service_role;
grant execute on function net._encode_url_with_params_array(text, text[]) to service_role;
grant execute on function net.worker_restart() to service_role;
grant execute on function net.wait_until_running() to service_role;
grant execute on function net.wake() to service_role;
grant execute on function net.http_get(text, jsonb, jsonb, integer) to service_role;
grant execute on function net.http_post(text, jsonb, jsonb, jsonb, integer) to service_role;
grant execute on function net.http_delete(text, jsonb, jsonb, integer, jsonb) to service_role;
grant execute on function net._http_collect_response(bigint, boolean) to service_role;
grant execute on function net.http_collect_response(bigint, boolean) to service_role;
