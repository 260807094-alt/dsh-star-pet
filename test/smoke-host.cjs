/*
 * 冒烟宿主：在本机把 runtime/helper 真正跑起来，用于人工/自动检查。
 * 它的路由语义与 lib/index.js 完全一致（同一份 core.js 的 sanitize/validate），
 * 唯一区别是不依赖 DSH 的 ctx，直接用 node:http 起在 127.0.0.1 的随机端口。
 *
 * 用法：
 *   node test/smoke-host.cjs                 # 起宿主 + 拉起桌宠，Ctrl+C 结束
 *   node test/smoke-host.cjs --shot out.png  # 起宿主，等 12 秒截图后退出（需要 Electron）
 *   node test/smoke-host.cjs --cfg overtime  # 用「加班中」的样例配置
 */
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const Core = require("../runtime/helper/core.js");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "runtime", "helper", "main.js");
const PREFIX = "/dsh-star-pet";
const ROUTE = PREFIX;

const args = process.argv.slice(2);
const shotAt = args.includes("--shot") ? args[args.indexOf("--shot") + 1] : null;
const scenario = args.includes("--cfg") ? args[args.indexOf("--cfg") + 1] : "default";

const STORE = path.join(__dirname, ".smoke", "store.json");
mkdirSync(path.dirname(STORE), { recursive: true });

function readStore() {
	try {
		const raw = JSON.parse(readFileSync(STORE, "utf8"));
		return { config: { ...Core.DEFAULT_CONFIG, ...Core.sanitizePatch(raw.config) }, window: raw.window || null };
	} catch (e) {
		return { config: { ...Core.DEFAULT_CONFIG }, window: null };
	}
}
function writeStore(store) {
	writeFileSync(STORE, JSON.stringify(store, null, 2), "utf8");
}

if (!existsSync(STORE)) {
	const base = { ...Core.DEFAULT_CONFIG };
	if (scenario === "overtime") {
		Object.assign(base, {
			overtime_enabled: true,
			overtime_weekdays: [1, 2, 3, 4, 5],
			overtime_start_workday: "09:00",
			overtime_end_workday: "23:00",
			overtime_rate_workday: "1.5",
		});
	}
	writeStore({ config: base, window: null });
}

function resolveElectron() {
	const cands = [];
	if (process.env.DSH_STAR_PET_ELECTRON_PATH) cands.push(process.env.DSH_STAR_PET_ELECTRON_PATH);
	const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
	const exe = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
	cands.push(path.join(home, "electron", exe));
	for (const c of cands) if (c && existsSync(c)) return c;
	return null;
}

let visible = true;
let child = null;
let helperLog = [];

function readBody(req) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > 64 * 1024) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text) return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch (e) {
				resolve(null);
			}
		});
		req.on("error", () => resolve(null));
	});
}

function sendJson(res, code, obj) {
	if (!res || res.writableEnded) return;
	const body = JSON.stringify(obj);
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

function petState() {
	const running = child !== null && child.exitCode === null && child.killed === false;
	return { running, visible: running && visible, error: "", electron: resolveElectron(), installing: false };
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	const p = url.pathname;
	const method = req.method || "GET";
	try {
		if (p === ROUTE + "/config") {
			if (method === "GET") return sendJson(res, 200, readStore());
			if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
			const patch = await readBody(req);
			if (!patch) return sendJson(res, 400, { error: "配置不是合法 JSON" });
			const store = readStore();
			const pending = { ...store.config, ...Core.sanitizePatch(patch) };
			const verr = Core.validateConfig(pending);
			if (verr) return sendJson(res, 400, { error: verr });
			store.config = pending;
			writeStore(store);
			console.log("[host] config saved:", JSON.stringify(Core.CONFIG_KEYS.filter((k) => k in patch)));
			return sendJson(res, 200, { config: pending });
		}
		if (p === ROUTE + "/window") {
			const win = await readBody(req);
			if (!win) return sendJson(res, 400, { error: "窗口位置不是合法 JSON" });
			const store = readStore();
			store.window = { x: Math.round(win.x) || 0, y: Math.round(win.y) || 0 };
			writeStore(store);
			return sendJson(res, 200, { window: store.window });
		}
		if (p === ROUTE + "/pet/state") return sendJson(res, 200, Object.assign(petState(), { port: server.address().port }));
		if (p === ROUTE + "/pet/visible") {
			if (method === "GET") return sendJson(res, 200, petState());
			const body = await readBody(req);
			let want = null;
			if (body && typeof body.visible === "boolean") want = body.visible;
			else if (body && typeof body.show === "boolean") want = body.show;
			if (want === null) return sendJson(res, 400, { error: "缺少 visible 布尔值" });
			visible = want;
			console.log("[host] visible ->", want);
			return sendJson(res, 200, petState());
		}
		if (p === ROUTE + "/pet/start") {
			visible = true;
			startHelper();
			return sendJson(res, 200, petState());
		}
		if (p === ROUTE + "/pet/stop") {
			visible = false;
			stopHelper();
			return sendJson(res, 200, petState());
		}
		if (p === ROUTE + "/banter") {
			return sendJson(res, 200, { normal: [], before: [], path: "(smoke 内置默认)" });
		}
		if (p.startsWith(ROUTE + "/assets/")) {
			const file = path.join(ROOT, "assets", decodeURIComponent(p.slice((ROUTE + "/assets/").length)));
			if (!file.startsWith(path.join(ROOT, "assets") + path.sep) || !existsSync(file)) return sendJson(res, 404, { error: "not-found" });
			res.writeHead(200, { "cache-control": "no-store" });
			return res.end(readFileSync(file));
		}
		sendJson(res, 404, { error: "not-found" });
	} catch (e) {
		sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
	}
});

function startHelper() {
	if (child) return;
	const electron = resolveElectron();
	if (!electron) {
		console.error("[host] 找不到 Electron，先装一个到 ~/.dsh/electron");
		return;
	}
	const port = server.address().port;
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_NO_ATTACH_CONSOLE;
	env.DSH_STAR_PET_BASE = "http://127.0.0.1:" + port + ROUTE;
	env.DSH_STAR_PET_TOKEN = "smoke";
	env.DSH_STAR_PET_DEBUG = "1";
	// 注意：Windows 沙箱下不能给子进程开管道（stdio: "pipe" 会 EPERM），
	// 所以这里用 inherit，让 helper 的输出直接落到当前终端。
	child = spawn(electron, [HELPER], { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
	child.on("exit", (code) => {
		console.log("[host] helper exit", code);
		child = null;
	});
}

function stopHelper() {
	if (!child) return;
	const c = child;
	child = null;
	c.kill();
}

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	console.log("[host] listening on", port, "scenario =", scenario);
	startHelper();

	if (shotAt) {
		setTimeout(async () => {
			// 用 Electron 自带能力截图不方便，这里改成让主进程自己截：
			// 通过 DEBUG 日志确认窗口起来了，再让外部调用 capturePage。
			console.log("[host] helper log tail:\n" + helperLog.slice(-20).join("\n"));
			console.log("[host] 截图请用 DSH_STAR_PET_SHOT=" + shotAt + " 走 main.js 内建钩子，或手工截屏。");
			stopHelper();
			server.close();
			process.exit(0);
		}, 12000);
	}
});

process.on("SIGINT", () => {
	stopHelper();
	server.close();
	process.exit(0);
});
