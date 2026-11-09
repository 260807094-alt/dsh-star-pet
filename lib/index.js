/**
 * dsh-star-pet 宿主侧（host）。
 *
 * 职责：
 *   1. 用 `webServer` 暴露 /dsh-star-pet 路由：配置读写、窗口位置记忆、皮肤/字体素材。
 *   2. 用 `spawn` 拉起 Electron helper（`runtime/helper/main.js`）——桌宠的"盖住任何程序"
 *      只能靠一个真正的透明置顶窗口，纯页面浮层做不到（与 dsh-pet 同机制）。
 *   3. 配置落在用户目录（`%APPDATA%\dsh-star-pet\config.json`），不写包内，
 *      所以升级/重装插件不会覆盖用户设置。
 *   4. 插件被禁用或卸载时杀掉 helper 进程，不留孤儿。
 *
 * Electron 解析顺序（第一处命中即用）：
 *   1. DSH_STAR_PET_ELECTRON_PATH —— 显式指定的 electron 可执行文件；
 *   2. $DSH_HOME/electron/electron.exe（默认 ~/.dsh/electron，与 dsh-pet 共用同一份）；
 *   3. 找不到就只在状态里报错，不影响 DSH 本体。
 */
import { spawn } from "node:child_process";
import { get as httpGet } from "node:https";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
// 共享核心：默认配置、净化、校验只有那一份实现，与渲染端/设置页同源。
// （runtime/helper/package.json 是 commonjs，所以这里拿到的是 module.exports。）
import Core from "../runtime/helper/core.js";

const name = "star-pet";
const inject = ["webServer"];

const ROUTE_PREFIX = "/dsh-star-pet";
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HELPER_MAIN = join(PACKAGE_ROOT, "runtime", "helper", "main.js");
const ASSETS_ROOT = join(PACKAGE_ROOT, "assets");

/** 默认配置。**唯一定义处是 runtime/helper/core.js**，这里只是转出去给外部用。 */
export const DEFAULT_CONFIG = Core.DEFAULT_CONFIG;
export const OVERTIME_RATES = Core.OVERTIME_RATES;
export const OVERTIME_RATE_KEYS = Core.OVERTIME_RATE_KEYS;

/** 只允许改的键，防止前端塞进任意字段。 */
const CONFIG_KEYS = Core.CONFIG_KEYS;

let helper = null;
let disposed = false;
let token = randomBytes(12).toString("hex");
let lastError = "";
/** helper 的 stderr 尾巴：Electron 起不来时唯一能看到的线索。 */
let helperLog = [];
/** 宠物窗口是否显示中（进程可以常驻，显隐只是 show/hide，切换才是秒开）。 */
let visible = true;

function configDir() {
	if (process.env.DSH_STAR_PET_CONFIG_DIR) return process.env.DSH_STAR_PET_CONFIG_DIR;
	const base =
		process.env.APPDATA ||
		(process.platform === "darwin"
			? join(homedir(), "Library", "Application Support")
			: process.env.XDG_CONFIG_HOME || join(homedir(), ".config"));
	return join(base, "dsh-star-pet");
}

function configFile() {
	return join(configDir(), "config.json");
}

/** 键名白名单 + 值域夹取 + 非法时间回落默认，全部在 core 里做。 */
function sanitizePatch(patch) {
	return Core.sanitizePatch(patch);
}

function readStore() {
	const file = configFile();
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return {
			config: { ...DEFAULT_CONFIG, ...Core.sanitizePatch(raw && raw.config) },
			window: raw && raw.window && typeof raw.window === "object" ? raw.window : null
		};
	} catch {
		return { config: { ...DEFAULT_CONFIG }, window: null };
	}
}

function writeStore(store) {
	const file = configFile();
	mkdirSync(dirname(file), { recursive: true });
	const body = JSON.stringify({ version: 1, config: store.config, window: store.window || null }, null, "\t");
	writeFileSync(file, body, "utf8");
	return file;
}

/** 吐槽语句文件：用户直接编辑，升级/重装不覆盖。 */
function banterFile() {
	return join(configDir(), "banter.txt");
}

