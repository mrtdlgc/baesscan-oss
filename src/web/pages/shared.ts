interface PageOptions {
  description?: string;
  canonicalPath?: string;
  imagePath?: string;
  ogType?: "website" | "article";
  robots?: string;
}

const DEFAULT_META_DESCRIPTION = "baes scan is a Telegram-first buybot for pool-aware DEX buy alerts, holder intel, and route-specific token launch monitoring.";
const BUYBOT_ONLY_META_DESCRIPTION = "baes scan is a Telegram-first buybot for pool-aware DEX buy alerts and route-specific token launch monitoring.";
const DEFAULT_OG_IMAGE = "/og/baes-scan.png";
const BLOCKSCOUT_URL = "https://www.blockscout.com/";
export const OSS_REPO_URL = "https://github.com/mrtdlgc/baesscan-oss";

export function page(title: string, body: string, options: PageOptions = {}): string {
  const description = options.description ?? (intelEnabledFromEnv() ? DEFAULT_META_DESCRIPTION : BUYBOT_ONLY_META_DESCRIPTION);
  const canonical = options.canonicalPath ? absoluteUrl(options.canonicalPath) : undefined;
  const image = absoluteUrl(options.imagePath ?? DEFAULT_OG_IMAGE);
  const ogType = options.ogType ?? "website";
  const robots = options.robots ?? "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeText(title)}</title>
  <meta name="description" content="${escapeAttr(description)}" />
  <meta name="robots" content="${escapeAttr(robots)}" />
  ${canonical ? `<link rel="canonical" href="${escapeAttr(canonical)}" />` : ""}
  <meta property="og:site_name" content="baes scan" />
  <meta property="og:title" content="${escapeAttr(title)}" />
  <meta property="og:description" content="${escapeAttr(description)}" />
  <meta property="og:type" content="${escapeAttr(ogType)}" />
  ${canonical ? `<meta property="og:url" content="${escapeAttr(canonical)}" />` : ""}
  <meta property="og:image" content="${escapeAttr(image)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${escapeAttr(`${title} preview card`)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeAttr(title)}" />
  <meta name="twitter:description" content="${escapeAttr(description)}" />
  <meta name="twitter:image" content="${escapeAttr(image)}" />
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-SFVMXZRQX5"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-SFVMXZRQX5');
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Work+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body><main>${body}</main>${blockscoutFooter()}</body>
</html>`;
}

export function blockscoutPoweredLink(className = "blockscout-powered-link"): string {
  const classes = className === "blockscout-powered-link" ? className : `blockscout-powered-link ${className}`;
  return `<a class="${escapeAttr(classes)}" href="${BLOCKSCOUT_URL}" target="_blank" rel="noreferrer"><span>Powered by</span><strong>Blockscout</strong></a>`;
}

function blockscoutFooter(): string {
  return `
<footer class="site-footer" aria-label="Site credits">
  <div>
    <span>baes scan</span>
    <nav class="site-footer-links" aria-label="Project links">
      <a class="site-footer-github" href="${OSS_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
      ${blockscoutPoweredLink("site-footer-blockscout")}
    </nav>
  </div>
</footer>`;
}

function intelEnabledFromEnv(): boolean {
  const raw = process.env.INTEL_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const pathname = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${publicOrigin()}${pathname}`;
}

function publicOrigin(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim() || process.env.SITEMAP_BASE_URL?.trim();
  if (!explicit) return "https://baesscan.com";
  const withScheme = /^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`;
  return withScheme.replace(/\/+$/g, "");
}

export function escapeText(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeAttr(value: unknown): string {
  return escapeText(value).replace(/'/g, "&#39;");
}

