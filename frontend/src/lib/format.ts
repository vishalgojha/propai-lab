function compactNumber(value: number, maximumFractionDigits = 2) {
  return value.toLocaleString("en-IN", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  });
}

export function formatBrokerPrice(value?: number | null) {
  if (value == null || Number.isNaN(value)) return "";
  const amount = Number(value);
  if (amount >= 10000000) return `${compactNumber(amount / 10000000)} Cr`;
  if (amount >= 100000) return `${compactNumber(amount / 100000)} Lac`;
  if (amount >= 1000) return `${compactNumber(amount / 1000)} K`;
  return compactNumber(amount);
}