const BANTER_DEFAULT_NORMAL = [
	"歇一会吧...",
	"天塌了...",
	"再睡五分钟...",
	"啊？我吗？",
	"好焦虑...怎么又饿了...",
	"人就不能躺一辈子吗...",
	"我精神好得很！",
	"休息一会...睡了",
	"好虚...好累",
	"那咋了",
	"然后呢，我能咋整？",
	"biubiu你~",
	"虽然什么都没干，但还是辛苦我了！",
	"要不问问AI？",
	"我最棒！",
	"记得喝水！",
	"开机就算上岗！",
	"先坐着，别急...",
	"我在思考人生...",
	"一会儿就干~",
	"这活儿不急！",
	"才几点就困了...",
	"怎么又饿了...",
	"该吃点啥呢？",
	"记得喝水!",
	"摸鱼不犯法！",
	"我这是劳逸结合~",
	"值得一杯奶茶~",
	"我真是太努力啦~",
	"这得问领导...",
	"领导会不会也在摸鱼？",
	"再撑一会儿....",
	"饿着没法干活！",
	"活着就行..."
];
const BANTER_DEFAULT_BEFORE = [
	"明天的事交给明天的自己去处理吧！",
	"事已至此，先吃饭吧！",
	"等会下班吃什么？",
	"今晚去哪玩？",
	"突然不困了~",
	"明天一定干！",
	"反正也干不完...",
	"还有多久下班呢？",
	"到点就跑！",
	"有人约吗？",
	"毁灭吧，准备下班！",
	"麦当劳还是肯德基？",
	"把事搞黄了吗？",
	"记得上厕所，准备下班啦",
	"领导求你这会别来找我！",
	"准备关机！",
	"手机充满电了吗？"
];

function banterDefaultText() {
	return [
		"# dsh-star-pet 吐槽语句：每行一句，空行和 # 开头忽略",
		"# 「---」上面是日常吐槽，下面是「下班前」专用（距下班/加班结束 60 分钟内随机出）",
		"# 直接改这个文件，保存后约 30 秒内生效；想加句子就在对应段落里另起一行。",
		...BANTER_DEFAULT_NORMAL,
		"---",
		...BANTER_DEFAULT_BEFORE,
	].join("\r\n") + "\r\n";
}

/** 首次生成默认文件；文件存在则原样保留（用户可能已经改过）。 */
function ensureBanterFile() {
	const file = banterFile();
	if (!existsSync(file)) {
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, banterDefaultText(), "utf8");
		} catch {}
	}
	return file;
}

function readBanter() {
	const file = ensureBanterFile();
	try {
		const lines = readFileSync(file, "utf8").split(/\r?\n/);
		let section = 0;
		const n = [];
		const b = [];
		for (const raw of lines) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			if (line === "---") { section = 1; continue; }
			(section === 0 ? n : b).push(line);
		}
		return {
			normal: n.length ? n : BANTER_DEFAULT_NORMAL.slice(),
			before: b
		};
	} catch {
		return { normal: BANTER_DEFAULT_NORMAL.slice(), before: BANTER_DEFAULT_BEFORE.slice() };
	}
}

/** 服务端硬校验：防住绕过设置页的直连 POST 塞进自相矛盾的时间。
 *  规则只有 core.validateConfig 一份，设置页 `save()` 调的是同一个函数。 */
function validateConfig(cfg) {
	return Core.validateConfig(cfg);
}

function saveWindow(win) {
	const store = readStore();
	store.window = {
		x: Math.round(Number(win && win.x) || 0),
		y: Math.round(Number(win && win.y) || 0),
		side: typeof (win && win.side) === "string" ? win.side : ""
	};
	writeStore(store);
	return store.window;
}

function resolveElectron() {
	const candidates = [];
	if (process.env.DSH_STAR_PET_ELECTRON_PATH) candidates.push(process.env.DSH_STAR_PET_ELECTRON_PATH);
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	const exeName = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
	candidates.push(join(home, "electron", exeName));
	candidates.push(join(homedir(), ".dsh", "electron", exeName));
	for (const c of candidates) {
		if (c && existsSync(c)) return c;
	}
	return null;
}

/* ------------------------------------------------------------------ *
 * Electron 首次下载
 *
 * 桌宠必须跑在真正的 Electron 里（透明置顶窗口）。用户机器上不一定有，
 * 所以第一次启动时按官方缓存目录 `~/.dsh/electron` 自取一份：
 *   - 优先 npmmirror 镜像（国内直连 github release 经常失败）；
 *   - 解压用系统自带工具（PowerShell Expand-Archive / unzip），不引入依赖；
 *   - 失败时把原因写进 state.error，面板与设置页都能看到。
 * ------------------------------------------------------------------ */
