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
const PANEL_H = 252;
const GAP = 8;

let pet = null;
let visTimer = null; // 宠物主窗口
let menu = null; // 右键菜单窗口
let settings = null; // 设置窗口
let state = {
	petSize: 135,
	showChip: false,
	expanded: false,
	snapEnabled: true,
	snapPx: 28,
	snapSides: ["left", "right", "top", "bottom"],
	marginRight: 22,
	marginBottom: 14,
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
		x: wa.x + wa.width - w - Math.round(state.marginRight),
		y: wa.y + wa.height - h - Math.round(state.marginBottom),
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
		const sides = Array.isArray(state.snapSides) ? state.snapSides : ["left", "right", "top", "bottom"];
		if (sides.includes("left") && Math.abs(x - wa.x) <= tol) x = wa.x;
		if (sides.includes("right") && Math.abs(wa.x + wa.width - (x + b.width)) <= tol) x = wa.x + wa.width - b.width;
		if (sides.includes("top") && Math.abs(y - wa.y) <= tol) y = wa.y;
		if (sides.includes("bottom") && Math.abs(wa.y + wa.height - (y + b.height)) <= tol) y = wa.y + wa.height - b.height;
	}
	const nb = clampToDisplay({ x, y, width: b.width, height: b.height }, display);
	pet.setBounds(nb);
	// 贴到屏幕左半边 → 整只镜像（渲染端按这个布尔翻转）
	const left = nb.x + nb.width / 2 < wa.x + wa.width / 2;
	request("POST", "/window", { x: nb.x, y: nb.y }).catch(() => {});
	pet.webContents.send("pet:flip", { left });
	return { x: nb.x, y: nb.y, left };
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
	const w = kind === "sizes" ? 210 : 150;
	const fallback = kind === "sizes" ? 176 : 200;
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
	// 与 Tk 一致：内容区 260 + 左右各 22 = 304，再加 1px 描边
	const w = 306;
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
		const tall = Math.min(920, wa.height - 40);
		settings.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - tall) / 2), width: w, height: tall });
		await new Promise((r) => setTimeout(r, 220));
		const need = await measure();
		const hh = Math.min(Math.max(Math.round(need), 420), wa.height - 40);
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
app.on("window-all-closed", () => log("window-all-closed"));

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
/** 每 300ms 问一次宿主：进程还在不在、窗口该不该显示。 */
function startVisibilityWatch() {
	if (visTimer) clearInterval(visTimer);
	visTimer = setInterval(async () => {
		if (!pet || pet.isDestroyed()) return;
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
			petSize: cfg.pet_size_index != null ? [108, 135, 162, 189, 216, 243, 270, 297, 324][cfg.pet_size_index] || 135 : 135,
			showChip: cfg.show_chip === true,
			snapEnabled: cfg.snap_enabled !== false,
			snapPx: Number(cfg.snap_px) || 28,
			snapSides: Array.isArray(cfg.snap_sides) ? cfg.snap_sides : ["left", "right", "top", "bottom"],
			marginRight: Number(cfg.margin_right) || 22,
			marginBottom: Number(cfg.margin_bottom) || 14,
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
	const pos = clampToDisplay({ x: Math.round(rawPos.x), y: Math.round(rawPos.y), width: w, height: h }, targetDisplay);
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
		pet.webContents.send("pet:boot", {
			base: BASE,
			token: TOKEN,
			cfg,
			left: pos.x + w / 2 < screen.getPrimaryDisplay().workArea.x + screen.getPrimaryDisplay().workArea.width / 2,
		});
	});

	pet.on("closed", () => {
		pet = null;
		app.quit();
	});
	pet.webContents.on("render-process-gone", (_e, d) => log("renderer gone", JSON.stringify(d)));
	pet.webContents.on("console-message", (_e, _lvl, msg, line, src) => log("renderer console:", msg, src + ":" + line));
	pet.webContents.on("preload-error", (_e, p, err) => log("preload error", p, err && err.message));
	log("window created");
	if (process.env.DSH_STAR_PET_OPEN_SETTINGS === "1") setTimeout(() => openSettings(), 900);
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
	const kind = payload && payload.kind === "sizes" ? "sizes" : "menu";
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
				petSize: [108, 135, 162, 189, 216, 243, 270, 297, 324][r.config.pet_size_index] || state.petSize,
				showChip: r.config.show_chip === true,
				snapEnabled: r.config.snap_enabled !== false,
				snapPx: Number(r.config.snap_px) || state.snapPx,
				snapSides: Array.isArray(r.config.snap_sides) ? r.config.snap_sides : state.snapSides,
				flipOnLeft: r.config.flip_on_left !== false,
			});
			const { w, h } = petWindowSize();
			if (pet && !pet.isDestroyed()) {
				const b = pet.getBounds();
				pet.setBounds(clampToDisplay({ x: b.x, y: b.y - (h - b.height), width: w, height: h }, screen.getDisplayNearestPoint({ x: b.x, y: b.y })));
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
	pet.setBounds(clampToDisplay({ x: b.x, y: b.y + b.height - h, width: w, height: h }, screen.getDisplayNearestPoint({ x: b.x, y: b.y })));
});

app.on("window-all-closed", () => app.quit());

// 宿主（DSH）退出后自己退出：渲染端连续拿不到 /config 会发 pet:quit
process.on("uncaughtException", (err) => {
	console.error("[star-pet] uncaught:", err);
});
