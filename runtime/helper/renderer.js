/*
 * dsh-star-pet · 渲染端
 * ------------------------------------------------------------------
 * 与 workpet.py 的 Tk 版逐项对齐：几何、字号、配色、挤压帧、看板版式、
 * 右键菜单、飘字、悬停提示、贴边吸附与镜像。
 *
 * 所有坐标都是「逻辑像素」——Electron 的 CSS px 就是 DIP，和 Tk 的
 * px 缩放后的物理像素在 100% 缩放下等价；高 DPI 由 Electron 统一缩放。
 */

const S = window.starPet;

// ───────────────────────────── 主题常量（与 workpet.py 一致）
const C = {
	CARD: "#171b23",
	CARD_SOFT: "#1f2430",
	STROKE: "#2b3242",
	FG: "#e9eef8",
	DIM: "#7d8798",
	MONEY: "#3ad17f",
	ACCENT: "#5b9cff",
	BAR_BG: "#242b38",
	GOLD: "#e8c060",
};

const PAD = 9;
const GAP = 8;
const PANEL_W = 344;
const PANEL_H = 252;
const CHIP_H = 27;
const PET_SIZES = [108, 135, 162, 189, 216, 243, 270, 297, 324];

// 字体：Tk 的点值 → CSS px（1pt = 96/72 px）
const FONT = {
	label: 7 * (96 / 72),   // 9.333
	small: 9 * (96 / 72),   // 12
	big: 17 * (96 / 72),    // 22.667
	chip: 9 * (96 / 72),
	float: 9 * (96 / 72),
};

const FAMILY_SOFT = '"StarPetSoft", "幼圆", "YouYuan", "Yuanti SC", "Microsoft YaHei", sans-serif';
const FAMILY_PLAIN = '"幼圆", "YouYuan", "Yuanti SC", "Microsoft YaHei", "Segoe UI", sans-serif';

// 挤压帧：e 从 -0.20 到 1.20，步长 0.05，共 29 帧
const SQUISH_STEP = 0.05;
const SQUISH_E = Array.from({ length: Math.round(1.4 / SQUISH_STEP) + 1 }, (_, i) => -0.2 + SQUISH_STEP * i);
const SQUISH_DUR = 220;
const FLOAT_LIFE = 1400;
const FLOAT_RISE = 30;
const FLOAT_EVERY = 11;
const FLOAT_STEPS = 16;
const WD_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// ───────────────────────────── 状态
const st = {
	cfg: {},
	size: 135,
	expanded: false,
	left: false,
	soft: true,
	winW: 362,
	winH: 413,
	pet: { cx: 0, cy: 0, w: 0, h: 0, box: null },
	frameIdx: 0,
	squishE: 0,
	squish: null, // {from, to, t0}
	display: 0,
	floats: [],
	floatAcc: 0,
	floatSeed: 20261105,
	pointerInside: false,
	dragging: null, // {x, y, moved}
	lastSnap: null,
};