const ELECTRON_VERSION = "43.3.0";
let electronInstall = null;

function electronZipName() {
	// （原来这里写的是 `process.arch === "darwin"`，拿架构名跟平台名比，永远为假。）
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (process.platform === "win32") return `electron-v${ELECTRON_VERSION}-win32-${arch}.zip`;
	if (process.platform === "darwin") return `electron-v${ELECTRON_VERSION}-darwin-${arch}.zip`;
	return `electron-v${ELECTRON_VERSION}-linux-${arch}.zip`;
}

function electronZipUrls() {
	const zip = electronZipName();
	return [
		`https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/${zip}`,
		`https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${zip}`
	];
}

function fetchToFile(url, dest, onProgress) {
	return new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		const fail = (err) => {
			if (settled) return;
			settled = true;
			// 半成品必须清掉：否则下次会拿着一个截断的 zip 去解压，报错信息还看不出原因。
			try { rmSync(dest, { force: true }); } catch {}
			rejectPromise(err);
		};
		const succeed = () => {
			if (settled) return;
			settled = true;
			resolvePromise(dest);
		};
		const go = (u, hops) => {
			const req = httpGet(u, { headers: { "user-agent": "dsh-star-pet" } }, (res) => {
				const status = res.statusCode || 0;
				if (status >= 300 && status < 400 && res.headers.location && hops > 0) {
					res.resume();
					go(new URL(res.headers.location, u).toString(), hops - 1);
					return;
				}
				if (status !== 200) {
					res.resume();
					fail(new Error(`HTTP ${status}`));
					return;
				}
				const total = Number(res.headers["content-length"] || 0);
				let got = 0;
				const out = createWriteStream(dest);
				out.on("error", fail);
				res.on("error", fail);
				res.on("aborted", () => fail(new Error("下载中断")));
				res.on("data", (chunk) => {
					got += chunk.length;
					if (total > 0 && onProgress) onProgress(Math.min(99, Math.round((got / total) * 100)));
				});
				res.pipe(out);
				out.on("finish", () => {
					out.close(() => {
						// content-length 对得上才算完整；对不上说明连接中途断了。
						if (total > 0 && got !== total) fail(new Error(`下载不完整（${got}/${total} 字节）`));
						else succeed();
					});
				});
			});
			req.on("error", fail);
			req.setTimeout(60000, () => req.destroy(new Error("连接超时")));
		};
		go(url, 5);
	});
}

function psQuote(text) {
	// PowerShell 单引号字符串里，单引号本身用两个单引号转义。
	return "'" + String(text).replace(/'/g, "''") + "'";
}

function extractZip(zip, into) {
	if (process.platform === "win32") {
		const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
			`Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(into)} -Force`], { windowsHide: true });
		if (r.status !== 0) throw new Error("解压失败：" + String(r.stderr || "").slice(0, 200));
		return;
	}
	const r = spawnSync("unzip", ["-q", "-o", zip, "-d", into]);
	if (r.status !== 0) throw new Error("解压失败：" + String(r.stderr || "").slice(0, 200));
}

/** 把解压出来的那一层目录里的内容搬到 ~/.dsh/electron。 */
function moveIntoPlace(root, target) {
	const exeName = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app" : "electron";
	let src = root;
	if (!existsSync(join(src, exeName))) {
		const found = readdirSyncSafe(root).find((d) => existsSync(join(root, d, exeName)));
		if (found) src = join(root, found);
	}
	if (!existsSync(join(src, exeName))) throw new Error("解压结果里找不到 " + exeName);
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSyncSafe(src)) {
		// 下载的 zip 就放在同一个临时目录里，不能跟着一起搬进安装目录（100 MB 白占）。
		if (/\.zip$/i.test(entry)) continue;
		const from = join(src, entry);
		const to = join(target, entry);
		try { mvSync(from, to); } catch (e) { /* 已存在的同版本文件忽略 */ }
	}
}

function readdirSyncSafe(dir) {
	try { return readdirSync(dir); } catch (e) { return []; }
}
function mvSync(from, to) {
	if (existsSync(to)) rmSync(to, { recursive: true, force: true });
	renameSync(from, to);
}

