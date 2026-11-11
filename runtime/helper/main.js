/*
 * dsh-star-pet · 桌面助手进程
 * ------------------------------------------------------------------
 * 一个透明的、置顶的、无边框窗口，承载「上班鼓励宠物」。
 * 与 dsh-pet 的 electron-helper 同构：
 *   transparent + alwaysOnTop('screen-saver') + skipTaskbar + 整窗点击穿透
 *   + 渲染端命中区切回可点。
 *
 * 本进程只做窗口/位置/命中/持久化，所有画面与计时在 renderer.js 里。
 */

const {
	app,
	BrowserWindow,
	ipcMain,
	screen,
	nativeImage,
} = require("electron");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
// 共享核心：尺寸表、默认配置、计薪口径都从 core 取，主进程不再自带副本。
const Core = require("./core.js");

// 独立的 userData：否则会与 dsh-pet 那个 helper 抢同一个 Electron 配置目录，
// requestSingleInstanceLock() 拿不到锁就直接退出了（表现为"启动了但没窗口"）。
const USER_DATA =
	process.env.DSH_STAR_PET_USER_DATA ||
	path.join(
		process.env.APPDATA || path.join(os.homedir(), ".config"),
		"dsh-star-pet",
		"electron"
	);
try {
	fs.mkdirSync(USER_DATA, { recursive: true });
} catch {}
app.setPath("userData", USER_DATA);

// Windows 上 Electron 是 GUI 子系统程序，console.log 不会回到终端；
// 设 DSH_STAR_PET_DEBUG=1 时把关键事件写到 userData/helper-debug.log。
const DEBUG = process.env.DSH_STAR_PET_DEBUG === "1";
function log(...args) {
	if (!DEBUG) return;
	try {
		fs.appendFileSync(
			path.join(USER_DATA, "helper-debug.log"),
			new Date().toISOString() + " " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n"
		);
	} catch {}
}
log("boot argv=", process.argv.slice(1).join(" "), "userData=", USER_DATA);

/* ------------------------------------------------------------------ *
 * 截图钩子（仅调试用）
 *
 * 正常运行时一个字节都不执行。设了环境变量才生效：
 *   DSH_STAR_PET_SHOT=<png>            桌宠窗口
 *   DSH_STAR_PET_SHOT_DELAY=ms         等多久再抓（默认 1800）
 *   DSH_STAR_PET_SHOT_EXPAND=1         抓之前先合成一次点击，让看板展开
 *   DSH_STAR_PET_SHOT_SETTINGS=<png>   设置窗口
 *   DSH_STAR_PET_SHOT_EXIT=1           抓完退出进程
 * 用途：没有 DSH 宿主时（CI、远程排查、冒烟脚本）验证界面长什么样。
 */
async function capture(win, out, before) {
	try {
		if (before) await before();
		const img = await win.webContents.capturePage();
		fs.writeFileSync(out, img.toPNG());
		log("shot saved", out, JSON.stringify(img.getSize()));
	} catch (e) {
		log("shot failed", out, (e && e.stack) || String(e));
	}
}

/** 合成一次指针按下/抬起，展开看板（与真实点击走同一条 hitTest 路径）。 */
function synthClick(win) {
	return win.webContents
		.executeJavaScript(`(() => {
			const el = document.getElementById("stage");
			const base = { bubbles: true, pointerId: 9, button: 0, clientX: 300, clientY: 350, screenX: 300, screenY: 350 };
			el.dispatchEvent(new PointerEvent("pointerdown", base));
			window.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base)));
			return "clicked";
		})()`)
		.then(() => new Promise((r) => setTimeout(r, 700)));
}

// ---------------------------------------------------------------- 启动参数

// 配置走环境变量：argv 里多出来的位置参数（例如 URL）会被 Electron 当成「另一个 app 路径」，
// 表现是进程静默退出、连 userData 都不创建。dsh-pet 的 helper 同样只用环境变量。
const BASE = process.env.DSH_STAR_PET_BASE || "http://127.0.0.1:0/dsh-star-pet";
const TOKEN = process.env.DSH_STAR_PET_TOKEN || "";

