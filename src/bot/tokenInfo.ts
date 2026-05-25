export function sanitizeWebsiteUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString().slice(0, 240);
  } catch {
    return undefined;
  }
}

export function sanitizeDescription(value: string): string | undefined {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 600) : undefined;
}
