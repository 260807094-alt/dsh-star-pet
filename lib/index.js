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
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { get as httpGet } from "node:https";
import { rmSync } from "node:fs";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const name = "star-pet";
const inject = ["webServer"];

const ROUTE_PREFIX = "/dsh-star-pet";
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HELPER_MAIN = join(PACKAGE_ROOT, "runtime", "helper", "main.js");
const ASSETS_ROOT = join(PACKAGE_ROOT, "assets");

export const DEFAULT_CONFIG = {
	monthly_wage: 10000,
	daily_wage: null,
	pay_days_per_month: 21.75,
	work_start: "09:00",
	work_end: "17:00",
	lunch_start: "11:30",
	lunch_minutes: 90,
	work_weekdays: [1, 2, 3, 4, 5],
	holidays: [],
	extra_workdays: [],
	hide_on_rest_day: false,
	pet_size_index: 1,
	snap_enabled: true,
	snap_px: 28,
	snap_sides: ["left", "right", "top", "bottom"],
	flip_on_left: true,
	sound: true,
	soft_font: true,
	show_chip: false,
	roll_numbers: true,
	show_banter: true,
	banter_every_sec: 30,
	banter_mode: "workday",
	show_float: true,
	float_every_sec: 5,
	// ── 加班（默认关闭）：加班是**独立时段**，不接下班时间
	// 加班日和上班日一样，一周七天自己勾（1=周一 … 7=周日）
	overtime_enabled: false,
	overtime_weekdays: [1, 2, 3, 4, 5],
	// 加班时段：正常上班日走「工作日」那一对，非上班日（周末/节假日）走另一对
	overtime_start_workday: "19:00",
	overtime_end_workday: "21:00",
	overtime_start_weekend: "09:00",
	overtime_end_weekend: "17:00",
	// 加班 ×倍工资：工作日 / 周末 / 节假日 三行各自独立，取值 0 / 1.5 / 2 / 3
	overtime_rate_workday: "1.5",
	overtime_rate_weekend: "2",
	overtime_rate_holiday: "3"
};

/** 加班倍率的合法取值（字符串形式，便于和设置页的按钮一一对应）。 */
export const OVERTIME_RATES = ["0", "1", "1.5", "2", "3"];
/** 三档加班倍率字段，顺序即设置页里的显示顺序。 */
export const OVERTIME_RATE_KEYS = ["overtime_rate_workday", "overtime_rate_weekend", "overtime_rate_holiday"];

/** 只允许改的键，防止前端塞进任意字段。 */
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

let helper = null;
let disposed = false;
let token = randomBytes(12).toString("hex");
let lastError = "";
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

function sanitizePatch(patch) {
	const out = {};
	if (!patch || typeof patch !== "object") return out;
	for (const key of CONFIG_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
		out[key] = patch[key];
	}
	if (out.monthly_wage != null) out.monthly_wage = Math.max(0, Number(out.monthly_wage) || 0);
	if (out.daily_wage != null && out.daily_wage !== "") out.daily_wage = Math.max(0, Number(out.daily_wage) || 0);
	else if (out.daily_wage === "") out.daily_wage = null;
	// 月计薪天数最小 1（分母，0 或负数会让日薪爆炸或变负）。
	// 只有「不是数字」或「空串」才回退默认 21.75；数字一律夹到 1~30，
	// 与设置窗/渲染端的判定保持一致（三处都是「1~30 才采用，否则 21.75」）。
	// 上限 30：一个月最多 30 天，30 = 全月不扣周末算薪。
	if (out.pay_days_per_month != null) {
		const raw = typeof out.pay_days_per_month === "string" ? out.pay_days_per_month.trim() : out.pay_days_per_month;
		const n = raw === "" ? NaN : Number(raw);
		out.pay_days_per_month = Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 21.75;
	}
	if (out.lunch_minutes != null) out.lunch_minutes = Math.max(0, Math.min(300, Math.round(Number(out.lunch_minutes) || 0)));
	if (out.pet_size_index != null) out.pet_size_index = Math.max(0, Math.min(2, Math.round(Number(out.pet_size_index) || 0)));
	// 数字滚动：已从设置页移除，恒定开启（历史配置里可能存着 false，这里强制拉回）。
	out.roll_numbers = true;
	if (out.banter_every_sec != null) out.banter_every_sec = Math.max(5, Math.min(120, Math.round(Number(out.banter_every_sec) || 30)));
	if (out.banter_mode != null) out.banter_mode = out.banter_mode === "allday" ? "allday" : "workday";
	if (out.snap_px != null) out.snap_px = Math.max(0, Math.min(200, Math.round(Number(out.snap_px) || 0)));
	if (out.work_weekdays != null) {
		const days = Array.from(new Set((Array.isArray(out.work_weekdays) ? out.work_weekdays : [])
			.map((d) => Math.round(Number(d)))
			.filter((d) => d >= 1 && d <= 7))).sort((a, b) => a - b);
		out.work_weekdays = days.length ? days : [1, 2, 3, 4, 5];
	}
	if (out.overtime_weekdays != null) {
		const days = Array.from(new Set((Array.isArray(out.overtime_weekdays) ? out.overtime_weekdays : [])
			.map((d) => Math.round(Number(d)))
			.filter((d) => d >= 1 && d <= 7))).sort((a, b) => a - b);
		out.overtime_weekdays = days.length ? days : DEFAULT_CONFIG.overtime_weekdays.slice();
	}
	for (const key of OVERTIME_RATE_KEYS) {
		if (out[key] == null) continue;
		const rate = String(out[key]);
		out[key] = OVERTIME_RATES.includes(rate) ? rate : DEFAULT_CONFIG[key];
	}
	for (const key of ["overtime_start_workday", "overtime_end_workday", "overtime_start_weekend", "overtime_end_weekend"]) {
		if (out[key] == null) continue;
		const text = String(out[key]).trim();
		out[key] = /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : DEFAULT_CONFIG[key];
	}
	// 上下班/午休开始也是时间，同样要拒绝非法格式，否则 API 直连塞个 "abc" 会进配置。
	for (const key of ["work_start", "work_end", "lunch_start"]) {
		if (out[key] == null) continue;
		const text = String(out[key]).trim();
		out[key] = /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : DEFAULT_CONFIG[key];
	}
	return out;
}