// ---------------------------------------------------------------- 与宿主通信

function request(method, urlPath, body) {
	return new Promise((resolve, reject) => {
		let url;
		try {
			url = new URL(BASE + urlPath);
		} catch (e) {
			reject(e);
			return;
		}
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const req = http.request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				method,
				timeout: 4000,
				headers: Object.assign(
					{ "x-star-pet": TOKEN },
					payload ? { "content-type": "application/json", "content-length": payload.length } : {}
				),
			},
			(res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (c) => (data += c));
				res.on("end", () => {
					try {
						resolve(JSON.parse(data || "{}"));
					} catch (e) {
						reject(new Error("bad json from host"));
					}
				});
			}
		);
		req.on("timeout", () => req.destroy(new Error("host timeout")));
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

// ---------------------------------------------------------------- 几何

const PAD = 9;
const PANEL_W = 344;
// 必须与 renderer.js 的 PANEL_H 一致：加了「本月已赚」一行后从 274 变 298
const PANEL_H = 298;
const GAP = 8;
/** 宠物贴边时的默认边距（不再是配置项 —— 配置里没有 margin_* 这两个键）。 */
const MARGIN_RIGHT = 22;
const MARGIN_BOTTOM = 14;
/** 「算不算贴死屏幕边」的判定余量（px），只用来吃掉 setBounds 的取整误差。
 *  和吸附范围无关：吸附是 snap_px 的职责，判定贴边是这 2px 的职责。 */
const EDGE_EPS = 2;

let pet = null;
let visTimer = null; // 宠物主窗口
let menu = null; // 右键菜单窗口
let settings = null; // 设置窗口
let state = {
	petSize: 135,
	showChip: false,
	expanded: false,
	snapEnabled: true,
	snapPx: 30,
	flipOnLeft: true,
};

function petWindowSize() {
	const a = state.petSize;
	const w = Math.max(PANEL_W, a) + 2 * PAD;
	const h = PAD + PANEL_H + GAP + a + PAD;
	return { w, h };
}

function clampToDisplay(bounds, display) {
	const wa = display.workArea;
	const x = Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - bounds.width));
	const y = Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - bounds.height));
	return { x, y, width: bounds.width, height: bounds.height };
}

function defaultPosition(w, h) {
	const display = screen.getPrimaryDisplay();
	const wa = display.workArea;
	return {
		x: wa.x + wa.width - w - MARGIN_RIGHT,
		y: wa.y + wa.height - h - MARGIN_BOTTOM,
	};
}

// ---------------------------------------------------------------- 命中穿透

/**
 * 整窗默认点击穿透（点击落到下面的程序），渲染端在指针进入宠物/面板时
 * 通过 setIgnore(false) 把这一窗切成可点。
 */
function setIgnore(win, ignore) {
	if (!win || win.isDestroyed()) return;
	try {
		win.setIgnoreMouseEvents(ignore, { forward: true });
	} catch (e) {
		/* 某些平台不支持 forward，退回普通模式 */
		try {
			win.setIgnoreMouseEvents(ignore);
		} catch (e2) {
			/* ignore */
		}
	}
}

// ---------------------------------------------------------------- 拖动


/**
 * 拖拽：渲染端驱动（对齐 dsh-pet 的 sprite.sendBounds 思路）。
 * 渲染端在 pointermove 里算好「相对按下点的增量」发过来，这里只做一次加法 + 廉价夹取，
 * 不再用定时器去同步取光标 —— 那会慢半拍、快速拖动时像橡皮筋。
 */
let dragOrigin = null;
let dragDisplay = null;

function startDrag() {
	if (!pet || pet.isDestroyed()) return;
	const b = pet.getBounds();
	dragOrigin = { x: b.x, y: b.y, w: b.width, h: b.height };
	// 显示器在按下时确定一次，拖拽期间不再每帧枚举
	dragDisplay = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
}

