import { build } from "esbuild";
import { zipSync, strToU8 } from "fflate";
import { mkdir, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "build");
const dist = path.join(root, "dist");
await mkdir(out, { recursive: true });
await mkdir(dist, { recursive: true });
await build({ entryPoints: [path.join(root, "src/main.mjs")], outfile: path.join(out, "plugin.js"), bundle: true, format: "iife", globalName: "GPTForZotero", target: "firefox140", legalComments: "eof" });
const files = {};
for (const name of ["bootstrap.js", "manifest.json", "panel.css", "icons/llm.svg"]) {
  await mkdir(path.dirname(path.join(out, name)), { recursive: true });
  await copyFile(path.join(root, "addon", name), path.join(out, name));
  files[name] = new Uint8Array(await readFile(path.join(out, name)));
}
files["plugin.js"] = new Uint8Array(await readFile(path.join(out, "plugin.js")));
// Ship the math renderer's stylesheet and fonts locally; no CDN is needed.
const katex = path.join(root, "node_modules/katex");
files["vendor/katex/katex.min.css"] = new Uint8Array(await readFile(path.join(katex, "dist/katex.min.css")));
files["vendor/katex/LICENSE"] = new Uint8Array(await readFile(path.join(katex, "LICENSE")));
for (const name of await readdir(path.join(katex, "dist/fonts"))) {
  files[`vendor/katex/fonts/${name}`] = new Uint8Array(await readFile(path.join(katex, "dist/fonts", name)));
}
files["THIRD_PARTY_NOTICES.txt"] = strToU8(await readFile(path.join(root, "THIRD_PARTY_NOTICES.txt"), "utf8"));
files["LICENSE"] = new Uint8Array(await readFile(path.join(root, "LICENSE")));
const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
for (const key of ["id", "update_url", "strict_min_version", "strict_max_version"]) {
  if (!manifest.applications?.zotero?.[key]) throw new Error(`Missing Zotero manifest field: ${key}`);
}
const target = path.join(dist, `llm-for-zotero-${manifest.version}.xpi`);
await writeFile(target, zipSync(files, { level: 6 }));
console.log(target);
