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
// 共享核心（core.js 在 index.html 里先加载）：默认配置、时间解析、计薪口径
// 全部从这里取，渲染端不再自带一份 —— 设置页/宿主看板算出来的数必须同源。
const Core = window.StarPetCore;
// 贴边躲藏（独立模块，见 dock.js）：只在启用时产出 dock 变换，
// 未启用时 petTransform 的结果与改动前完全一致。
const Dock = window.StarPetDock;

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
	// 状态行专用：搬砖中=黄(GOLD)、加班中=红、其余一律绿(MONEY)
	RED: "#ff5d5d",
};

const PAD = 9;
const GAP = 8;
const PANEL_W = 344;
const PANEL_H = 298;
const CHIP_H = 27;
// 宠物尺寸/雪碧图档位一律走 Core（core.js 里只有一份定义）

// 字体：Tk 的点值 → CSS px（1pt = 96/72 px）
const FONT = {
	label: 7 * (96 / 72),   // 9.333
	small: 9 * (96 / 72),   // 12
	big: 17 * (96 / 72),    // 22.667
	chip: 9 * (96 / 72),
	float: 9 * (96 / 72),
	// 「日薪」一栏要同时放绿色基础段和蓝色加班段，12px 下五位数会顶到左边的
	// 标签上（值格中心约 269px，面板右边界 328px），所以这一格单独降到 10px。
	tiny: 10,
};

const FAMILY_SOFT = '"StarPetSoft", "幼圆", "YouYuan", "Yuanti SC", "Microsoft YaHei", sans-serif';
const FAMILY_PLAIN = '"幼圆", "YouYuan", "Yuanti SC", "Microsoft YaHei", "Segoe UI", sans-serif';

// 挤压帧：e 从 -0.20 到 1.20，步长 0.05，共 29 帧
const SQUISH_STEP = 0.05;
const SQUISH_E = Array.from({ length: Math.round(1.4 / SQUISH_STEP) + 1 }, (_, i) => -0.2 + SQUISH_STEP * i);
const SQUISH_DUR = 220;
const FLOAT_LIFE = 1400;
const FLOAT_RISE = 30;
const FLOAT_DEFAULT_SEC = 5; // 默认 5 秒一个（可在设置里 1–10 秒调）
/** 读取「冒钱间隔」：夹到 1–10 秒，缺省 5。 */
function floatSec() {
	const v = Math.round(Number(st.cfg && st.cfg.float_every_sec));
	return Number.isFinite(v) && v >= 1 && v <= 10 ? v : FLOAT_DEFAULT_SEC;
}
/** 读取「吐槽间隔」：夹到 5–120 秒，缺省 30。 */
function banterEverySec() {
	const v = Math.round(Number(st.cfg && st.cfg.banter_every_sec));
	return Number.isFinite(v) && v >= BANTER_MIN_SEC && v <= BANTER_MAX_SEC ? v : BANTER_DEFAULT_SEC;
}
const WD_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// ── 吐槽（banter）：气泡从宠物头顶侧边冒出，停留一会儿后淡出。
// 语句由宿主 /banter 下发（读用户配置目录里的 banter.txt），读不到时用这里的默认值兜底。
const BANTER_MIN_SEC = 5;      // 吐槽间隔下限（秒）
const BANTER_MAX_SEC = 120;    // 吐槽间隔上限（秒）
const BANTER_DEFAULT_SEC = 30; // 默认 30 秒随机出一条
const BANTER_LIFE = 3600;      // 气泡存活 ms（比冒钱久，够读完一句话）
const BANTER_FONT = 14;        // 气泡字号 px（实际会按 108 档缩放）
const DEFAULT_BANTER = {
	normal: [
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
		"活着就行...",
	],
	before: [
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
		"手机充满电了吗？",
	],
};

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
	banter: { normal: [], before: [] },
	banterAcc: 0,
	banters: [],
};

// ───────────────────────────── 贴边躲藏控制器（见 dock.js）
/** 旋转 −90° 后星星占旋转图宽度的比例（实测：星宽 42 / 旋转图宽 324）。 */
const DOCK_STAR_RATIO = 42 / 324;

/** 「只留星星」要滑多远（正数）。
 *  transform-origin 是 50% 50%（帧中心）：绕中心转 −90° 后图形仍以宠物中心为心，
 *  旋转后宽度 = 帧高 = a，所以：
 *    旋转后左缘 = cx − a/2
 *    星星占     [cx − a/2, cx − a/2 + a·RATIO]
 *  贴边时 cx = winW − PAD − a/2，要让星星刚好卡在窗口右缘：
 *    slide = winW − (cx − a/2 + a·RATIO) = PAD + a·(1 − RATIO)
 *  两个方向都用正数：贴左边时最外层 scaleX(-1) 会把局部 +tx 镜像成屏幕向左。 */
