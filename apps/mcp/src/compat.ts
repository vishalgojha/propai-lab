export function deprecatedAlias<T extends Record<string, unknown>>(payload: T, useInstead: string) {
  return {
    ...payload,
    deprecated: true,
    use_instead: useInstead,
  };
}
