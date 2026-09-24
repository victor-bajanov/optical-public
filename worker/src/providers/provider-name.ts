export type ProviderName = "google" | "microsoft";

export function isProviderName(v: string): v is ProviderName {
  return v === "google" || v === "microsoft";
}