function dockSlidePx() {
	const a = st.pet && st.pet.w ? st.pet.w : st.size;
	return PAD + a * (1 - DOCK_STAR_RATIO);
}

let dockCtrl = null;
function ensureDock() {
	if (dockCtrl || !Dock) return dockCtrl;
	dockCtrl = Dock.create({
		apply: (tf) => {
			const wrap = document.getElementById("petWrap");
			if (wrap) wrap.style.transform = tf;
		},
		slidePx: dockSlidePx,
		mirror: () => st.left,
	});
	return dockCtrl;
}

// ───────────────────────────── 派生量（全部委托 core.js）
// 计薪口径只有 core.js 一份实现：宿主、设置页、渲染端算出来的数必须严格一致。
// 这里只做转调，不再自备一套 —— 曾经三份副本各夹各的边界，是最大的维护负担。
const fmtHHMM = Core.fmtHHMM;
const money = Core.money;
const durText = Core.durText;
const isWorkday = Core.isWorkday;
const computeState = (cfg) => Core.deriveModel(cfg);
const snapshot = (model, now) => Core.snapshot(model, now);

/** 两种 #rrggbb 颜色按 t（0–1）混合，用于飘字/气泡的渐隐。 */
function blend(c1, c2, t) {
	const tt = Math.max(0, Math.min(1, t));
	const a = [1, 3, 5].map((i) => parseInt(c1.slice(i, i + 2), 16));
	const b = [1, 3, 5].map((i) => parseInt(c2.slice(i, i + 2), 16));
	return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * tt).toString(16).padStart(2, "0")).join("");
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

/** 雪碧图档位来自 core（尺寸表只有一份）。
 *  屏幕上按 2× 渲染时用 @2x 素材（1:1 设备像素，边缘不虚），
 *  1× 屏幕仍用原图；两者几何一致，只是像素密度不同。 */
const HIRES = (window.devicePixelRatio || 1) >= 1.5;

