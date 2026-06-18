import { readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const dataRoot = path.join(packageRoot, "r2-data");
const bucket = process.argv[2] || process.env.R2_BUCKET || "kneeforyou-private-data";
const dryRun = process.argv.includes("--dry-run");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }

  return files;
}

function toR2Key(file) {
  return path.relative(dataRoot, file).split(path.sep).join("/");
}

function upload(file, index, total) {
  const key = toR2Key(file);
  const target = `${bucket}/${key}`;
  const args = ["wrangler", "r2", "object", "put", target, "--file", file];

  console.log(`[${index}/${total}] ${key}`);
  if (dryRun) return;

  const result = spawnSync(npx, args, { cwd: packageRoot, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Upload failed: ${key}`);
  }
}

async function main() {
  await stat(dataRoot);
  const files = await walk(dataRoot);
  console.log(`Uploading ${files.length} files to R2 bucket ${bucket}`);

  for (let index = 0; index < files.length; index += 1) {
    upload(files[index], index + 1, files.length);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