function dragTo(dx, dy) {
	if (!pet || pet.isDestroyed() || !dragOrigin) return;
	const wa = (dragDisplay || screen.getPrimaryDisplay()).workArea;
	const x = Math.min(Math.max(dragOrigin.x + (dx | 0), wa.x), wa.x + wa.width - dragOrigin.w);
	const y = Math.min(Math.max(dragOrigin.y + (dy | 0), wa.y), wa.y + wa.height - dragOrigin.h);
	pet.setBounds({ x, y, width: dragOrigin.w, height: dragOrigin.h });
}

function stopDrag() {
	dragOrigin = null;
	dragDisplay = null;
}

function endDrag() {
	stopDrag();
	if (!pet || pet.isDestroyed()) return null;
	const b = pet.getBounds();
	const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
	const wa = display.workArea;
	const tol = Math.max(0, Number(state.snapPx) || 0);
	let { x, y } = b;
	if (state.snapEnabled) {
		// 四边永远都吸（snap_sides 字段已按需求砍掉，不再有「只吸某几条边」的配置）。
		if (Math.abs(x - wa.x) <= tol) x = wa.x;
		if (Math.abs(wa.x + wa.width - (x + b.width)) <= tol) x = wa.x + wa.width - b.width;
		if (Math.abs(y - wa.y) <= tol) y = wa.y;
		if (Math.abs(wa.y + wa.height - (y + b.height)) <= tol) y = wa.y + wa.height - b.height;
	}
	let nb = clampToDisplay({ x, y, width: b.width, height: b.height }, display);
	pet.setBounds(nb);
	// 贴到屏幕左半边 → 整只镜像（渲染端按这个布尔翻转）
	const left = nb.x + nb.width / 2 < wa.x + wa.width / 2;
	request("POST", "/window", { x: nb.x, y: nb.y }).catch(() => {});
	pet.webContents.send("pet:flip", { left, edge: edgeOf(nb, wa) });
	return { x: nb.x, y: nb.y, left };
}

/** 窗口是否真的贴死在屏幕左/右边缘（贴边躲藏用；上下边不做）。
 *  这里只问「是不是已经在边上」，容差不参与 —— 判定范围就是 EDGE_EPS 这两个像素，
 *  用来吃掉 setBounds 的取整误差。把窗口挪到边上是「吸附」的职责，
 *  躲藏自己绝不挪窗口，否则关掉吸附却仍然会吸，两套逻辑就打架了。 */
function edgeOf(b, wa) {
	if (Math.abs(b.x - wa.x) <= EDGE_EPS) return "left";
	if (Math.abs(wa.x + wa.width - (b.x + b.width)) <= EDGE_EPS) return "right";
	return null;
}

/** 在吸附范围内就把窗口吸死到屏幕左/右边缘（原地改 b.x），返回吸到了哪条边。
 *  这是「吸附」的职责，只认 snap_enabled 与 snap_px：
 *  关掉吸附就一行都不吸 —— 此时躲藏只对「手动拖到贴合边」的窗口生效。 */
function snapToEdge(b, wa, tol) {
	if (!state.snapEnabled) return null;
	const t = Math.max(0, Number(tol) || 0);
	let edge = null;
	if (Math.abs(b.x - wa.x) <= t) edge = "left";
	else if (Math.abs(wa.x + wa.width - (b.x + b.width)) <= t) edge = "right";
	if (edge === "left") b.x = wa.x;
	if (edge === "right") b.x = wa.x + wa.width - b.width;
	return edge;
}

// ---------------------------------------------------------------- 菜单窗口

function closeMenu() {
	if (menu && !menu.isDestroyed()) menu.close();
	menu = null;
}

