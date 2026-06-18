import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "..");
const sourceData = path.join(repoRoot, "data");
const outDir = path.join(packageRoot, "r2-data");

async function assertExists(file) {
  await stat(file);
}

async function main() {
  await assertExists(path.join(sourceData, "site-data.json"));
  await assertExists(path.join(sourceData, "search-manifest.json"));
  await assertExists(path.join(sourceData, "search-chunks"));
  await assertExists(path.join(sourceData, "children"));

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "meta"), { recursive: true });

  await cp(path.join(sourceData, "site-data.json"), path.join(outDir, "meta", "site-data.json"));
  await cp(path.join(sourceData, "search-manifest.json"), path.join(outDir, "meta", "search-manifest.json"));
  await cp(path.join(sourceData, "search-chunks"), path.join(outDir, "search-chunks"), { recursive: true });
  await cp(path.join(sourceData, "children"), path.join(outDir, "children"), { recursive: true });

  console.log(`Prepared R2 data at ${outDir}`);
  console.log("Upload every file in this folder to the private R2 bucket with the same relative key.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