function readStore() {
	const file = configFile();
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return {
			config: { ...DEFAULT_CONFIG, ...sanitizePatch(raw && raw.config) },
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

function saveConfig(patch) {
	const store = readStore();
	store.config = { ...store.config, ...sanitizePatch(patch) };
	writeStore(store);
	return store.config;
}

/** 吐槽语句文件：用户直接编辑，升级/重装不覆盖。 */
function banterFile() {
	return join(configDir(), "banter.txt");
}

const BANTER_DEFAULT_NORMAL = [
	"歇一会吧", "天塌了...", "再睡五分钟...", "啊？我吗？",
	"好焦虑...怎么办", "人就不能躺一辈子吗...", "我精神好得很！", "休息一会...睡了",
	"好虚...好累", "那咋了", "然后呢，我能咋办", "biubiu你~",
	"虽然什么都没干，但还是辛苦我了", "要不问问AI？", "我最棒！", "记得喝水！",
];
const BANTER_DEFAULT_BEFORE = [
	"明天的事交给明天的自己去处理吧！", "事已至此，先吃饭吧！",
	"等会下班吃什么？", "今晚去哪玩？", "突然不困了~",
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

/** 时间 "HH:MM" → 分钟；非法/空回退到 d（与 renderer/settings 的 parse 一致）。 */
function timeOf(s, d) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
	return m ? Math.min(1439, Number(m[1]) * 60 + Number(m[2])) : d;
}

/** 服务端硬校验：防住绕过设置页的直连 POST 塞进自相矛盾的时间。
 *  设置页已经在前端拦了同一套规则，这里是最后一道防线。 */
function validateConfig(cfg) {
	// 完整时间链（无论加班开关开或关都校验，与 settings.js save() 完全一致）：
	//   00:00 ≤ 上班 ≤ 午休开始 ≤ 午休结束 ≤ 下班 ≤ 上班日加班开始 < 加班结束 ≤ 23:59（且加班开始 ≥ 17:00）
	//   非上班日：05:00 ≤ 加班开始 < 加班结束 ≤ 23:59
	const ws = timeOf(cfg.work_start, 540);
	const we = timeOf(cfg.work_end, 1020);
	const ls = timeOf(cfg.lunch_start, 690);
	const lm = Math.max(0, Math.min(300, Math.round(Number(cfg.lunch_minutes) || 0)));
	const le = ls + lm;
	if (we <= ws) return "下班时间必须晚于上班时间。";
	if (ls < ws) return "午休开始不能早于上班时间。";
	if (le > we) return "午休结束（午休开始 + 午休时长）不能晚于下班时间。";
	const otWS = timeOf(cfg.overtime_start_workday, 1140);
	const otWE = timeOf(cfg.overtime_end_workday, 1260);
	if (otWS < 1020) return "上班日加班开始不能早于 17:00。";
	if (otWS < we) return "上班日加班开始必须晚于下班时间。";
	if (otWE <= otWS) return "上班日加班结束必须晚于开始。";
	const otRS = timeOf(cfg.overtime_start_weekend, 540);
	const otRE = timeOf(cfg.overtime_end_weekend, 1020);
	if (otRS < 300) return "非上班日加班开始不能早于 05:00。";
	if (otRE <= otRS) return "非上班日加班结束必须晚于开始。";
	return null;
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
	const arch = process.arch === "darwin" ? (process.arch === "arm64" ? "arm64" : "x64") : process.arch === "arm64" ? "arm64" : "x64";
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
					rejectPromise(new Error(`HTTP ${status}`));
					return;
				}
				const total = Number(res.headers["content-length"] || 0);
				let got = 0;
				const out = createWriteStream(dest);
				res.on("data", (chunk) => {
					got += chunk.length;
					if (total > 0 && onProgress) onProgress(Math.min(99, Math.round((got / total) * 100)));
				});
				res.pipe(out);
				out.on("finish", () => out.close(() => resolvePromise(dest)));
				out.on("error", rejectPromise);
				res.on("error", rejectPromise);
			});
			req.on("error", rejectPromise);
			req.setTimeout(60000, () => req.destroy(new Error("连接超时")));
		};
		go(url, 5);
	});
}