function openMenu(kind, at) {
	closeMenu();
	const display = screen.getDisplayNearestPoint(at);
	const wa = display.workArea;
	// 三种菜单：主菜单 / 大小二级 / 面板显示二级（宽度按内容给）
	const MENU_W = { menu: 150, sizes: 210, panel: 176 };
	const MENU_FALLBACK_H = { menu: 200, sizes: 176, panel: 210 };
	const w = MENU_W[kind] || 150;
	const fallback = MENU_FALLBACK_H[kind] || 200;
	const m = new BrowserWindow({
		width: w,
		height: 40,
		x: Math.max(wa.x, Math.min(at.x, wa.x + wa.width - w)),
		y: Math.max(wa.y, Math.min(at.y, wa.y + wa.height - fallback)),
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		resizable: false,
		movable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		show: false,
		fullscreenable: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	menu = m;
	m.setAlwaysOnTop(true, "screen-saver");
	m.loadFile(path.join(__dirname, "menu.html"), { query: { kind } });
	// 与 Tk 一致：菜单几何按内容撑开，不留空带。
	m.webContents.once("did-finish-load", async () => {
		let hh = fallback;
		try {
			hh = await m.webContents.executeJavaScript(
				'(async () => { try { await document.fonts.ready; } catch {} const b = document.getElementById("body"); return Math.ceil(b.scrollHeight + 2); })()'
			);
		} catch (e) {
			log("menu measure failed", String(e));
		}
		log("menu measure", String(hh), "fallback", String(fallback));
		if (!Number.isFinite(hh) || hh < 40) hh = fallback;
		hh = Math.min(Math.round(hh), wa.height - 20);
		m.setBounds({
			x: Math.max(wa.x, Math.min(at.x, wa.x + wa.width - w)),
			y: Math.max(wa.y, Math.min(at.y, wa.y + wa.height - hh)),
			width: w,
			height: hh
		});
		m.show();
		try {
			m.focus();
		} catch (e) {
			/* ignore */
		}
	});
	m.on("blur", () => closeMenu());
	m.on("closed", () => {
		if (menu === m) menu = null;
	});
	return { x: m.getBounds().x, y: m.getBounds().y };
}

// ---------------------------------------------------------------- 设置窗口

function openSettings() {
	if (settings && !settings.isDestroyed()) {
		settings.show();
		settings.focus();
		return;
	}
	const display = screen.getPrimaryDisplay();
	const wa = display.workArea;
	// 与 Tk 一致：内容区 260 + 左右各 30 = 320，再加 1px 描边 → 322
	const w = 322;
	const h = 664;
	settings = new BrowserWindow({
		width: w,
		height: Math.min(h, wa.height - 40),
		x: Math.round(wa.x + (wa.width - w) / 2),
		y: Math.round(wa.y + (wa.height - Math.min(h, wa.height - 40)) / 2),
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: true,
		resizable: false,
		skipTaskbar: false,
		alwaysOnTop: true,
		show: false,
		title: "上班鼓励宠物 · 设置",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	settings.setAlwaysOnTop(true, "screen-saver");
	settings.loadFile(path.join(__dirname, "settings.html"));
	settings.once("ready-to-show", async () => {
		// Tk 的 _lock_size() 把窗口夹到内容高度：这里量两轮（字体/网格回流后再校正）。
		// 先把窗口撑高，再量内容（窗口偏矮会把 #content 压扁，量出来偏小）
	const measure = () =>
		settings.webContents.executeJavaScript(
			'(async () => { try { await document.fonts.ready; } catch {} const q = (s) => document.querySelector(s); const body = q("#body"); if (!body) return 0; const cs = getComputedStyle(body); const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom); const head = q("#head").getBoundingClientRect().height; const bar = q("#bar").getBoundingClientRect().height; const content = q("#content").scrollHeight; return Math.ceil(head + content + bar + pad + 2 + 8); })()'
		);
	try {
		// 加班分区让内容变高，原来固定 920 的上限会裁掉底部概览，改成贴着工作区上限
		const cap = wa.height - 24;
		settings.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - cap) / 2), width: w, height: cap });
		await new Promise((r) => setTimeout(r, 220));
		const need = await measure();
		const hh = Math.min(Math.max(Math.round(need), 420), cap);
		settings.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - hh) / 2), width: w, height: hh });
		log("settings height", hh);
		await new Promise((r) => setTimeout(r, 120));
	} catch (e) {
		log("settings measure failed", String(e));
	}
		settings.show();
	});
	settings.on("closed", () => {
		settings = null;
	});
}