function ensureElectron() {
	if (resolveElectron()) return Promise.resolve(resolveElectron());
	if (electronInstall) return electronInstall;
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	const target = join(home, "electron");
	const tmpDir = join(home, ".star-pet-download");
	const zip = join(tmpDir, electronZipName());
	const urls = electronZipUrls();
	electronInstall = (async () => {
		mkdirSync(tmpDir, { recursive: true });
		let lastErr = "";
		for (const url of urls) {
			try {
				lastError = "正在下载 Electron " + ELECTRON_VERSION + "… 0%";
				await fetchToFile(url, zip, (pct) => { lastError = "正在下载 Electron " + ELECTRON_VERSION + "… " + pct + "%"; });
				lastError = "正在解压 Electron…";
				extractZip(zip, tmpDir);
				lastError = "正在安装 Electron…";
				moveIntoPlace(tmpDir, target);
				lastError = "";
				const found = resolveElectron();
				if (!found) throw new Error("安装后仍找不到 electron");
				return found;
			} catch (e) {
				lastErr = e instanceof Error ? e.message : String(e);
			}
		}
		lastError = "下载 Electron 失败（" + lastErr + "）。可手动下载 electron-v" + ELECTRON_VERSION + " 解压到 " + target + "，或用 DSH_STAR_PET_ELECTRON_PATH 指定。";
		return null;
	})().finally(() => { electronInstall = null; });
	return electronInstall;
}

function isRunning() {
	return helper !== null && helper.exitCode === null && helper.killed === false;
}

function helperEnv(base, tok) {
	const env = { ...process.env };
	// DSH 桌面端自己以 ELECTRON_RUN_AS_NODE 运行；子进程必须去掉，否则不开窗。
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_NO_ATTACH_CONSOLE;
	env.DSH_STAR_PET_BASE = base;
	env.DSH_STAR_PET_TOKEN = tok;
	return env;
}

function petState() {
	return { running: isRunning(), visible: isRunning() && visible, error: lastError, electron: resolveElectron(), installing: Boolean(electronInstall) };
}

/** 只切显隐，不启停进程：与 dsh-pet 一样常驻，点击零延迟。 */
function setVisible(next) {
	visible = next === true;
	if (visible && !isRunning()) start();
	return petState();
}