// ───────────────────────────── 派生量（对照 config_to_state / Snap）
function parseHHMM(s, dflt) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
	if (!m) return dflt;
	return (Math.min(23, +m[1]) * 60 + Math.min(59, +m[2])) % 1440;
}
function fmtHHMM(min) {
	const v = ((Math.round(min) % 1440) + 1440) % 1440;
	return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
}
function money(v) {
	const n = Number(v) || 0;
	if (Math.abs(n) >= 100000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
	return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function durText(sec) {
	let s = Math.max(0, Math.floor(sec));
	const h = Math.floor(s / 3600); s -= h * 3600;
	const m = Math.floor(s / 60); s -= m * 60;
	return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function blend(c1, c2, t) {
	const tt = Math.max(0, Math.min(1, t));
	const a = [1, 3, 5].map((i) => parseInt(c1.slice(i, i + 2), 16));
	const b = [1, 3, 5].map((i) => parseInt(c2.slice(i, i + 2), 16));
	return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * tt).toString(16).padStart(2, "0")).join("");
}

function computeState(cfg) {
	const monthly = Number(cfg.monthly_wage) || 10000;
	const dailyWage = cfg.daily_wage ? Number(cfg.daily_wage) : null;
	const payDays = Number(cfg.pay_days_per_month) || 21.75;
	const startMin = parseHHMM(cfg.work_start, 540);
	const endMin = parseHHMM(cfg.work_end, 1020);
	const lunchMin = Math.max(0, parseInt(cfg.lunch_minutes || 0, 10) || 0);
	const lunchStartMin = cfg.lunch_start ? parseHHMM(cfg.lunch_start, startMin + 150) : startMin + 150;
	const lunchAfterMin = ((lunchStartMin - startMin) % 1440 + 1440) % 1440;
	const onSite = Math.max(0, endMin - startMin);
	const paid = Math.max(0, onSite - lunchMin);
	const daily = dailyWage || monthly / payDays;
	const netSec = paid * 60;
	const perSec = netSec > 0 ? daily / netSec : 0;
	return {
		startMin, endMin, lunchMin, lunchStartMin, lunchAfterMin,
		paidMin: paid, daily, netSec, perSec, perHour: perSec * 3600,
		weekdays: Array.isArray(cfg.work_weekdays) && cfg.work_weekdays.length ? cfg.work_weekdays.map(Number) : [1, 2, 3, 4, 5],
		holidays: Array.isArray(cfg.holidays) ? cfg.holidays : [],
		extra: Array.isArray(cfg.extra_workdays) ? cfg.extra_workdays : [],
	};
}

function ymd(d) {
	return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function isWorkday(D, d) {
	const ds = ymd(d);
	if (D.holidays.includes(ds)) return false;
	if (D.extra.includes(ds)) return true;
	return D.weekdays.includes(d.getDay() === 0 ? 7 : d.getDay());
}
function workedSeconds(D, now) {
	const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
	const start = D.startMin;
	const end = D.endMin;
	if (cur <= start) return 0;
	const eff = Math.min(cur, end);
	const span = eff - start;
	if (span <= 0) return 0;
	const ls = start + D.lunchAfterMin;
	const le = ls + D.lunchMin;
	const overlap = Math.max(0, Math.min(eff, le) - Math.max(start, ls));
	return Math.max(0, span - overlap) * 60;
}
function monthRemainingWorkdays(D, now) {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	let n = 0;
	const d = new Date(today);
	while (d.getMonth() === today.getMonth()) {
		if (isWorkday(D, d)) n += 1;
		d.setDate(d.getDate() + 1);
	}
	return n;
}
function snapshot(D, now) {
	const workday = isWorkday(D, now);
	const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
	const ls = D.startMin + D.lunchAfterMin;
	const le = ls + D.lunchMin;
	let phase = "working";
	let worked = 0;
	if (!workday) phase = "rest";
	else {
		if (cur < D.startMin) phase = "before";
		else if (cur >= ls && cur < le) phase = "lunch";
		else if (cur >= D.endMin) phase = "after";
		else phase = "working";
		worked = workedSeconds(D, now);
	}
	const progress = D.netSec > 0 ? Math.max(0, Math.min(1, worked / D.netSec)) : 0;
	const remDays = monthRemainingWorkdays(D, now);
	return {
		now, workday, phase, worked, progress,
		earned: D.daily * progress,
		remaining: Math.max(0, D.netSec - worked),
		remDays, monthLeft: remDays * D.daily,
	};
}

// ───────────────────────────── 布局
function layout() {
	const a = st.size;
	st.winW = Math.max(PANEL_W, a) + 2 * PAD;
	st.winH = PAD + PANEL_H + GAP + a + PAD;
	// Tk _avatar_center_in：窗口在屏幕左半边时，宠物画在窗口左侧（m + a/2），否则右侧。
	const ax = st.left ? PAD : st.winW - PAD - a;
	const ay = st.winH - PAD - a;
	st.pet = { cx: ax + a / 2, cy: ay + a / 2, w: a, h: a, box: [ax, ay, ax + a, ay + a] };
	document.documentElement.style.width = st.winW + "px";
	document.documentElement.style.height = st.winH + "px";
	document.body.style.width = st.winW + "px";
	document.body.style.height = st.winH + "px";
	document.getElementById("stage").style.width = st.winW + "px";
	document.getElementById("stage").style.height = st.winH + "px";
	layoutPet();
	layoutPanel();
}

/** 把 cfg.soft_font 真正落到已经建好的元素上（大金额、胶囊、提示条、面板）。 */
function applyFont() {
	const fam = st.soft ? FAMILY_SOFT : FAMILY_PLAIN;
	document.body.style.fontFamily = fam;
	for (const el of [P.money, document.getElementById("chip"), document.getElementById("tip")]) {
		if (el) el.style.fontFamily = fam;
	}
	const panel = document.getElementById("panel");
	if (panel) panel.style.fontFamily = fam;
}

/** 选最接近的雪碧图档位；按目标尺寸缩放（等价于 Tk 的 zoom）。
 *  屏幕上按 2× 渲染时用 @2x 素材（1:1 设备像素，边缘不虚），
 *  1× 屏幕仍用原图；两者几何一致，只是像素密度不同。 */
const SHEETS = [
	{ size: 135, w: 145, h: 135 },
	{ size: 216, w: 231, h: 216 },
	{ size: 324, w: 345, h: 324 },
];
const HIRES = (window.devicePixelRatio || 1) >= 1.5;
function sheetFor(a) {
	let best = SHEETS[0];
	for (const s of SHEETS) if (Math.abs(s.size - a) < Math.abs(best.size - a)) best = s;
	return best;
}

function layoutPet() {
	const { cx, cy, w, h } = st.pet;
	const sh = sheetFor(st.size);
	const scale = st.size / sh.size;
	const fw = sh.w * scale;
	const fh = sh.h * scale;
	const img = document.getElementById("petImg");
	img.style.width = fw + "px";
	img.style.height = fh + "px";
	img.style.backgroundImage = 'url("../../assets/skins/pet-' + sh.size + (HIRES ? "@2x" : "") + '.webp")';
	img.style.backgroundSize = sh.w * SQUISH_E.length * scale + "px " + fh + "px";
	img._frameW = fw;
	img._sheetW = sh.w;
	img._sheetScale = scale;

	const wrap = document.getElementById("petWrap");
	wrap.style.width = fw + "px";
	wrap.style.height = fh + "px";
	wrap.style.left = cx - fw / 2 + "px";
	wrap.style.top = cy - fh / 2 + "px";
	wrap.style.transform = st.left ? "scaleX(-1)" : "none";
	if (!st.squish) st.frameIdx = frameFor(st.squishE);
	applyFrame();
}

/** 把形变量 e 映射到最接近的一帧。静止时必须停在 e≈0 的正面帧上，
 *  否则默认 0 号帧是挤压到 -0.20 的极端帧，几乎看不见（曾经的"桌宠不出来"就是这个）。 */
function frameFor(e) {
	return SQUISH_E.reduce((acc, v, i) => (Math.abs(v - e) < Math.abs(SQUISH_E[acc] - e) ? i : acc), 0);
}

function applyFrame() {
	const img = document.getElementById("petImg");
	const fw = img._frameW || st.size;
	img.style.backgroundPosition = -st.frameIdx * fw + "px 0px";
}

// ───────────────────────────── 看板
let panelBuilt = false;
function layoutPanel() {
	const p = document.getElementById("panel");
	p.style.left = PAD + "px";
	p.style.top = PAD + "px";
	p.style.width = PANEL_W + "px";
	p.style.height = PANEL_H + "px";
	if (!panelBuilt) buildPanel();
}

function mkEl(parent, style, text) {
	const d = document.createElement("div");
	d.className = "abs";
	Object.assign(d.style, style);
	if (text != null) d.textContent = text;
	parent.appendChild(d);
	return d;
}

const P = {}; // 需要反复改文字的元素

function buildPanel() {
	const p = document.getElementById("panel");
	// 面板相对坐标 = Tk 绝对坐标 - PAD(9)：left 16 / right 328 / mid 172
	const left = 16, right = PANEL_W - 16, mid = (left + right) / 2;
	const LABEL = st.soft ? FAMILY_SOFT : FAMILY_PLAIN, PLAIN = "inherit";

	// ① 状态行：左组右对齐、右组左对齐，各自贴中轴
	P.phase = mkEl(p, { right: PANEL_W - (mid - 11) + "px", top: "19px", transform: "translateY(-50%)", color: C.DIM, fontSize: FONT.label + "px", fontFamily: PLAIN }, "—");
	P.clock = mkEl(p, { left: mid + 11 + "px", top: "19px", transform: "translateY(-50%)", color: C.DIM, fontSize: FONT.label + "px", fontFamily: PLAIN }, "");
	P.phase.style.textAlign = "right";

	// ② 大金额
	P.money = mkEl(p, { left: mid + "px", top: "45px", transform: "translate(-50%,-50%)", color: C.MONEY, fontSize: FONT.big + "px", fontWeight: "700", fontFamily: LABEL }, "¥0.00");

	// ③ 副标题
	P.sub = mkEl(p, { left: mid + "px", top: "71px", transform: "translate(-50%,-50%)", color: C.DIM, fontSize: FONT.label + "px" }, "今日已赚 · 每秒 ¥0.0000");

	// ④ 进度条
	const bar = document.createElement("div");
	bar.className = "abs";
	Object.assign(bar.style, { left: left + "px", top: "88px", width: right - left + "px", height: "7px", background: C.BAR_BG, borderRadius: "3px" });
	p.appendChild(bar);
	const fill = document.createElement("div");
	Object.assign(fill.style, { position: "absolute", left: "0", top: "0", height: "100%", width: "1px", background: C.ACCENT, borderRadius: "3px" });
	bar.appendChild(fill);
	P.barFill = fill;
	P.pct = mkEl(p, { right: PANEL_W - right + "px", top: "78px", transform: "translateY(-50%)", color: C.ACCENT, fontSize: FONT.small + "px" }, "0%");

	// ⑤ 三行两列（四个列心）
	const half = (right - left) / 2;
	const labCx = [left + half * 0.3, left + half * 1.22];
	const valCx = [left + half * 0.72, left + half * 1.62];
	const grid = [
		[124, "时薪", "perhour", C.MONEY, "日薪", "daily", C.MONEY],
		[146, "已工作", "worked", C.GOLD, "距离下班", "remaining", C.GOLD],
		[168, "上班", "startat", C.GOLD, "下班", "endat", C.GOLD],
	];
	for (const [yy, la, ka, ca, lb, kb, cb] of grid) {
		mkEl(p, { left: labCx[0] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: C.DIM, fontSize: FONT.label + "px" }, la);
		P[ka] = mkEl(p, { left: valCx[0] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: ca, fontSize: FONT.small + "px" }, "—");
		mkEl(p, { left: labCx[1] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: C.DIM, fontSize: FONT.label + "px" }, lb);
		P[kb] = mkEl(p, { left: valCx[1] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: cb, fontSize: FONT.small + "px" }, "—");
	}

	// ⑥ 分隔线
	const line = document.createElement("div");
	line.className = "abs";
	Object.assign(line.style, { left: left + "px", top: "187px", width: right - left + "px", height: "1px", background: C.STROKE });
	p.appendChild(line);

	// ⑦ 两行通栏（整组居中）
	for (const [yy, label, key, color] of [[208, "本月剩余工作日", "remdays", C.GOLD], [232, "本月还可赚", "monthleft", C.MONEY]]) {
		const row = document.createElement("div");
		row.className = "abs";
		Object.assign(row.style, {
			left: mid + "px", top: yy + "px", transform: "translate(-50%,-50%)",
			display: "flex", alignItems: "center", gap: "10px", whiteSpace: "nowrap",
		});
		const lab = document.createElement("span");
		lab.textContent = label;
		Object.assign(lab.style, { color: C.DIM, fontSize: FONT.label + "px" });
		const val = document.createElement("span");
		val.textContent = "—";
		Object.assign(val.style, { color, fontSize: FONT.small + "px" });
		row.append(lab, val);
		p.appendChild(row);
		P[key] = val;
	}

	panelBuilt = true;
}

function refreshPanel(snap) {
	const target = snap.earned;
	if (st.cfg.roll_numbers !== false) {
		if (Math.abs(target - st.display) < 0.02) st.display = target;
		else st.display += (target - st.display) * 0.32;
	} else st.display = target;

	const v = Math.round(st.display * 100) / 100;
	const moneyTxt = "¥" + money(v);
	if (P.money.textContent !== moneyTxt) P.money.textContent = moneyTxt;

	const phaseTxt = { working: "搬砖中", lunch: "午休中", before: "还没上班", after: "已收工", rest: "今天休息" }[snap.phase] || "—";
	const wd = WD_NAMES[(snap.now.getDay() + 6) % 7];
	P.phase.textContent = phaseTxt + " · " + wd;
	const clk = String(snap.now.getMonth() + 1).padStart(2, "0") + "-" + String(snap.now.getDate()).padStart(2, "0") + " " + String(snap.now.getHours()).padStart(2, "0") + ":" + String(snap.now.getMinutes()).padStart(2, "0");
	if (P.clock.textContent !== clk) P.clock.textContent = clk;

	const D = snap.D;
	const sub = "今日已赚 · 每秒 ¥" + (D.perSec || 0).toFixed(4);
	if (P.sub.textContent !== sub) P.sub.textContent = sub;

	const pct = Math.round(snap.progress * 100);
	if (P.pct.textContent !== pct + "%") P.pct.textContent = pct + "%";
	const wpx = snap.progress > 0 ? Math.max(3, (PANEL_W - 32) * snap.progress) : 1;
	P.barFill.style.width = wpx + "px";

	P.perhour.textContent = "¥" + money(D.perHour);
	P.daily.textContent = "¥" + money(D.daily);
	P.worked.textContent = durText(snap.worked);
	P.remaining.textContent = durText(snap.remaining);
	P.startat.textContent = fmtHHMM(D.startMin);
	P.endat.textContent = fmtHHMM(D.endMin);
	P.remdays.textContent = snap.remDays + " 天";
	P.monthleft.textContent = "¥" + money(snap.monthLeft);
}

function refreshChip(snap) {
	const chip = document.getElementById("chip");
	const txt = "¥" + money(snap.earned) + " · " + Math.round(snap.progress * 100) + "%";
	chip.textContent = txt;
	const a = st.size;
	const pad = 9;
	const hh = CHIP_H;
	const x1 = st.pet.cx - a / 2 - pad;
	const x2 = st.pet.cx + a / 2 + pad;
	const cy2 = st.pet.box[1] - 7;
	chip.style.left = x1 + "px";
	chip.style.width = x2 - x1 + "px";
	chip.style.top = cy2 - hh + "px";
	chip.style.height = hh + "px";
	chip.style.fontSize = FONT.chip + "px";
}

// ───────────────────────────── 挤压动画
function bezier(t) {
	// cubic-bezier(.34,1.56,.64,1) 的 y(t)：用牛顿法反解 x
	const x1 = 0.34, y1 = 1.56, x2 = 0.64, y2 = 1.0;
	const cx = (u) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
	const cy = (u) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
	let lo = 0, hi = 1;
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (cx(mid) < t) lo = mid; else hi = mid;
	}
	return cy((lo + hi) / 2);
}

function squishTo(to) {
	st.squish = { from: st.squishE, to, t0: performance.now() };
}

function tickSquish(now) {
	if (!st.squish) return;
	const p = Math.min(1, (now - st.squish.t0) / SQUISH_DUR);
	const e = st.squish.from + (st.squish.to - st.squish.from) * bezier(p);
	st.squishE = e;
	// e → 帧号（带迟滞，避免相邻两档抖动）
	const best = SQUISH_E.reduce((acc, v, i) => (Math.abs(v - e) < Math.abs(SQUISH_E[acc] - e) ? i : acc), 0);
	if (best !== st.frameIdx) {
		const dNew = Math.abs(SQUISH_E[best] - e);
		const dCur = Math.abs(SQUISH_E[st.frameIdx] - e);
		if (best === 0 || st.frameIdx === 0 || dNew + 0.018 < dCur) {
			st.frameIdx = best;
			applyFrame();
		}
	}
	// 帧本身已经画了形变，这里只做兜底微调（保证边缘手感）
	const wrap = document.getElementById("petWrap");
	wrap.style.transform = (st.left ? "scaleX(-1) " : "") + "none";
	if (p >= 1) {
		const target = st.squish.to;
		st.squish = null;
		st.squishE = target;
		st.frameIdx = frameFor(st.squishE);
		applyFrame();
	}
}

// ───────────────────────────── 飘字
function rand(span) {
	st.floatSeed = (st.floatSeed * 1103515245 + 12345) & 0x7fffffff;
	return st.floatSeed % Math.max(1, span);
}

function spawnFloat(D, snap) {
	const step = D.perSec * FLOAT_STEPS;
	if (step <= 0) return;
	const box = st.pet.box;
	if (!box) return;
	const span = Math.max(1, Math.floor((box[2] - box[0]) / 3));
	const x = (box[0] + box[2]) / 2 - span / 2 + rand(span);
	const y0 = box[1] + 6;
	const el = document.createElement("div");
	el.className = "float";
	el.style.left = x + "px";
	el.style.top = y0 + "px";
	el.style.fontSize = FONT.float + "px";
	el.style.fontFamily = st.soft ? FAMILY_SOFT : FAMILY_PLAIN;
	el.textContent = "+¥" + step.toFixed(4);
	document.getElementById("stage").appendChild(el);
	st.floats.push({ el, x, y: y0, ms: 0 });
}

function tickFloats(dt) {
	const alive = [];
	for (const f of st.floats) {
		f.ms += dt;
		if (f.ms > FLOAT_LIFE) {
			f.el.remove();
			continue;
		}
		const p = f.ms / FLOAT_LIFE;
		const rise = (1 - Math.pow(1 - p, 2)) * FLOAT_RISE;
		f.el.style.transform = "translate(-50%, " + -rise + "px)";
		if (p > 0.62) {
			const shade = Math.max(0, 1 - (p - 0.62) / 0.38);
			f.el.style.color = blend(C.CARD, C.MONEY, shade);
		}
		alive.push(f);
	}
	st.floats = alive;
}

// ───────────────────────────── 悬停提示
function moveTip(e) {
	const tip = document.getElementById("tip");
	if (!st.pointerInside) {
		tip.style.display = "none";
		return;
	}
	const text = "困困星人";
	tip.textContent = text;
	tip.style.display = "flex";
	tip.style.fontSize = FONT.small + "px";
	tip.style.height = "26px";
	tip.style.padding = "0 11px";
	tip.style.fontFamily = st.soft ? FAMILY_SOFT : FAMILY_PLAIN;
	const pw = tip.offsetWidth;
	const ph = 26;
	let x = e.clientX + 14;
	let y = e.clientY - ph - 12;
	x = Math.max(4, Math.min(x, st.winW - pw - 4));
	y = Math.max(4, Math.min(y, st.winH - ph - 4));
	tip.style.left = x + "px";
	tip.style.top = y + "px";
}

function inPet(x, y) {
	const box = st.pet.box;
	return !!box && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

function hitTest(x, y) {
	if (inPet(x, y)) return true;
	if (st.expanded) {
		return x >= PAD && x <= PAD + PANEL_W && y >= PAD && y <= PAD + PANEL_H;
	}
	if (st.cfg.show_chip) {
		const chip = document.getElementById("chip");
		if (chip.style.display !== "none") {
			const r = chip.getBoundingClientRect();
			if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
		}
	}
	return false;
}

// ───────────────────────────── 声音
let clickAudio = null;
function playClick() {
	if (st.cfg.sound === false) return;
	try {
		if (!clickAudio) {
			clickAudio = new Audio("../../assets/click.wav");
			clickAudio.volume = 0.35;
		}
		clickAudio.currentTime = 0;
		clickAudio.play().catch(() => {});
	} catch (e) {
		/* ignore */
	}
}

// ───────────────────────────── 展开 / 收起
function setExpanded(on) {
	on = !!on;
	if (on === st.expanded) return;
	st.expanded = on;
	const panel = document.getElementById("panel");
	const chip = document.getElementById("chip");
	panel.style.display = on ? "block" : "none";
	chip.style.display = !on && st.cfg.show_chip ? "flex" : "none";
	if (!on) document.getElementById("tip").style.display = "none";
}

// ───────────────────────────── 主循环
let lastTick = performance.now();
let lastRefresh = 0;
let failCount = 0;

function tick(now) {
	const dt = Math.min(64, now - lastTick);
	lastTick = now;
	tickSquish(now);
	tickFloats(dt);
	requestAnimationFrame(tick);
}

let D = null;
function refresh() {
	const now = new Date();
	if (!D) return;
	const snap = snapshot(D, now);
	snap.D = D;

	const restHidden = !snap.workday && st.cfg.hide_on_rest_day === true;
	document.getElementById("stage").style.opacity = restHidden ? "0" : "1";
	// 休息日隐藏 → 整窗穿透；否则只在指针不在宠物/面板上时穿透
	S.ignore(restHidden || !st.pointerInside);

	if (st.expanded) refreshPanel(snap);
	else if (st.cfg.show_chip) refreshChip(snap);

	// 飘字节奏（每 250ms 一轮，累计 11 轮冒一个）
	if (st.cfg.show_float !== false && snap.workday) {
		st.floatAcc += 1;
		if (st.floatAcc >= FLOAT_EVERY) {
			st.floatAcc = 0;
			spawnFloat(D, snap);
		}
	}
}

let hitTestPointer = false;

// ───────────────────────────── 指针与交互
function bindPointer() {
	const stage = document.getElementById("stage");

	// 用捕获阶段拿 mousemove：即使整窗处于「穿透」状态，forward:true 也会送进来
	window.addEventListener("mousemove", (e) => {
		if (st.dragging) {
			if (Math.abs(e.screenX - st.dragging.sx) > 3 || Math.abs(e.screenY - st.dragging.sy) > 3) st.dragging.moved = true;
			return;
		}
		const over = hitTest(e.clientX, e.clientY);
		if (over !== st.pointerInside) {
			st.pointerInside = over;
			S.ignore(!over);
			if (over && inPet(e.clientX, e.clientY)) moveTip(e);
			else document.getElementById("tip").style.display = "none";
		} else if (over && inPet(e.clientX, e.clientY)) {
			moveTip(e);
		}
		hitTestPointer = over;
	});

	window.addEventListener("mouseleave", () => {
		if (st.dragging) return;
		st.pointerInside = false;
		hitTestPointer = false;
		document.getElementById("tip").style.display = "none";
		S.ignore(true);
	});

	// 拖拽：pointer 事件 + 指针捕获，位移直接在 move 里发给主进程（对齐 dsh-pet 的做法）。
	window.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		if (!hitTest(e.clientX, e.clientY)) return;
		if (!inPet(e.clientX, e.clientY)) return;
		st.dragging = { sx: e.screenX, sy: e.screenY, moved: false, id: e.pointerId };
		playClick();
		squishTo(1);
		// 拖拽期间必须保持「可交互」，否则穿透会吞掉后续 pointermove/pointerup
		S.ignore(false);
		try {
			stage.setPointerCapture(e.pointerId);
		} catch (err) {
			/* 某些环境下不支持捕获，退回普通事件流 */
		}
		S.dragStart();
	});

	window.addEventListener("pointermove", (e) => {
		if (!st.dragging) return;
		const dx = e.screenX - st.dragging.sx;
		const dy = e.screenY - st.dragging.sy;
		if (!st.dragging.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) st.dragging.moved = true;
		if (st.dragging.moved) S.dragMove(dx, dy);
	});

	function finishDrag(e) {
		if (!st.dragging) return;
		if (e && e.pointerId !== undefined && st.dragging.id !== e.pointerId) return;
		const wasDrag = st.dragging.moved;
		const id = st.dragging.id;
		st.dragging = null;
		squishTo(0);
		try {
			stage.releasePointerCapture(id);
		} catch (err) {
			/* ignore */
		}
		S.dragEnd();
		if (!wasDrag) setExpanded(!st.expanded);
	}

	window.addEventListener("pointerup", finishDrag);
	window.addEventListener("pointercancel", finishDrag);

	window.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		if (!inPet(e.clientX, e.clientY) && !(st.expanded && e.clientY > PAD && e.clientY < PAD + PANEL_H)) return;
		S.ignore(false);
		S.menu({ kind: "menu" });
	});
}