// ---------------------------------------------------------------- 应用生命周期

process.on("uncaughtException", (e) => {
	log("uncaughtException", (e && e.stack) || String(e));
	try { console.error("[star-pet] uncaught", e); } catch {}
});
process.on("unhandledRejection", (e) => {
	log("unhandledRejection", (e && e.stack) || String(e));
});
// 窗口全关 = 用户要退出（桌宠没有「主窗口」，关掉宠物窗就等于结束）。
app.on("window-all-closed", () => {
	log("window-all-closed → quit");
	app.quit();
});

const gotLock = app.requestSingleInstanceLock();
log("singleInstanceLock", gotLock);
app.on("before-quit", () => log("before-quit"));
app.on("quit", (_e, code) => log("quit", code));
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (pet && !pet.isDestroyed()) pet.show();
	});
	app.disableHardwareAcceleration?.();
	app.whenReady().then(bootstrap).catch((e) => log("bootstrap failed", (e && e.stack) || String(e)));
}

log("whenReady, bootstrapping");
/** 每 150ms 问一次宿主：进程还在不在、窗口该不该显示。 */
function startVisibilityWatch() {
	if (visTimer) clearInterval(visTimer);
	visTimer = setInterval(async () => {
		if (!pet || pet.isDestroyed()) return;
		// 兜底：有的情况下渲染进程被回收但没触发 render-process-gone（休眠唤醒后见过），
		// 所以每轮顺手看一眼 webContents 是否已经崩了。
		try {
			if (pet.webContents.isCrashed()) {
				log("watch: webContents crashed");
				scheduleRecover("watch-crashed");
				return;
			}
		} catch (e) {
			/* webContents 已释放 */
		}
		try {
			const st = await request("GET", "/pet/state");
			if (!st) return;
			if (st.running === false) {
				// 自检模式下手动起的实例宿主不认识，不要因此退出
				if (process.env.DSH_STAR_PET_SELFTEST === "1" || process.env.DSH_STAR_PET_NO_HOST === "1") return;
				app.quit();
				return;
			}
			const want = st.visible !== false;
			if (want && !pet.isVisible()) {
				pet.showInactive();
				log("watch show");
			} else if (!want && pet.isVisible()) {
				pet.hide();
				log("watch hide");
			}
		} catch (e) {
			/* 宿主暂时不可达时保持现状 */
		}
	}, 150);
	visTimer.unref?.();
}