function layoutPet() {
	const { cx, cy, w, h } = st.pet;
	const idx = Math.max(0, Core.PET_SIZES.indexOf(st.size));
	const sh = Core.sheetOf(idx);
	const scale = st.size / sh.frameH;
	const fw = sh.frameW * scale;
	const fh = sh.frameH * scale;
	const img = document.getElementById("petImg");
	img.style.width = fw + "px";
	img.style.height = fh + "px";
	img.style.backgroundImage = 'url("../../assets/skins/' + Core.skinFile(idx, HIRES) + '")';
	// 雪碧图横向 29 帧（挤压帧）全部铺开，靠 background-position 逐帧切换
	img.style.backgroundSize = sh.frameW * SQUISH_E.length * scale + "px " + fh + "px";
	img._frameW = fw;
	img._sheetW = sh.frameW;
	img._sheetScale = scale;

	const wrap = document.getElementById("petWrap");
	wrap.style.width = fw + "px";
	wrap.style.height = fh + "px";
	wrap.style.left = cx - fw / 2 + "px";
	wrap.style.top = cy - fh / 2 + "px";
	// transform 的唯一出口（见 dock.js）：mirror + 躲藏位移一次性合成
	wrap.style.transform = Dock.petTransform({ mirror: st.left, dock: dockCtrl ? dockCtrl.current() : null });
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

/** 只在文字真的变了才写 DOM —— 250ms 重绘时避免无谓的样式重算。
 *  el 为空时什么都不做（有些格子在特定配置下不存在）。 */
function setText(el, txt) {
	if (el && el.textContent !== txt) el.textContent = txt;
}

/** 同 setText，但改颜色。 */
function setColor(el, color) {
	if (el && el.style.color !== color) el.style.color = color;
}

/** 面板显示开关：默认显示，只有显式为 false 才隐藏。
 *  隐藏时把那一格数字换成「-」，标签和行高都不动。 */
function showOn(key) {
	return !st.cfg || st.cfg[key] !== false;
}

function buildPanel() {
	const p = document.getElementById("panel");
	// 面板相对坐标 = Tk 绝对坐标 - PAD(9)：left 16 / right 328 / mid 172
	const left = 16, right = PANEL_W - 16, mid = (left + right) / 2;
	const LABEL = st.soft ? FAMILY_SOFT : FAMILY_PLAIN, PLAIN = "inherit";

	// ① 状态行：左组右对齐、右组左对齐，各自贴中轴
	// 阶段词与「· 周一」拆成两个 span —— 只有阶段词按状态染色，星期保持灰。
	P.phase = mkEl(p, { right: PANEL_W - (mid - 11) + "px", top: "19px", transform: "translateY(-50%)", color: C.DIM, fontSize: FONT.label + "px", fontFamily: PLAIN, whiteSpace: "nowrap" }, "");
	P.phaseStage = document.createElement("span");
	P.phaseWd = document.createElement("span");
	P.phaseWd.style.color = C.DIM;
	P.phase.append(P.phaseStage, P.phaseWd);
	P.clock = mkEl(p, { left: mid + 11 + "px", top: "19px", transform: "translateY(-50%)", color: C.DIM, fontSize: FONT.label + "px", fontFamily: PLAIN }, "");
	P.phase.style.textAlign = "right";

	// ② 大金额（今日已赚）：绿 = 基本工资部分，蓝 = 加班费部分。
	// 和日薪格同构：容器居中，里面两个 span 并排，宽度自适应不换行。
	P.money = document.createElement("div");
	Object.assign(P.money.style, {
		position: "absolute",
		left: mid + "px",
		top: "45px",
		transform: "translate(-50%,-50%)",
		display: "flex",
		alignItems: "baseline",
		gap: "5px",
		whiteSpace: "nowrap",
		fontWeight: "700",
		fontFamily: LABEL,
	});
	p.appendChild(P.money);
	{
		const mk = (color, txt, size) => {
			const s = document.createElement("span");
			s.textContent = txt;
			Object.assign(s.style, { color, fontSize: size + "px" });
			P.money.appendChild(s);
			return s;
		};
		P.moneyBase = mk(C.MONEY, "¥0.00", FONT.big);
		P.moneyOt = mk(C.ACCENT, "", FONT.tiny);
	}

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
		[124, "时薪", "perhour", C.MONEY, "日薪", "dayBase", C.MONEY],
		[146, "已工作", "worked", C.GOLD, "距离下班", "remaining", C.GOLD],
		[168, "上班", "startat", C.GOLD, "下班", "endat", C.GOLD],
		// 加班时段与窝囊费：加班关掉时显示「关闭」/「—」
		[190, "加班", "otspan", C.ACCENT, "窝囊费", "pouch", C.ACCENT],
	];
	for (const [yy, la, ka, ca, lb, kb, cb] of grid) {
		mkEl(p, { left: labCx[0] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: C.DIM, fontSize: FONT.label + "px" }, la);
		P[ka] = mkEl(p, { left: valCx[0] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: ca, fontSize: FONT.small + "px" }, "—");
		const labB = mkEl(p, { left: labCx[1] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: C.DIM, fontSize: FONT.label + "px" }, lb);
		P[kb] = mkEl(p, { left: valCx[1] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: cb, fontSize: FONT.small + "px" }, "—");
		// 第二列的标签在加班时会被换掉（距离下班 → 距离加班结束）
		if (kb === "remaining") P.remainingLabel = labB;
	}

	// ⑥ 分隔线
	const line = document.createElement("div");
	line.className = "abs";
	Object.assign(line.style, { left: left + "px", top: "209px", width: right - left + "px", height: "1px", background: C.STROKE });
	p.appendChild(line);

	// ⑦ 三行通栏（整组居中）：本月剩余工作日 / 本月已赚 / 本月还可赚
	for (const [yy, label, key, color] of [[230, "本月剩余工作日", "remDays", C.GOLD], [254, "本月已赚", "monthEarned", C.MONEY], [278, "本月还可赚", "monthBase", C.MONEY]]) {
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
		// 「本月还可赚」要做成「基本工资（绿）+ 加班工资（蓝）」两段，
		// 再挂一个不占位的第二个 span，颜色单独设
		if (key === "monthBase") {
			const ot = document.createElement("span");
			ot.textContent = "";
			Object.assign(ot.style, { color: C.ACCENT, fontSize: FONT.small + "px", marginLeft: "-4px" });
			row.appendChild(ot);
			P.monthOt = ot;
		}
		p.appendChild(row);
		P[key] = val;
	}

	panelBuilt = true;
}