function extractZip(zip, into) {
	if (process.platform === "win32") {
		const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
			`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${into}' -Force`], { windowsHide: true });
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
		helper = spawn(electron, [HELPER_MAIN], {
			cwd: PACKAGE_ROOT,
			env: helperEnv(base, token),
			stdio: ["ignore", "ignore", "ignore"],
			windowsHide: true,
			detached: false
		});
		helper.on("exit", (code) => {
			if (code && code !== 0) lastError = "helper 退出码 " + code;
			helper = null;
		});
		helper.on("error", (e) => {
			lastError = e instanceof Error ? e.message : String(e);
			helper = null;
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
		try { helper.kill(); } catch {}
		helper = null;
	}
	visible = false;
	return petState();
}

function sendJson(res, status, obj) {
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

function readBody(req) {
	return new Promise((done) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > 64 * 1024) {
				req.destroy();
				done(null);
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (!text) return done({});
			try {
				done(JSON.parse(text));
			} catch {
				done(null);
			}
		});
		req.on("error", () => done(null));
	});
}

function serveAsset(urlPath, res) {
	const rel = decodeURIComponent(urlPath.slice(ROUTE_PREFIX.length + "/assets/".length));
	const target = normalize(join(ASSETS_ROOT, rel));
	if (!target.startsWith(ASSETS_ROOT + sep) && target !== ASSETS_ROOT) {
		sendJson(res, 404, { error: "not-found" });
		return;
	}
	if (!existsSync(target) || !statSync(target).isFile()) {
		sendJson(res, 404, { error: "not-found" });
		return;
	}
	const stat = statSync(target);
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
						const patch = await readBody(req);
						if (!patch) {
							sendJson(res, 400, { error: "配置不是合法 JSON" });
							return;
						}
						const pending = { ...readStore().config, ...sanitizePatch(patch) };
						const verr = validateConfig(pending);
						if (verr) {
							sendJson(res, 400, { error: verr });
							return;
						}
						const config = saveConfig(patch);
						// 设置改了以后让 helper 立即重读配置
						if (helper && helper.connected) {
							try { helper.send?.({ type: "reload" }); } catch {}
						}
						sendJson(res, 200, { config });
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
					const win = await readBody(req);
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
					const body = method === "POST" ? await readBody(req) : null;
					setVisible(!(body && body.visible === false));
					sendJson(res, 200, petState());
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
				// 侧栏图标点一下开、再点一下关（常驻进程只切显隐）
				if (p === ROUTE_PREFIX + "/pet/electron") {
					if (req.method !== "POST") {
						sendJson(res, 405, { error: "method-not-allowed" });
						return;
					}
					lastError = "正在重新准备 Electron…";
					ensureElectron().then((found) => {
						if (found && !disposed && !isRunning()) start();
					}).catch((e) => {
						lastError = e instanceof Error ? e.message : String(e);
					});
					sendJson(res, 200, { ok: true, installing: true });
					return;
				}
				if (p === ROUTE_PREFIX + "/pet/toggle") {
					sendJson(res, 200, setVisible(!(isRunning() && visible)));
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
