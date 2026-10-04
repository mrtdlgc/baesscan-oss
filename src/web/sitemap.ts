export interface SitemapEntry {
  path: string;
  lastmod?: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

interface SitemapOptions {
  origin?: string;
  generatedAt?: Date;
  intelEnabled?: boolean;
}

const DEFAULT_ORIGIN = "http://localhost:3000";

export async function generateSitemapXml(options: SitemapOptions = {}): Promise<string> {
  const origin = normalizeOrigin(options.origin ?? siteOriginFromEnv());
  const generatedDate = formatDate(options.generatedAt ?? new Date());
  const intelEnabled = options.intelEnabled ?? boolEnv("INTEL_ENABLED", true);
  const entries: SitemapEntry[] = [
    { path: "/", lastmod: generatedDate, changefreq: "hourly", priority: 1 },
    ...(intelEnabled ? [
      { path: "/intel", lastmod: generatedDate, changefreq: "hourly" as const, priority: 0.9 }
    ] : [])
  ];
  return renderSitemapXml(origin, entries);
}

export function generateRobotsTxt(origin = siteOriginFromEnv(), options: { intelEnabled?: boolean } = {}): string {
  const normalized = normalizeOrigin(origin);
  const intelEnabled = options.intelEnabled ?? boolEnv("INTEL_ENABLED", true);
  const disallow = [
    "Disallow: /api/",
    "Disallow: /health",
    ...(intelEnabled ? [] : [
      "Disallow: /intel",
      "Disallow: /admin/wallet-pnl",
      "Disallow: /admin/copy-shadow"
    ])
  ];
  return [
    "User-agent: *",
    "Allow: /",
    ...disallow,
    `Sitemap: ${new URL("/sitemap.xml", normalized).toString()}`
  ].join("\n") + "\n";
}

export function siteOriginFromEnv(): string {
  return process.env.SITEMAP_BASE_URL?.trim()
    || process.env.PUBLIC_BASE_URL?.trim()
    || DEFAULT_ORIGIN;
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // fall through
  }
  return DEFAULT_ORIGIN;
}

function renderSitemapXml(origin: string, entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const lines = [
      "  <url>",
      `    <loc>${escapeXml(new URL(entry.path, origin).toString())}</loc>`
    ];
    if (entry.lastmod) lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
    if (entry.changefreq) lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
    if (entry.priority !== undefined) lines.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
    lines.push("  </url>");
    return lines.join("\n");
  }).join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    ""
  ].join("\n");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