function refreshPanel(snap) {
	// 大金额做「数字滚动」：向目标值逼近，差得少就直接吸附到位（避免尾数抖动）。
	// v1.2 的 roll_numbers 开关已按需求删除，这里固定开启。
	// 滚的是「今天到此刻已赚」的总额。
	const target = snap.earned;
	if (Math.abs(target - st.display) < 0.02) st.display = target;
	else st.display += (target - st.display) * 0.32;

	// 绿段 = 基本工资已达成的部分，蓝段 = 剩下的（加班费）。
	// 不要按 earnedOt/earned 的比例切分：那样两段都在动，各自四舍五入后
	// 会在相邻两分钱之间来回跳（绿色 505.73/505.75 抖动即此）。
	// 改成绿段取定值、蓝段吸收滚动的落后量，绿字就稳定不动了。
	const shownBase = Math.min(snap.earnedBase, st.display);
	const shownOt = st.display - shownBase;

	const baseTxt = "¥" + money(Math.round(shownBase * 100) / 100);
	setText(P.moneyBase, baseTxt);
	// 加班费部分：滚到 1 分钱以上才显示，避免下班瞬间闪出一个「+¥0.00」。
	const otTxt = shownOt >= 0.005 ? "+¥" + money(Math.round(shownOt * 100) / 100) : "";
	setText(P.moneyOt, otTxt);

	const phaseTxt = { working: "搬砖中", lunch: "午休中", before: "还没上班", after: "已收工", rest: "今天休息", idle: "休息中", overtime: "加班中" }[snap.phase] || "—";
	const wd = WD_NAMES[(snap.now.getDay() + 6) % 7];
	// 只有阶段词按状态染色：搬砖中=黄，加班中=红，其余一律绿；星期始终灰。
	setText(P.phaseStage, phaseTxt);
	setText(P.phaseWd, " · " + wd);
	setColor(P.phaseStage, snap.phase === "overtime" ? C.RED : snap.phase === "working" ? C.GOLD : C.MONEY);
	const clk = String(snap.now.getMonth() + 1).padStart(2, "0") + "-" + String(snap.now.getDate()).padStart(2, "0") + " " + String(snap.now.getHours()).padStart(2, "0") + ":" + String(snap.now.getMinutes()).padStart(2, "0");
	setText(P.clock, clk);

	// 每秒速度：上班日非加班时段按基本时薪；加班时段按倍率。
	// 休息日没有基本工资，只有加班时段在进账，其余时段速度就是 0
	//（否则「已收工」还写着每秒 ¥0.0360，和不动的大金额自相矛盾）。
	const secRate = snap.secRate;
	const sub = snap.phase === "overtime"
		? "加班 ×" + snap.otRate + " · 每秒 ¥" + secRate.toFixed(4)
		: "今日已赚 · 每秒 ¥" + (secRate || 0).toFixed(4);
	setText(P.sub, sub);

	// 进度条走 barProgress（加班中从 0 重走、已收工恒 100%），颜色恒蓝。
	const pct = Math.round(snap.barProgress * 100);
	setText(P.pct, pct + "%");
	const wpx = snap.barProgress > 0 ? Math.max(3, (PANEL_W - 32) * snap.barProgress) : 1;
	P.barFill.style.width = wpx + "px";

	setText(P.perhour, showOn("show_perhour") ? "¥" + money(snap.model.perHour) : "-");
	// 日薪一格只有绿字：当日基础日薪（非上班日为 ¥0.00）。
	// 当天的加班费不在这里重复显示 —— 它在下面「窝囊费」格。
	const dayTxt = "¥" + money(snap.dayBase);
	setText(P.dayBase, showOn("show_daybase") ? dayTxt : "-");
	setText(P.worked, durText(snap.worked));
	// 加班中 → 「距离加班结束」；下班到加班开始之间 → 「距离加班」；
	// 其余时段保持「距离下班」
	if (snap.phase === "overtime") {
		setText(P.remainingLabel, "距离加班结束");
		setText(P.remaining, durText(snap.otRemaining));
	} else if (snap.phase === "idle") {
		setText(P.remainingLabel, "距离加班");
		const cur = snap.now.getHours() * 60 + snap.now.getMinutes() + snap.now.getSeconds() / 60;
		setText(P.remaining, durText(Math.max(0, (snap.otStartMin - cur) * 60)));
	} else {
		setText(P.remainingLabel, "距离下班");
		// 休息日没有「下班」这回事：加班日干完显示「—」，非加班日也显示「—」，
		// 否则会一直挂着「距离下班 6:30:00」和一个不动的金额自相矛盾。
		setText(P.remaining, snap.workday ? durText(snap.remaining) : "—");
	}
	// 「上班 / 下班」显示今天真正生效的那一对时段：
	// 上班日 → 上下班时间；加班日 → 加班时段（工作日那对或非上班日那对）；
	// 非上班日又不加班 → 今天没有时段可言，显示「—」，
	// 否则会出现「今天休息」却还写着 09:00 / 17:00 的矛盾显示。
	// 上下班格与加班格共用同一个判定，不再各自重算一遍条件。
	const spanOtToday = snap.otWindowValid;
	if (snap.workday) {
		setText(P.startat, fmtHHMM(snap.model.startMin));
		setText(P.endat, fmtHHMM(snap.model.endMin));
	} else if (spanOtToday) {
		setText(P.startat, fmtHHMM(snap.otStartMin));
		setText(P.endat, fmtHHMM(snap.otEndMin));
	} else {
		setText(P.startat, "—");
		setText(P.endat, "—");
	}
	// 加班时段 + 窝囊费：窝囊费就是今天的加班工资（加班多受的那份气换来的钱）。
	// 不加班就是 0。它和上面「日薪」格互不重叠：日薪格只放基础日薪。
	// 时段显示：今天是加班日且窗口有效 → 显示时间（倍率 0 也显示，否则"加班中"却"关闭"矛盾）；
	// 加班总开关开着但今天不是加班日 → 「今天不加」，和设置页「今日不宜加班」同义。
	const spanTxt = snap.otWindowValid
		? fmtHHMM(snap.otStartMin) + "→" + fmtHHMM(snap.otEndMin)
		: snap.model.otOn ? "今天不加" : "关闭";
	setText(P.otspan, spanTxt);
	// 窝囊费格：今天这天的加班费（= snapshot.dayOt）。
	// 彩蛋：开着加班但两档倍率全是 0 —— 加班一分钱不给，这一天纯窝囊。
	if (!showOn("show_pouch")) {
		setText(P.pouch, "-");
		setColor(P.pouch, C.ACCENT);
	} else if (snap.otAllZero) {
		setText(P.pouch, "太窝囊了");
		setColor(P.pouch, "#6b7488");
	} else {
		const pouchTxt = "¥" + money(snap.dayOt);
		setText(P.pouch, pouchTxt);
		setColor(P.pouch, C.ACCENT);
	}
	setText(P.remDays, snap.remDays + " 天");
	// 本月已赚：基本 + 加班合计，一个绿值。
	setText(P.monthEarned, showOn("show_monthearned") ? "¥" + money(snap.monthEarned) : "-");
	// 「本月还可赚」= 基本工资（绿）+ 加班工资（蓝）。
	// 加班工资是把本月剩余每一天按当前设置单独算一遍再加总
	//（工作日/周末倍率不同，加班日也不一定等于上班日）。
	// 加班关掉或本月剩余没有加班时，蓝色段不显示，只留绿色基本工资。
	if (!showOn("show_monthremain")) {
		setText(P.monthBase, "-");
		if (P.monthOt) setText(P.monthOt, "");
	} else {
		setText(P.monthBase, "¥" + money(snap.monthBase));
		if (P.monthOt) {
			const otTxt = snap.monthOt > 0.005 ? "+¥" + money(snap.monthOt) : "";
			setText(P.monthOt, otTxt);
		}
	}
}