// 菜单窗口里选中后回调：主窗只负责应用结果
window.addEventListener("DOMContentLoaded", () => {
	bindPointer();
	requestAnimationFrame(tick);
});

// ───────────────────────────── 启动
S.boot(async (payload) => {
	let res = null;
	try {
		res = await S.req("GET", "/config");
	} catch (e) {
		/* 宿主未就绪 */
	}
	const cfg = (res && res.config) || payload.cfg || {};
	st.cfg = cfg;
	st.soft = cfg.soft_font !== false;
	st.left = payload.left === true && cfg.flip_on_left !== false;
	const idx = Number.isInteger(cfg.pet_size_index) ? cfg.pet_size_index : 1;
	st.size = PET_SIZES[Math.max(0, Math.min(PET_SIZES.length - 1, idx))];
	D = computeState(cfg);
	layout();
	applyFont();
	S.resize(st.size);
	document.getElementById("chip").style.display = cfg.show_chip ? "flex" : "none";
	setExpanded(false);
	refresh();
	refresh();

	// 250ms 数据刷新；同时兼作宿主存活探测
	setInterval(async () => {
		try {
			const r = await S.req("GET", "/config");
			failCount = 0;
			if (r && r.config) {
				st.cfg = r.config;
				const newIdx = Number.isInteger(r.config.pet_size_index) ? r.config.pet_size_index : 1;
				const newSize = PET_SIZES[Math.max(0, Math.min(PET_SIZES.length - 1, newIdx))];
				if (newSize !== st.size) {
					st.size = newSize;
					layout();
					S.resize(st.size);
				}
				const soft = r.config.soft_font !== false;
				if (soft !== st.soft) {
					st.soft = soft;
					applyFont();
				}
				D = computeState(r.config);
			}
		} catch (e) {
			failCount += 1;
			if (failCount >= 8) {
				// 宿主连续 2 秒不可达 → 自己退出，避免留下孤儿窗口
				S.quit();
			}
		}
		refresh();
	}, 250);

	S.onFlip(({ left }) => {
		// Tk _draw()：left = _flip_now() or _on_left_half()
		const next = !!left && st.cfg.flip_on_left !== false;
		if (next === st.left) return;
		st.left = next;
		layout();
	});
	S.onDragged(() => {
		/* 位置已经由主进程落盘 */
	});
});