async function bootstrap() {
	log("bootstrap enter");
	let cfg = {};
	let winState = null;
	try {
		log("requesting config from", BASE);
		const snap = await request("GET", "/config");
		log("config ok");
		cfg = snap.config || {};
		winState = snap.window || null;
		Object.assign(state, {
			petSize: Core.petSizeOf(cfg.pet_size_index),
			showChip: cfg.show_chip === true,
			snapEnabled: cfg.snap_enabled !== false,
			snapPx: Number.isFinite(Number(cfg.snap_px)) ? Number(cfg.snap_px) : 30,
			flipOnLeft: cfg.flip_on_left !== false,
		});
	} catch (e) {
		// 宿主还没起来：用默认值先起窗，之后渲染端会重试拿配置
		log("config failed:", e && e.message);
		console.warn("[star-pet] 无法读取配置，使用默认值:", e.message);
	}

	const { w, h } = petWindowSize();
	// 记住的位置可能是别的分辨率/缩放下列保存的，或显示器已经拔掉。
	// 一律先按「离它最近的那块屏」夹一遍，避免窗口生在屏幕外（表现为"程序在跑但看不见"）。
	const rawPos = winState && Number.isFinite(winState.x) ? winState : defaultPosition(w, h);
	const targetDisplay =
		winState && Number.isFinite(winState.x)
			? screen.getDisplayNearestPoint({ x: Math.round(rawPos.x), y: Math.round(rawPos.y) })
			: screen.getPrimaryDisplay();
	let pos = clampToDisplay({ x: Math.round(rawPos.x), y: Math.round(rawPos.y), width: w, height: h }, targetDisplay);
	// 启动位置也要走一次吸附（与拖拽松手同一套规则），否则「上次留在吸附范围内」
	// 的窗口这次启动会停在离边十几像素的地方。
	if (state.snapEnabled && snapToEdge(pos, targetDisplay.workArea, state.snapPx)) {
		pos = clampToDisplay(pos, targetDisplay);
	}
	log("display", JSON.stringify({ scale: targetDisplay.scaleFactor, workArea: targetDisplay.workArea, size: targetDisplay.size }), "raw", JSON.stringify(rawPos), "clamped", JSON.stringify(pos));

	pet = new BrowserWindow({
		width: w,
		height: h,
		x: Math.round(pos.x),
		y: Math.round(pos.y),
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		resizable: false,
		movable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		fullscreenable: false,
		focusable: true,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			backgroundThrottling: false,
		},
	});

	pet.setAlwaysOnTop(true, "screen-saver");
	pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	setIgnore(pet, true);

	log("creating window", w, h, Math.round(pos.x), Math.round(pos.y));
	pet.loadFile(path.join(__dirname, "index.html")).catch((e) => log("loadFile failed", e && e.message));
	pet.once("ready-to-show", () => {
		log("ready-to-show, showing");
		pet.showInactive();
		// 显隐由宿主状态驱动：进程常驻，点一下只是 show/hide，所以秒开秒关。
		startVisibilityWatch();
		setTimeout(() => log("bounds", JSON.stringify(pet.getBounds()), "visible=" + pet.isVisible(), "opacity=" + pet.getOpacity()), 300);
		setIgnore(pet, true);
	});



	// 自检：合成一次拖拽，验证 pointermove → IPC → setBounds 链路
	if (process.env.DSH_STAR_PET_SELFTEST === "1") {
		setTimeout(async () => {
			try {
				const before = pet.getBounds();
				await pet.webContents.executeJavaScript(`(() => {
					const el = document.getElementById("stage");
					const base = { bubbles: true, pointerId: 7, button: 0, clientX: 300, clientY: 380, screenX: 300, screenY: 380 };
					el.dispatchEvent(new PointerEvent("pointerdown", base));
					window.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, base, { clientX: 360, clientY: 430, screenX: 360, screenY: 430 })));
					window.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { clientX: 360, clientY: 430, screenX: 360, screenY: 430 })));
					return "dispatched";
				})()`);
				await new Promise((r) => setTimeout(r, 600));
				log("selftest", JSON.stringify(before), "->", JSON.stringify(pet.getBounds()));
			} catch (e) {
				log("selftest failed", (e && e.stack) || String(e));
			}
		}, 2500);
	}
	pet.webContents.on("did-finish-load", () => {
		const wa0 = screen.getDisplayNearestPoint({ x: pos.x + w / 2, y: pos.y + h / 2 }).workArea;
		pet.webContents.send("pet:boot", {
			base: BASE,
			token: TOKEN,
			cfg,
			left: pos.x + w / 2 < wa0.x + wa0.width / 2,
			// 启动时就贴着屏幕左右边 → 直接进入躲藏（否则要等用户拖一次才生效）
			edge: edgeOf({ x: pos.x, y: pos.y, width: w, height: h }, wa0),
		});
		if (process.env.DSH_STAR_PET_SHOT) {
			const delay = Number(process.env.DSH_STAR_PET_SHOT_DELAY || 1800);
			const expand = process.env.DSH_STAR_PET_SHOT_EXPAND === "1";
			setTimeout(async () => {
				await capture(pet, process.env.DSH_STAR_PET_SHOT, expand ? () => synthClick(pet) : null);
				if (process.env.DSH_STAR_PET_SHOT_EXIT === "1") app.quit();
			}, delay);
		}
	});

	pet.on("closed", () => {
		pet = null;
		app.quit();
	});
	pet.webContents.on("render-process-gone", (_e, d) => {
		// 渲染进程可能被系统/GPU 回收（休眠唤醒、驱动重置、OOM），
		// 主进程和窗口都还在，但窗口里是空的 —— 用户看到的就是"打不开"。
		// 这里不能只记日志，必须自己把渲染进程拉回来。
		const reason = (d && d.reason) || "unknown";
		log("renderer gone", JSON.stringify(d));
		if (reason === "clean-exit") return;
		scheduleRecover(reason);
	});
	pet.webContents.on("unresponsive", () => {
		log("renderer unresponsive");
		scheduleRecover("unresponsive");
	});
	pet.webContents.on("console-message", (_e, _lvl, msg, line, src) => log("renderer console:", msg, src + ":" + line));
	pet.webContents.on("preload-error", (_e, p, err) => log("preload error", p, err && err.message));
	log("window created");
	if (process.env.DSH_STAR_PET_OPEN_SETTINGS === "1") setTimeout(() => openSettings(), 900);
	if (process.env.DSH_STAR_PET_SHOT_SETTINGS) {
		setTimeout(async () => {
			openSettings();
			await new Promise((r) => setTimeout(r, 1500));
			if (!settings || settings.isDestroyed()) return;
			await capture(settings, process.env.DSH_STAR_PET_SHOT_SETTINGS);
			if (process.env.DSH_STAR_PET_SHOT_EXIT === "1") app.quit();
		}, 1200);
	}
}

