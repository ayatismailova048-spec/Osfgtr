// Собирает файлы из public/ в src/assets.js, чтобы сервер отдавал их сам (запуск: node build-assets.mjs)
import fs from "node:fs";
const types = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml", png: "image/png", webmanifest: "application/manifest+json" };
const out = {};
for (const f of fs.readdirSync("public")) {
  const ext = f.split(".").pop(), buf = fs.readFileSync("public/" + f);
  out["/" + f] = { type: types[ext] || "application/octet-stream", b64: buf.toString("base64") };
}
fs.writeFileSync("src/assets.js", "// Создано автоматически: node build-assets.mjs\nexport default " + JSON.stringify(out) + ";\n");
console.log("assets:", Object.keys(out).join(", "));
