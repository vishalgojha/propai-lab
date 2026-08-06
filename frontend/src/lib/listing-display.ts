export function formatBuildingName(value?: string | null): string {
  return value?.trim() || "On Request";
}
