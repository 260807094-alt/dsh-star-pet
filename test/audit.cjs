/*
 * 静态一致性审计：不做运行时，只做「跨文件引用是否对得上」的交叉校验。
 * 这类错误在无打包器的全局脚本项目里最容易漏（改名后另一处还在用旧名）。
 *
 *   node test/audit.cjs
 */
const path = require("node:path");
const { readFileSync } = require("node:fs");

const ROOT = path.join(__dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const Core = require("../runtime/helper/core.js");

const files = {
	core: read("runtime/helper/core.js"),
	main: read("runtime/helper/main.js"),
	renderer: read("runtime/helper/renderer.js"),
	settings: read("runtime/helper/settings.js"),
	menu: read("runtime/helper/menu.js"),
	preload: read("runtime/helper/preload.js"),
	host: read("lib/index.js"),
	client: read("lib/client.js"),
	indexHtml: read("runtime/helper/index.html"),
	settingsHtml: read("runtime/helper/settings.html"),
	menuHtml: read("runtime/helper/menu.html"),
};

const problems = [];
const notes = [];
const bad = (msg) => problems.push(msg);

/* ---------- 1. core 导出的成员 vs 各处 Core.X 的用法 ---------- */
const coreExports = new Set(Object.keys(Core));
for (const [name, src] of Object.entries({ renderer: files.renderer, settings: files.settings, menu: files.menu, main: files.main, host: files.host })) {
	const used = new Set();
	for (const m of src.matchAll(/\bCore\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
	for (const k of used) if (!coreExports.has(k)) bad(`${name} 用了 core 不存在的东西：Core.${k}`);
	notes.push(`${name} 使用 Core.${[...used].sort().join(", Core.")}`);
}
// lib/index.js 是 ESM default 导入
ok: {
	const used = new Set();
	for (const m of files.host.matchAll(/\bCore\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
	for (const k of used) if (!coreExports.has(k)) bad(`lib/index.js 用了 core 不存在的东西：Core.${k}`);
}

/* ---------- 2. getElementById 的 id 必须在对应 HTML 里存在 ---------- */
function idsIn(html) {
	const out = new Set();
	for (const m of html.matchAll(/\bid=["']([^"']+)["']/g)) out.add(m[1]);
	return out;
}
for (const [page, script, html] of [
	["index.html", "renderer", files.indexHtml],
	["settings.html", "settings", files.settingsHtml],
	["menu.html", "menu", files.menuHtml],
]) {
	const defined = idsIn(html);
	const used = new Set();
	for (const m of files[script].matchAll(/getElementById\("([^"]+)"\)/g)) used.add(m[1]);
	for (const m of files[script].matchAll(/getElementById\('([^']+)'\)/g)) used.add(m[1]);
	for (const id of used) if (!defined.has(id)) bad(`${script}.js 取 #${id}，但 ${page} 里没有这个 id`);
}

/* ---------- 3. 页面用到的 preload 能力必须真的暴露 ---------- */
const preloadApi = new Set();
for (const m of files.preload.matchAll(/^\t([A-Za-z_$][\w$]*)\s*\(/gm)) preloadApi.add(m[1]);
for (const [page, script] of [["renderer", files.renderer], ["settings", files.settings], ["menu", files.menu]]) {
	const used = new Set();
	for (const m of script.matchAll(/\bS\.([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[1]);
	for (const k of used) if (!preloadApi.has(k)) bad(`${page}.js 调了 S.${k}()，但 preload 没暴露它`);
}

/* ---------- 4. IPC 频道：preload 发的必须被 main 处理 ---------- */
const mainHandles = new Set();
for (const m of files.main.matchAll(/ipcMain\.(?:on|handle)\("([^"]+)"/g)) mainHandles.add(m[1]);
const preloadSends = new Set();
for (const m of files.preload.matchAll(/ipcRenderer\.(?:send|invoke)\("([^"]+)"/g)) preloadSends.add(m[1]);
for (const ch of preloadSends) if (!mainHandles.has(ch)) bad(`preload 发 ${ch}，main 没监听`);
for (const ch of mainHandles) if (!preloadSends.has(ch)) notes.push(`main 监听 ${ch}，但没有页面通过 preload 调用（可能是死代码）`);

/* ---------- 5. 宿主路由：调用的必须存在 ---------- */
const hostRoutes = new Set();
for (const m of files.host.matchAll(/ROUTE_PREFIX \+ "([^"]+)"/g)) hostRoutes.add(m[1]);
const called = [];
for (const m of files.renderer.matchAll(/S\.req\("[A-Z]+",\s*"([^"]+)"/g)) called.push(["renderer", m[1]]);
for (const m of files.main.matchAll(/request\("(?:GET|POST)",\s*"([^"]+)"/g)) called.push(["main", m[1]]);
for (const m of files.client.matchAll(/api\("([^"]+)"/g)) called.push(["client", m[1]]);
for (const [who, route] of called) {
	const norm = route.replace(/^\/dsh-star-pet/, "");
	if (!hostRoutes.has(norm)) bad(`${who} 调 ${route}，但宿主没有这条路由`);
}
for (const r of hostRoutes) notes.push(`宿主路由 ${r}`);

/* ---------- 6. 各处提交的配置键必须在 CONFIG_KEYS 里 ---------- */
const keys = new Set(Core.CONFIG_KEYS);
// menu.js: S.apply({ xxx: ... })
for (const m of files.menu.matchAll(/S\.apply\(\{\s*([A-Za-z_$][\w$]*):/g)) {
	if (!keys.has(m[1])) bad(`menu.js 提交了未知配置键 ${m[1]}`);
}
// settings.js: FLAGS / RATE_ROWS 的键（MODES 里的 workday/allday 是枚举值不是配置键）
const MODES = new Set(["workday", "allday"]);
for (const m of files.settings.matchAll(/\["([a-z_]+)",\s*"[^"]+"\]/g)) {
	if (MODES.has(m[1])) continue;
	if (!keys.has(m[1])) bad(`settings.js 的选项列表里有未知配置键 ${m[1]}`);
}
const assigned = new Set();
for (const m of files.settings.matchAll(/cfg\.([a-z_]+)\s*=/g)) assigned.add(m[1]);
for (const k of assigned) if (!keys.has(k)) bad(`settings.js 写了未知配置键 cfg.${k}`);

/* ---------- 7. 每个配置键都要有 UI 入口（否则只能手改 JSON） ---------- */
const uiKeys = new Set([...assigned]);
for (const m of files.menu.matchAll(/S\.apply\(\{\s*([A-Za-z_$][\w$]*):/g)) uiKeys.add(m[1]);
// 设置页的开关组（FLAGS）和倍率行（RATE_ROWS）也是入口
for (const m of files.settings.matchAll(/\["([a-z_]+)",\s*"[^"]+"\]/g)) if (!MODES.has(m[1])) uiKeys.add(m[1]);
const noUi = Core.CONFIG_KEYS.filter((k) => !uiKeys.has(k));
if (noUi.length) bad(`这些配置键没有设置页/菜单入口，只能手改 JSON：${noUi.join(", ")}`);

/* ---------- 8. 默认配置的每个键都要被 deriveModel/snapshot 真正读到 ---------- */
const consumed = new Set();
const allCore = files.core + files.renderer + files.settings + files.menu + files.main + files.host;
for (const k of Core.CONFIG_KEYS) {
	const re = new RegExp("[.\\[\"']" + k + "\\b|\"" + k + "\"");
	if (re.test(allCore)) consumed.add(k);
}
const unread = Core.CONFIG_KEYS.filter((k) => !consumed.has(k));
for (const k of unread) bad(`配置键 ${k} 定义了但没有任何代码读它`);

/* ---------- 9. 硬编码的旧常量的残留 ---------- */
const legacy = ["roll_numbers", "snap_sides", "daily_wage", "extra_workdays", "overtime_rate_holiday", "margin_right", "margin_bottom", "canonical", "PET_SIZES = ["];
for (const token of legacy) {
	for (const [name, src] of Object.entries(files)) {
		if (name === "core") continue;
		if (src.includes(token)) {
			// main.js 的 MARGIN_* 是几何默认值，注释里提到旧字段名不算问题
			const lines = src.split("\n").filter((l) => l.includes(token) && !/^\s*(\/\/|\*|\/\*)/.test(l));
			if (lines.length) bad(`${name} 里仍有旧字段/重复定义 "${token}"：${lines[0].trim()}`);
		}
	}
}

/* ---------- 10. 三个页面都必须先加载 core.js ---------- */
for (const [page, html, scriptName] of [
	["index.html", files.indexHtml, "renderer.js"],
	["settings.html", files.settingsHtml, "settings.js"],
	["menu.html", files.menuHtml, "menu.js"],
]) {
	const ci = html.indexOf("./core.js");
	const si = html.indexOf("./" + scriptName);
	if (ci < 0) bad(`${page} 没有加载 core.js`);
	else if (si < 0) bad(`${page} 没有加载 ${scriptName}`);
	else if (ci > si) bad(`${page} 里 core.js 在 ${scriptName} 之后加载，页面会拿到 undefined Core`);
}

/* ---------- 输出 ---------- */
console.log("静态审计：");
for (const n of notes) console.log("  · " + n);
if (problems.length) {
	console.log("\n发现 " + problems.length + " 个问题：");
	for (const p of problems) console.log("  ✗ " + p);
	process.exit(1);
}
console.log("\n全部通过（无跨文件引用错位）");