// ---------------------------------------------------------------- 自愈

let recoverTimer = null;
let recoverCount = 0;

/**
 * 渲染进程没了就重建它。
 * 前几次直接 reload（快、保留窗口位置与置顶状态）；
 * 连续失败说明 webContents 本身坏了，只能整窗重建。
 */
function scheduleRecover(reason) {
	if (recoverTimer || !pet || pet.isDestroyed()) return;
	const delay = Math.min(500 * Math.pow(2, recoverCount), 8000);
	recoverTimer = setTimeout(async () => {
		recoverTimer = null;
		if (!pet || pet.isDestroyed()) return;
		recoverCount += 1;
		log("recover attempt", recoverCount, "reason", reason);
		try {
			if (recoverCount <= 3) {
				// reload 在崩溃后的 webContents 上是允许的，会重新起一个渲染进程
				pet.webContents.reload();
				await new Promise((r) => setTimeout(r, 1500));
				if (!pet.isDestroyed() && !pet.webContents.isCrashed()) {
					log("recover ok via reload");
					recoverCount = 0;
					return;
				}
			}
			log("reload did not help, recreating window");
			const b = pet.getBounds();
			const old = pet;
			pet = null;
			try {
				old.destroy();
			} catch (e2) {
				/* 已经没了 */
			}
			await bootstrap();
			if (pet && !pet.isDestroyed()) {
				pet.setBounds(b);
				pet.showInactive();
				log("recover ok via recreate");
				recoverCount = 0;
			}
		} catch (e) {
			log("recover failed", (e && e.stack) || String(e));
			// 兜底：10 秒后再来一次，避免彻底放弃
			setTimeout(() => scheduleRecover("retry"), 10000);
		}
	}, delay);
	recoverTimer.unref?.();
}

// ---------------------------------------------------------------- IPC

ipcMain.on("pet:ignore", (_e, ignore) => setIgnore(pet, !!ignore));

ipcMain.on("pet:drag-move", (_e, p) => {
	dragTo(p && p.dx, p && p.dy);
});
ipcMain.on("pet:drag-start", () => {
	setIgnore(menu, true);
	startDrag();
});

ipcMain.on("pet:drag-end", (e) => {
	const r = endDrag();
	if (e.sender && !e.sender.isDestroyed()) e.sender.send("pet:dragged", r);
});