function start() {
	if (disposed) return { running: false, visible: false, error: "插件已卸载" };
	if (isRunning()) return petState();
	const port = typeof globalThis.__starPetPort === "number" ? globalThis.__starPetPort : 0;
	if (!port) return { running: false, error: "本地服务端口尚未就绪" };
	const electron = resolveElectron();
	if (!electron) {
		// 首次使用：后台下载一份 Electron 到 ~/.dsh/electron，进度写进 lastError
		if (!electronInstall) {
			lastError = "尚未安装 Electron，正在准备下载（约 100 MB，只需一次）…";
		}
		ensureElectron().then((found) => {
			if (found) {
				lastError = "";
				if (!disposed && !isRunning()) start();
			}
		}).catch((e) => {
			lastError = e instanceof Error ? e.message : String(e);
		});
		return { running: false, visible: false, error: lastError, electron: null, installing: true };
	}
	if (!existsSync(HELPER_MAIN)) {
		lastError = "缺少 runtime/helper/main.js";
		return { running: false, error: lastError, electron };
	}
	try {
		token = randomBytes(12).toString("hex");
		// helper 里用 "/config"、"/window" 这样的相对路径，因此 BASE 必须带上路由前缀
		const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`;
		// stdout/stderr 必须接住：Electron 起不来时（缺 dll、被安全软件拦、userData 权限）
		// 它只会往 stderr 打一行，接了才有得查；不接等于把所有故障信息丢掉。
		const child = spawn(electron, [HELPER_MAIN], {
			cwd: PACKAGE_ROOT,
			env: helperEnv(base, token),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: false
		});
		const collect = (stream, tag) => {
			if (!stream) return;
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => {
				for (const line of String(chunk).split(/\r?\n/)) {
					const text = line.trim();
					if (!text) continue;
					helperLog.push(`[${tag}] ${text}`);
				}
				if (helperLog.length > 80) helperLog = helperLog.slice(-80);
			});
		};
		collect(child.stdout, "out");
		collect(child.stderr, "err");
		child.starPetUserStopped = false;
		helper = child;
		// 关键：回调里不能无脑 `helper = null`。杀掉旧进程后它的 exit 事件是**稍后**才到的，
		// 那时 helper 可能已经指向新进程；无脑清空会让新进程失去引用（孤儿窗口 + 再也停不掉）。
		child.on("exit", (code, signal) => {
			// 用户主动 stop() 时也会走到这里，但那不是故障，不能写进 error 让用户看到。
			if (!child.starPetUserStopped && code && code !== 0) {
				lastError = "helper 退出码 " + code + (signal ? " (" + signal + ")" : "") + (helperLog.length ? "｜" + helperLog.slice(-3).join(" / ") : "");
			}
			if (helper === child) helper = null;
		});
		child.on("error", (e) => {
			lastError = e instanceof Error ? e.message : String(e);
			if (helper === child) helper = null;
		});
		lastError = "";
		visible = true;
		return petState();
	} catch (e) {
		lastError = e instanceof Error ? e.message : String(e);
		helper = null;
		return { running: false, error: lastError, electron };
	}
}

function stop() {
	if (helper) {
		const child = helper;
		// 标记在进程对象上而不是模块变量上：这样即使紧接着又 start() 了新进程，
		// 旧进程迟到的 exit 也不会被误记成故障。
		child.starPetUserStopped = true;
		if (helper === child) helper = null;
		try { child.kill(); } catch {}
	}
	visible = false;
	return petState();
}

function sendJson(res, status, obj) {
	// readBody 可能已经自己回过 413/400；这里兜一道，避免「响应已结束后又写一次」的崩溃。
	if (!res || res.writableEnded || res.headersSent) return;
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": body.length,
		"cache-control": "no-store"
	});
	res.end(body);
}

const MIME = {
	".webp": "image/webp",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ttf": "font/ttf",
	".wav": "audio/wav",
	".json": "application/json; charset=utf-8"
};

function readBody(req, res) {
	return new Promise((done) => {
		const chunks = [];
		let size = 0;
		let failed = false;
		// 已经由这里回过响应的场合，调用方不该再写一次（res.__bodyRejected 由调用方检查）。
		const fail = (status, error) => {
			if (failed) return;
			failed = true;
			// 超限时**不能** destroy socket：那样客户端只会看到连接被重置，拿不到错误原因。
			if (res) res.__bodyRejected = true;
			try {
				if (!res.headersSent) sendJson(res, status, { error });
			} catch {}
			req.resume();
			done(null);
		};
		req.on("data", (c) => {
			if (failed) return;
			size += c.length;
			if (size > 64 * 1024) {
				fail(413, "请求体超过 64KB");
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (failed) return;
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (!text) return done({});
			try {
				done(JSON.parse(text));
			} catch {
				if (!failed) {
					failed = true;
					if (res) res.__bodyRejected = true;
					try {
						if (!res.headersSent) sendJson(res, 400, { error: "不是合法 JSON" });
					} catch {}
					done(null);
				}
			}
		});
		req.on("error", () => {
			if (failed) return;
			failed = true;
			done(null);
		});
	});
}

function serveAsset(urlPath, res) {
	// decodeURIComponent 遇到畸形百分号编码会抛 URIError；这里必须自己接住，
	// 否则一条 /assets/%E0 就能让整条路由进 catch 变成 500。
	let rel = "";
	try {
		rel = decodeURIComponent(urlPath.slice(ROUTE_PREFIX.length + "/assets/".length));
	} catch {
		sendJson(res, 400, { error: "bad-path" });
		return;
	}
	const target = normalize(join(ASSETS_ROOT, rel));
	if (!target.startsWith(ASSETS_ROOT + sep) && target !== ASSETS_ROOT) {
		sendJson(res, 404, { error: "not-found" });
		return;
	}
	let stat = null;
	try {
		stat = statSync(target);
	} catch {
		sendJson(res, 404, { error: "not-found" });
		return;
	}
	if (!stat.isFile()) {
		sendJson(res, 404, { error: "not-found" });
		return;
	}
	res.writeHead(200, {
		"content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
		"content-length": stat.size,
		"cache-control": "public, max-age=3600"
	});
	createReadStream(target).pipe(res);
}

function apply(ctx) {
	const port = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 0;
	globalThis.__starPetPort = port;

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			try {
				const url = new URL(req.url ?? "/", "http://x");
				const p = url.pathname;
				const method = (req.method || "GET").toUpperCase();

				if (p.startsWith(ROUTE_PREFIX + "/assets/")) {
					serveAsset(p, res);
					return;
				}
				if (p === ROUTE_PREFIX + "/config") {
					if (method === "GET") {
						const store = readStore();
						sendJson(res, 200, {
							config: store.config,
							window: store.window,
							configPath: configFile(),
							defaults: DEFAULT_CONFIG,
							pet: { running: isRunning(), error: lastError, electron: resolveElectron() }
						});
						return;
					}
					if (method === "POST") {
						const patch = await readBody(req, res);
						if (!patch) {
							sendJson(res, 400, { error: "配置不是合法 JSON" });
							return;
						}
						// 只读一次磁盘：校验和保存用的是同一份 pending 快照，
						// 避免两次 readStore 之间被别的请求插进中间态。
						const store = readStore();
						const pending = { ...store.config, ...sanitizePatch(patch) };
						const verr = validateConfig(pending);
						if (verr) {
							sendJson(res, 400, { error: verr });
							return;
						}
						store.config = pending;
						writeStore(store);
						// 配置变化不需要通知 helper：渲染端每秒轮询一次 /config（CONFIG_POLL_MS）会自己拿到新版。
						sendJson(res, 200, { config: pending });
						return;
					}
					sendJson(res, 405, { error: "method-not-allowed" });
					return;
				}
				if (p === ROUTE_PREFIX + "/window") {
					if (method !== "POST") {
						sendJson(res, 405, { error: "method-not-allowed" });
						return;
					}
					const win = await readBody(req, res);
					if (!win) {
						sendJson(res, 400, { error: "窗口位置不是合法 JSON" });
						return;
					}
					sendJson(res, 200, { window: saveWindow(win) });
					return;
				}
				if (p === ROUTE_PREFIX + "/pet/state") {
					sendJson(res, 200, Object.assign(petState(), { port }));
					return;
				}
				if (p === ROUTE_PREFIX + "/pet/visible") {
					if (method === "GET") {
						sendJson(res, 200, petState());
						return;
					}
					const body = await readBody(req, res);
					// 必须显式给出 want；缺字段的 POST 不当成「显示」，否则一个笔误就把宠物叫回来。
					let want = null;
					if (body && typeof body.visible === "boolean") want = body.visible;
					else if (body && typeof body.show === "boolean") want = body.show;
					if (want === null) {
						sendJson(res, 400, { error: "缺少 visible 布尔值" });
						return;
					}
					sendJson(res, 200, setVisible(want));
					return;
				}
				if (p === ROUTE_PREFIX + "/pet/start") {
					sendJson(res, 200, start());
					return;
				}
				if (p === ROUTE_PREFIX + "/pet/stop") {
					sendJson(res, 200, stop());
					return;
				}
				// 重新准备 Electron：仅当真的没装时才下载，已装则直接启动。
				if (p === ROUTE_PREFIX + "/pet/electron") {
					if (method !== "POST") {
						sendJson(res, 405, { error: "method-not-allowed" });
						return;
					}
					const found = resolveElectron();
					if (found) {
						if (!isRunning() && !disposed) start();
						sendJson(res, 200, { ok: true, installing: false, electron: found });
						return;
					}
					lastError = "正在重新准备 Electron…";
					ensureElectron().then((p2) => {
						if (p2 && !disposed && !isRunning()) start();
					}).catch((e) => {
						lastError = e instanceof Error ? e.message : String(e);
					});
					sendJson(res, 200, { ok: true, installing: true, electron: null });
					return;
				}
				if (p === ROUTE_PREFIX + "/banter") {
					if (method !== "GET") {
						sendJson(res, 405, { error: "method-not-allowed" });
						return;
					}
					sendJson(res, 200, Object.assign(readBanter(), { path: banterFile() }));
					return;
				}
				sendJson(res, 404, { error: "not-found" });
			} catch (e) {
				sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
	}), "dsh-star-pet: /dsh-star-pet routes");

	// 随 DSH 启动就把 Electron 备好：不等用户点图标、也不等下面的 800ms。
	// 已经装过 dsh-pet 之类、~/.dsh/electron 里有货的机器，这一句是空操作。
	if (!resolveElectron()) {
		lastError = "正在准备 Electron " + ELECTRON_VERSION + "（首次需要下载约 100 MB，只需一次）…";
		ensureElectron()
			.then((p) => { if (p) lastError = ""; })
			.catch(() => {});
	}

	// 随 DSH 启动：稍等端口就绪再拉起 helper
	const timer = setTimeout(() => {
		if (!disposed) start();
	}, 800);
	timer.unref?.();

	ctx.on("dispose", () => {
		disposed = true;
		clearTimeout(timer);
		stop();
	});
}

export { apply, inject, name };
