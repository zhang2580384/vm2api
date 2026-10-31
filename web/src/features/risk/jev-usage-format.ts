/** Missing cost stays 「未知」: an unreported price is not a free call. */
export const usageMoney = (nano: number | null) =>
  nano === null ? '未知' : `$${(nano / 1_000_000_000).toFixed(8)}`