function refreshChip(snap) {
	const chip = document.getElementById("chip");
	// 设置里勾上「胶囊」后要立刻出现在头顶（否则要展开再收起一次才显示）
	if (chip.style.display !== "flex") chip.style.display = "flex";
	setText(chip, "¥" + money(snap.earned) + " · " + Math.round(snap.barProgress * 100) + "%");
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
	// 帧本身已经画了形变，这里只做兜底微调（保证边缘手感）。
	// 注意不能写成 "scaleX(-1) none" —— 那是非法值，浏览器整条 transform 都会丢弃，
	// 结果是挤压动画期间左侧的镜像消失（v1.2 的实际 bug）。
	// 现在统一交给 Dock.petTransform 拼（mirror + 躲藏位移），避免两处各写各的。
	const wrap = document.getElementById("petWrap");
	const wantTf = Dock.petTransform({ mirror: st.left, dock: dockCtrl ? dockCtrl.current() : null });
	if (wrap.style.transform !== wantTf) wrap.style.transform = wantTf;
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

function spawnFloat(model, snap) {
	// 加班时段按倍率折算（0 倍率 = 0 元），其他时段就是正常每秒收入
	const rate = snap && snap.phase === "overtime" ? snap.otRate : 1;
	const step = model.perSec * rate * floatSec();
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

// ───────────────────────────── 吐槽气泡
async function loadBanter() {
	try {
		const r = await S.req("GET", "/banter");
		if (r && Array.isArray(r.normal) && r.normal.length) st.banter.normal = r.normal;
		if (r && Array.isArray(r.before)) st.banter.before = r.before;
	} catch (e) {
		/* 宿主没有 /banter（旧版/独立版兜底）→ 用内置默认 */
	}
	if (!st.banter.normal.length) st.banter.normal = DEFAULT_BANTER.normal.slice();
}

/** 距离「下班」或「加班结束」还有 60 分钟内 → 用「下班前」那组。 */
function banterBeforeOffWork(model, now) {
	const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
	const workday = isWorkday(model, now);
	const dow = now.getDay() === 0 ? 7 : now.getDay();
	const otDay = model.otDays.includes(dow);
	if (workday && cur >= model.endMin - 60 && cur < model.endMin) return true;
	if (model.otOn && otDay) {
		const w = Core.overtimeWindow(model, now);
		if (w.end > w.start && cur >= w.end - 60 && cur < w.end) return true;
	}
	return false;
}

function pickBanterLine() {
	const now = new Date();
	let pool = st.banter.normal.length ? st.banter.normal : DEFAULT_BANTER.normal;
	if (banterBeforeOffWork(model, now) && st.banter.before.length) pool = st.banter.before;
	if (!pool.length) return "……";
	return pool[Math.floor(Math.random() * pool.length)];
}

function spawnBanter() {
	const box = st.pet.box;
	if (!box) return;
	const cx = (box[0] + box[2]) / 2; // 保留：气泡定位用宠物矩形中心
	// 从宠物「头部侧面」冒出来（说话泡泡），不是头顶正上方：头部约在宠物顶部 20% 处。
	// 宠物框总是正方形且边长 > 0，直接取 20% 高度即可（原写法 box[1]+box[3]-box[1] > 0
	// 恒为 true，是运算符优先级笔误，结果碰巧一样但读起来像有问题）。
	const petH = box[3] - box[1];
	const headY = box[1] + petH * 0.2;
	const el = document.createElement("div");
	el.className = "banter";
	el.textContent = pickBanterLine();
	// 气泡固定用 108 档的尺寸（不再随星星人大小缩放）：
	// 108 档下气泡单行完整显示在窗口内不被裁切。
	const scale = 108 / 135;
	el.style.setProperty("--bt-scale", String(scale));
	el.style.fontSize = Math.round(BANTER_FONT * scale) + "px";
	el.style.fontFamily = st.soft ? FAMILY_SOFT : FAMILY_PLAIN;
	el.style.maxWidth = "none";           // 单行不换行，宽度由文字长度决定
	document.getElementById("stage").appendChild(el);
	const bw = el.offsetWidth;
	const bh = el.offsetHeight;
	// 锚点侧固定：贴宠物那一侧永不脱锚，字越多向远离宠物方向延伸越长。
	// 宠物在窗口右半边 → 气泡在它左边，右端贴宠物左边缘向左延伸（锚点=最后一个字）；
	// 宠物在左半边 → 气泡在它右边，左端贴宠物右边缘向右延伸（锚点=第一个字）。
	const gap = Math.round(6 * scale);
	const petOnRight = (box[0] + box[2]) / 2 > st.winW / 2;
	let x = petOnRight ? box[0] - gap - bw : box[2] + gap;
	let y = headY - bh / 2;
	// 不做任何 clamp：锚点侧由上面公式固定，远离侧随文字自然延伸（短句短、长句长）。
	y = Math.max(2, Math.min(y, st.winH - bh - 2));
	el.style.left = x + "px";
	el.style.top = y + "px";
	st.banters.push({ el, x, y, ms: 0 });
}

function tickBanters(dt) {
	const alive = [];
	for (const b of st.banters) {
		b.ms += dt;
		if (b.ms > BANTER_LIFE) {
			b.el.remove();
			continue;
		}
		const p = b.ms / BANTER_LIFE;
		// 气泡不动，只做逐渐消失
		if (p > 0.7) b.el.style.opacity = String(Math.max(0, 1 - (p - 0.7) / 0.3));
		alive.push(b);
	}
	st.banters = alive;
}

// ───────────────────────────── 悬停提示
function moveTip(e) {
	const tip = document.getElementById("tip");
	// 菜单开着期间一直压制名签：右键出菜单后光标还在宠物上，悬停逻辑会不停
	// 想把名签露回来，这里在「唯一的显示点」用标志位挡住。
	if (st.menuOpen || !st.pointerInside) {
		tip.style.display = "none";
		return;
	}
	// 文字是常量，只在第一次挂上时写一次
	setText(tip, "困困星人");
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

/** 贴边躲藏中：宠物主体已被裁到窗外，只剩一颗星星可见，
 *  这时不能把整块宠物矩形当成可点挡板（否则会挡住宿主界面的鼠标）。 */
function dockHidden() {
	return !!(dockCtrl && dockCtrl.hidden());
}

function hitTest(x, y) {
	if (!dockHidden() && inPet(x, y)) return true;
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

/** 鼠标是否落在「沿贴边那条竖带」里 —— 躲藏的热区。
 *  高度 = 宠物高，宽度 DOCK_ZONE；横跨屏幕边缘那一侧。 */
const DOCK_ZONE = 26;
function updateDockHover(x, y) {
	if (!dockCtrl || !st.cfg.dock_hide) return;
	const inside = Dock.inZone(x, y, st.pet, st.winW, DOCK_ZONE, st.left);
	dockCtrl.pointer(inside);
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
/** 展开/收起看板。幂等：状态没变也照样把 DOM 对齐一次
 *  （启动时 st.expanded 是 false，若提前 return，面板的 display 就停在 HTML 的默认值上）。 */
function setExpanded(on) {
	on = !!on;
	st.expanded = on;
	const panel = document.getElementById("panel");
	const chip = document.getElementById("chip");
	panel.style.display = on ? "block" : "none";
	chip.style.display = !on && st.cfg.show_chip ? "flex" : "none";
	if (!on) document.getElementById("tip").style.display = "none";
}

// ───────────────────────────── 主循环
let lastTick = performance.now();
let failCount = 0;

/**
 * 穿透开关只在真的变化时才发 IPC。
 * refresh() 每 250ms 跑一次，原来每轮都无条件 S.ignore(...)，等于 4 次/秒的无用
 * IPC 把主进程叫醒；这里缓存上一次的值，没变就不发。
 */
let ignoreSent = null;
function setIgnore(flag) {
	const want = !!flag;
	if (want === ignoreSent) return;
	ignoreSent = want;
	S.ignore(want);
}

function tick(now) {
	const dt = Math.min(64, now - lastTick);
	lastTick = now;
	tickSquish(now);
	if (dockCtrl) dockCtrl.tick(now); // 贴边躲藏动画（未启用时控制器内部直接返回）
	tickFloats(dt);
	tickBanters(dt);
	requestAnimationFrame(tick);
}

let model = null; // 派生模型（Core.deriveModel 的结果），配置变了就重建

/** 吸收一份新配置。轮询与主进程推送共用这一个入口：
 *  两者可能同时到达，所以必须幂等 —— 配置内容真的变了才重建模型
 *  （deriveModel 里有几次 parse，没必要每秒重跑）。 */
function applyConfig(cfg) {
	if (!cfg) return;
	const prev = st.cfg;
	st.cfg = cfg;
	const newSize = Core.petSizeOf(cfg.pet_size_index);
	if (newSize !== st.size) {
		st.size = newSize;
		layout();
		S.resize(st.size);
	}
	const soft = cfg.soft_font !== false;
	if (soft !== st.soft) {
		st.soft = soft;
		applyFont();
	}
	if (JSON.stringify(prev) !== JSON.stringify(cfg)) model = computeState(cfg);
	// 贴边躲藏：开关变化 / 尺寸变化都要重新落地（关掉时控制器自己复位）
	const dockOn = cfg.dock_hide === true;
	if (dockCtrl || dockOn) {
		ensureDock();
		dockCtrl.setEnabled(dockOn);
	}
}

function refresh() {
	const now = new Date();
	if (!model) return;
	const snap = snapshot(model, now);

	// 穿透只由指针位置决定；拖拽中永远保持可交互
	// （否则 250ms 这一轮会把正在进行的拖拽掐断）
	setIgnore(st.dragging ? false : !st.pointerInside);

	if (st.expanded) refreshPanel(snap);
	else if (st.cfg.show_chip) refreshChip(snap);
	else document.getElementById("chip").style.display = "none";

	// 飘字节奏：搬砖中或加班中才冒；间隔取配置（1–10 秒，250ms 一轮），金额 = 这 N 秒赚到的钱
	// 贴边躲藏中（宠物已滑出窗外、只剩星星）不冒飘字，否则会浮在空气里
	if (st.cfg.show_float !== false && !dockHidden() && (snap.phase === "working" || snap.phase === "overtime")) {
		st.floatAcc += 1;
		if (st.floatAcc >= floatSec() * 4) {
			st.floatAcc = 0;
			spawnFloat(model, snap);
		}
	} else {
		st.floatAcc = 0;
	}

	// 吐槽：默认只在「上班/加班」时冒（banter_mode === "workday"）；「全天」则只要可见就冒。
	// 「下班前」那组由 banterBeforeOffWork 按时间自动切换。
	const banterMode = st.cfg.banter_mode || "workday";
	const banterAllowed = st.cfg.show_banter !== false && !dockHidden() &&
		(banterMode === "allday" || snap.phase === "working" || snap.phase === "overtime");
	if (banterAllowed) {
		st.banterAcc += 1;
		if (st.banterAcc >= banterEverySec() * 4) {
			st.banterAcc = 0;
			spawnBanter();
		}
	} else {
		st.banterAcc = 0;
	}
}

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
			setIgnore(!over);
			if (over && inPet(e.clientX, e.clientY)) moveTip(e);
			else document.getElementById("tip").style.display = "none";
		} else if (over && inPet(e.clientX, e.clientY)) {
			moveTip(e);
		}
		updateDockHover(e.clientX, e.clientY);
	});

	window.addEventListener("mouseleave", () => {
		if (st.dragging) return;
		st.pointerInside = false;
		document.getElementById("tip").style.display = "none";
		setIgnore(true);
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
		setIgnore(false);
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

	let menuGen = 0; // 菜单世代号：只让「最后一次」的关闭去清标志，避免被上一个菜单的关闭误清
	window.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		if (!inPet(e.clientX, e.clientY) && !(st.expanded && e.clientY > PAD && e.clientY < PAD + PANEL_H)) return;
		// 用标志位压制名签：菜单开着期间不露，关了才恢复悬停显示。
		const gen = ++menuGen;
		st.menuOpen = true;
		document.getElementById("tip").style.display = "none";
		setIgnore(false);
		// S.menu() 在菜单真正关闭时 resolve（见 main.js openMenu）。
		S.menu({ kind: "menu" }).catch(() => {}).finally(() => {
			if (menuGen === gen) st.menuOpen = false;
		});
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
	st.size = Core.petSizeOf(cfg.pet_size_index);
	model = computeState(cfg);
	layout();
	applyFont();
	S.resize(st.size);
	document.getElementById("chip").style.display = cfg.show_chip ? "flex" : "none";
	setExpanded(false);
	loadBanter();
	setInterval(loadBanter, 30000); // 每 30 秒重读 banter.txt，改文件无需重启
	refresh();
	// 启动时把当前贴边情况记进 dock（哪怕这会儿没开躲藏），开关一开就知道要不要立刻跳进去
	ensureDock();
	dockCtrl.setEdge(typeof payload.edge === "string" ? payload.edge : null);
	if (cfg.dock_hide === true) {
		dockCtrl.setEnabled(true);
	}

	// 两条节奏分开：
	//   渲染 250ms 一轮（只算数、改 DOM，不碰磁盘）；
	//   配置 1s 拉一次（宿主那边是 readFileSync + JSON.parse，250ms 一次属于白烧 IO），
	//   同时兼作宿主存活探测 —— 连续 8 次拉不到就自己退出，避免留下孤儿窗口。
	setInterval(refresh, 250);
	// 推送优先：菜单/设置页改完，主进程会立刻送一份新配置过来，
	// 点开关面板当帧就跟上，不必等下一次轮询（最多要等 1.25s）。
	// 老 preload 没有 onConfig 时退回纯轮询，不至于整段启动逻辑抛错。
	if (typeof S.onConfig === "function") S.onConfig((cfg) => applyConfig(cfg));
	const CONFIG_POLL_MS = 1000;
	const CONFIG_FAIL_LIMIT = 8;
	setInterval(async () => {
		try {
			const r = await S.req("GET", "/config");
			failCount = 0;
			if (r && r.config) applyConfig(r.config);
		} catch (e) {
			failCount += 1;
			if (failCount >= CONFIG_FAIL_LIMIT) S.quit();
		}
	}, CONFIG_POLL_MS);

	S.onFlip(({ left, edge }) => {
		// Tk _draw()：left = _flip_now() or _on_left_half()
		const next = !!left && st.cfg.flip_on_left !== false;
		if (next !== st.left) {
			st.left = next;
			layout();
		}
		// 贴边躲藏：主进程每次拖拽结束都会告知当前贴的是哪条边（null = 没贴边）
		ensureDock();
		dockCtrl.setEdge(edge === "left" || edge === "right" ? edge : null);
	});
	S.onDragged(() => {
		/* 位置已经由主进程落盘 */
	});
});
