-- These helper RPCs are not part of the public API and expose broker data.
revoke all on function public.test_func1(integer) from public, anon, authenticated;
revoke all on function public.test_func2(integer) from public, anon, authenticated;
revoke all on function public.test_func3(integer) from public, anon, authenticated;
revoke all on function public.test_func4(integer) from public, anon, authenticated;
grant execute on function public.test_func1(integer), public.test_func2(integer),
  public.test_func3(integer), public.test_func4(integer) to service_role;