ipcMain.handle("pet:menu", (_e, payload) => {
	const at = screen.getCursorScreenPoint();
	const kind = payload && ["sizes", "panel"].includes(payload.kind) ? payload.kind : "menu";
	// 菜单在指针处弹出（和 Tk 的 _popup_menu 一致）
	return openMenu(kind, payload && payload.at ? payload.at : at);
});

ipcMain.on("pet:menu-close", () => closeMenu());
ipcMain.on("pet:menu-resize", (e, p) => {
	const win = BrowserWindow.fromWebContents(e.sender);
	if (!win || win !== menu || win.isDestroyed()) return;
	const need = Math.ceil(Number(p && p.height) || 0);
	if (!need || need < 60) return;
	const b = win.getBounds();
	const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
	const hh = Math.min(need, wa.height - 20);
	win.setBounds({
		x: Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.width)),
		y: Math.max(wa.y, Math.min(b.y, wa.y + wa.height - hh)),
		width: b.width,
		height: hh
	});
});

ipcMain.handle("pet:apply", async (_e, patch) => {
	try {
		const r = await request("POST", "/config", patch || {});
		if (r && r.config) {
			Object.assign(state, {
				petSize: Core.petSizeOf(r.config.pet_size_index),
				showChip: r.config.show_chip === true,
				snapEnabled: r.config.snap_enabled !== false,
				snapPx: Number.isFinite(Number(r.config.snap_px)) ? Number(r.config.snap_px) : state.snapPx,
				flipOnLeft: r.config.flip_on_left !== false,
			});
			const { w, h } = petWindowSize();
			if (pet && !pet.isDestroyed()) {
				const b = pet.getBounds();
				const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
				let nb = clampToDisplay({ x: b.x, y: b.y - (h - b.height), width: w, height: h }, display);
				// 改配置（含打开吸附、调大吸附范围）后也补一次吸附，
				// 规则与拖拽松手完全相同：只看 snap_enabled 与 snap_px。
				if (state.snapEnabled && snapToEdge(nb, display.workArea, state.snapPx)) {
					nb = clampToDisplay(nb, display);
				}
				pet.setBounds(nb);
				// 开/关躲藏、或吸附把窗口挪到边上，都会改变贴边状态，要重新告诉渲染端，
				// 否则渲染端只能等下一次拖拽才知道该不该躲。
				{
					pet.webContents.send("pet:flip", {
						left: nb.x + nb.width / 2 < display.workArea.x + display.workArea.width / 2,
						edge: edgeOf(nb, display.workArea),
					});
				}
				// 立刻把新配置推给渲染端：菜单/设置页改完不必等 1s 轮询，
				// 面板当帧就跟着变（轮询仍保留，用于外部直接改 config.json 的兜底）。
				pet.webContents.send("pet:config", r.config);
			}
		}
		return r;
	} catch (err) {
		return { error: String((err && err.message) || err) };
	}
});

ipcMain.handle("pet:request", async (_e, { method, path: p, body }) => {
	try {
		return await request(method || "GET", p, body);
	} catch (err) {
		return { error: String((err && err.message) || err) };
	}
});

ipcMain.on("pet:quit", () => {
	stopDrag();
	app.quit();
});

ipcMain.on("pet:open-settings", () => openSettings());

ipcMain.on("pet:resize", (_e, size) => {
	if (!pet || pet.isDestroyed() || !Number.isFinite(size)) return;
	state.petSize = size;
	const { w, h } = petWindowSize();
	const b = pet.getBounds();
	const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
	let nb = clampToDisplay({ x: b.x, y: b.y + b.height - h, width: w, height: h }, display);
	// 换尺寸会改变窗口宽度，原本贴死的窗口会因此离开屏幕边（躲藏就断了）。
	// 这里用吸附同一套规则补一次：贴边是「吸」出来的，不是尺寸变化顺手蹭到的。
	if (state.snapEnabled && snapToEdge(nb, display.workArea, state.snapPx)) {
		nb = clampToDisplay(nb, display);
	}
	pet.setBounds(nb);
});
