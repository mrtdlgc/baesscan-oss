import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateRobotsTxt, generateSitemapXml, siteOriginFromEnv } from "../web/sitemap";

async function main(): Promise<void> {
  const webBuildDir = path.resolve("build", "web");
  await mkdir(webBuildDir, { recursive: true });
  await copyFile(path.resolve("src", "web", "styles.css"), path.join(webBuildDir, "styles.css"));
  await copyAssetDirectory(path.resolve("src", "web", "assets"), webBuildDir);
  const origin = siteOriginFromEnv();
  await writeFile(path.join(webBuildDir, "sitemap.xml"), await generateSitemapXml({ origin }), "utf8");
  await writeFile(path.join(webBuildDir, "robots.txt"), generateRobotsTxt(origin), "utf8");
}

async function copyAssetDirectory(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  await mkdir(targetDir, { recursive: true });
  await Promise.all(entries.map(async (entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyAssetDirectory(sourcePath, targetPath);
      return;
    }
    if (entry.isFile()) await copyFile(sourcePath, targetPath);
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
