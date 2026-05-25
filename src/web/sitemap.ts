export interface SitemapEntry {
  path: string;
  lastmod?: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

interface SitemapOptions {
  origin?: string;
  generatedAt?: Date;
}

const DEFAULT_ORIGIN = "http://localhost:3000";

export async function generateSitemapXml(options: SitemapOptions = {}): Promise<string> {
  const origin = normalizeOrigin(options.origin ?? siteOriginFromEnv());
  const generatedDate = formatDate(options.generatedAt ?? new Date());
  const entries: SitemapEntry[] = [
    { path: "/", lastmod: generatedDate, changefreq: "hourly", priority: 1 }
  ];
  return renderSitemapXml(origin, entries);
}

export function generateRobotsTxt(origin = siteOriginFromEnv()): string {
  const normalized = normalizeOrigin(origin);
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /health",
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
