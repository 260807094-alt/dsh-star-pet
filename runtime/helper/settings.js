/*
 * dsh-star-pet · 右键菜单里的「设置」窗
 * 与 workpet.py 的 SettingsWindow 同构：1px 描边壳、左侧小节标题（上方一条细线）、
 * 「标签 … [− 值 +]」右对齐步进组、上班日 7 格、外观 3 列开关、居中两列概览、
 * 两行消息区，按钮靠右且视觉顺序为 保存 / 取消 / 恢复默认。
 */
// 在浏览器里单独打开本页（调试用）时没有 preload，这里兜一层，避免整页白屏
const S = window.starPet || {
	req: async () => ({ config: {} }),
	apply: async () => ({}),
	menuClose: () => {},
	openSettings: () => {},
	quit: () => {},
};
const Core = window.StarPetCore;
const WD = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const FLAGS = [
	["snap_enabled", "贴边吸附"],
	["flip_on_left", "贴左镜像"],
	["sound", "点击音效"],
	["show_chip", "胶囊"],
	["show_banter", "吐槽"],
	["show_float", "赚到飘字"],
];

/** 默认值只有一个来源：core.js 的 DEFAULT_CONFIG。 */
const DEFAULT = Core.DEFAULT_CONFIG;


/** 加班倍率的按钮：值 → 显示文字。 */
const RATES = Core.OVERTIME_RATES.map((v) => [v, v]);
/** 两档倍率字段 → 设置页里的标签。
 *  标签必须短到一行放得下（窗口内宽只有约 262px，右侧还要排 5 个按钮），
 *  所以「加班 ×倍工资」放在上面的小标题里，这里只写工作日/周末。 */
const RATE_ROWS = [
	["overtime_rate_workday", "工作日"],
	["overtime_rate_weekend", "周末"],
];

let cfg = { ...DEFAULT };

// 解析 / 格式化 / 金额全部取自 core.js，不再各写一份。
const parse = (s, d) => Core.parseHHMM(s, d);
const hhmm = (m) => Core.fmtHHMM(m);
const money = (v) => Core.money(v);
/** 分钟 → "H:MM"。 */
const durShort = (v) => {
	const n = Math.max(0, Math.round(Number(v) || 0));
	const h = Math.floor(n / 60);
	const m = n % 60;
	return h + ":" + String(m).padStart(2, "0");
};


function el(tag, cls, text) {
	const d = document.createElement(tag);
	if (cls) d.className = cls;
	if (text != null) d.textContent = text;
	return d;
}

/** 对应 Tk 的 _stepper：左侧 10pt 标签，右侧 [− 值 +]。
 *  min/max 可以是数字或函数（函数每次刷新实时求值，用于跨字段联动灰态）。
 *  任一字段变化后调用 refreshAll() 重算所有行的灰态。 */
const _refreshFns = [];
/** 「本地日期」串，用来判断是否跨天：2026-11-09。 */
function dayKey(d) {
	return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

/** 上一次渲染「今日概览」时用的日期。跨天后由 tickDay() 触发重算。 */
let lastOvYmd = null;

/** 设置窗口可能一直开着跨过零点（比如挂着不关）。概览里日薪、
 *  加班时段、本月剩余天数都按「今天」算，跨天后必须重算一次，
 *  否则显示的是昨天那套。只在日期真的变了时重算，平时零开销、无闪烁。 */
function tickDay() {
	if (lastOvYmd !== dayKey(new Date())) overview();
}

/** 重算所有步进器（灰态 + 值），然后刷新概览。
 *  概览里的钱全都来自 cfg，任何一处 cfg 变了都必须重算，
 *  否则会出现「倍率能实时变、薪资不变」这种半实时状态。 */
function refreshAll() {
	for (const f of _refreshFns) f();
	overview();
}

/**
 * 一行「标签 … [− 值 +]」步进器。
 *   min/max 可以是数字或函数（每次刷新实时求值，用于跨字段联动）。
 *   **跨字段联动会把当前值挤出合法区间**（比如调到午休 300 分钟后，
 *   午休开始的上限变成 12:00，而值还停在 15:30），所以 refresh 里顺手夹回去，
 *   保证界面上任何时刻看到的都是可保存的值。
 */
function stepper(host, label, get, set, step, fmt, min, max) {
	const row = el("div", "row");
	row.appendChild(el("div", "lab", label));
	const grp = el("div", "grp");
	const minus = el("div", "sbtn", "−");
	const val = el("div", "val", fmt(get()));
	const plus = el("div", "sbtn", "+");
	const lo = () => (typeof min === "function" ? min() : typeof min === "number" ? min : 0);
	const hi = () => (typeof max === "function" ? max() : typeof max === "number" ? max : null);
	const refresh = () => {
		const mx = hi();
		let v = get();
		const clamped = Math.min(mx == null ? v : mx, Math.max(lo(), v));
		if (clamped !== v) {
			set(clamped);
			v = clamped;
		}
		val.textContent = fmt(v);
		minus.classList.toggle("disabled", v <= lo());
		plus.classList.toggle("disabled", mx != null && v >= mx);
	};
	minus.addEventListener("click", () => {
		const v = get();
		if (v <= lo()) return;
		set(Math.max(lo(), v - step));
		refreshAll();
	});
	plus.addEventListener("click", () => {
		const v = get();
		const mx = hi();
		if (mx != null && v >= mx) return;
		set(mx != null ? Math.min(mx, v + step) : v + step);
		refreshAll();
	});
	grp.append(minus, val, plus);
	row.appendChild(grp);
	host.appendChild(row);
	_refreshFns.push(refresh);
	refresh();
	return val;
}

function build() {
	_refreshFns.length = 0;
	document.documentElement.style.setProperty(
		"--pet-font",
		cfg.soft_font !== false ? '"StarPetSoft","Microsoft YaHei",sans-serif' : '"Microsoft YaHei","Segoe UI",sans-serif'
	);

	const pay = document.getElementById("sec-pay");
	pay.innerHTML = "";
	// 月薪：步长 100，0 是合法值（待业）。上限只是防止手滑点到天文数字。
	stepper(pay, "月薪", () => Number(cfg.monthly_wage) || 0, (v) => (cfg.monthly_wage = Math.round(v)), 100, (v) => "¥" + Math.round(v).toLocaleString("en-US"), 0, 10000000);
	// 月计薪天数：1 ~ 30（一个月最多 30 天，30 天 = 不扣周末，全月算薪）。日薪 = 月薪 ÷ 它。
	const payDaysGet = () => {
		const v = Number(cfg.pay_days_per_month);
		return Number.isFinite(v) && v >= 1 ? Math.min(30, v) : 21.75;
	};
	stepper(pay, "月计薪天数", payDaysGet, (v) => (cfg.pay_days_per_month = Math.max(1, Math.min(30, Math.round(v * 100) / 100))), 0.25, (v) => Number(v).toFixed(2), 1, 30);

	const time = document.getElementById("sec-time");
	time.innerHTML = "";
	const workStart = () => parse(cfg.work_start, 540);
	const workEnd = () => parse(cfg.work_end, 1020);
	const lunchStart = () => parse(cfg.lunch_start, 690);
	const lunchMin = () => Number(cfg.lunch_minutes) || 0;
	const otWStart = () => parse(cfg.overtime_start_workday, 1140);
	const otWEnd = () => parse(cfg.overtime_end_workday, 1260);
	const otRStart = () => parse(cfg.overtime_start_weekend, 540);
	const otREnd = () => parse(cfg.overtime_end_weekend, 1020);

	// 变灰规则（只变灰，不自动改值）：减号在 ≤下限时灰，加号在 ≥上限时灰。
	// step：全部时间字段统一 15 分钟一档。
	//
	// 需求②要的是**开区间**：四段之间不能贴死（午休开始 == 上班、午休结束 == 下班
	// 都会让某一段长度变成 0）。所以上下限都在边界上再让出 15 分钟，
	// 让 UI 根本点不出非法组合；core.validateConfig 里还有同一套兜底。
	// 例外：午休 0 分钟表示「不午休」，此时午休开始时间不参与任何计算，
	// 不参加约束，否则中午连轴上班的人会被卡死。
	const hasLunch = () => lunchMin() > 0;
	stepper(time, "上班", workStart, (v) => (cfg.work_start = hhmm(v)), 15, hhmm, 0, () => (hasLunch() ? Math.min(workEnd() - 15, lunchStart() - 15) : workEnd() - 15));
	stepper(time, "午休开始", lunchStart, (v) => (cfg.lunch_start = hhmm(v)), 15, hhmm, () => workStart() + 15, () => workEnd() - lunchMin() - 15);
	stepper(time, "午休", lunchMin, (v) => (cfg.lunch_minutes = Math.min(300, Math.round(v))), 15, durShort, 0, () => Math.min(300, workEnd() - lunchStart() - 15));
	stepper(time, "下班", workEnd, (v) => (cfg.work_end = hhmm(v)), 15, hhmm, () => (hasLunch() ? Math.max(workStart() + 15, lunchStart() + lunchMin() + 15) : workStart() + 15), 1439);

	const wds = document.getElementById("wds");
	const ot = document.getElementById("sec-ot");
	ot.innerHTML = "";
	// 开关在右键菜单里（默认关闭）；这里管「加班日 + 时段 + 两档倍率」
	// 加班日：与上班日一样七天自选，**可以为空**
	ot.appendChild(el("div", "note", "加班日"));
	const otDaysWrap = el("div", "wds");
	const wset = new Set((cfg.work_weekdays || []).map(Number));
	const otSet = new Set((cfg.overtime_weekdays || []).map(Number));

	/** 周六(6) / 周日(7) 一天只能算「上班日」或「加班日」之一。
	 *  周一到周五允许两组共存（白天上班、晚上加班是常态）。
	 *  两组都可以全空 —— 全空就是「这周一天班都不上 / 一天班都不加」。 */
	const isWeekend = (day) => day >= 6;

	/** 两个 Set 是唯一可改的状态；cfg 只是它们的投影，保存时 S.apply 提交。 */
	function syncDays() {
		cfg.work_weekdays = [...wset].sort((a, b) => a - b);
		cfg.overtime_weekdays = [...otSet].sort((a, b) => a - b);
	}

	/** 点一下某天：已经在里面就移除，否则加入。
	 *  周末加入时把对面同一天挪走 —— 这就是「互斥」，没有第三种状态。 */
	function toggleDay(day, self, other) {
		if (self.has(day)) {
			self.delete(day);
		} else {
			if (isWeekend(day)) other.delete(day);
			self.add(day);
		}
		syncDays();
	}

	/** 重画一组格子。只负责把 Set 画出来，不改状态。 */
	function drawGrid(host, self, other) {
		host.innerHTML = "";
		WD.forEach((name, i) => {
			const day = i + 1;
			const b = el("div", "wd" + (self.has(day) ? " on" : ""), name);
			b.addEventListener("click", () => {
				toggleDay(day, self, other);
				renderDays();
				overview();
			});
			host.appendChild(b);
		});
	}

	function renderDays() {
		drawGrid(wds, wset, otSet);
		drawGrid(otDaysWrap, otSet, wset);
	}

	ot.appendChild(otDaysWrap);
	renderDays();

	// 加班时段：上班日那对只要求「整体在下班之后」，非上班日那对不设任何时间下限。
	// （v1.2 硬编码了 17:00 和 05:00 两条下限，导致下班 16:00 的人无法加班、
	//   周末早班 04:30 也被挡。）
	stepper(ot, "上班日加班开始", otWStart, (v) => (cfg.overtime_start_workday = hhmm(v)), 15, hhmm, () => workEnd(), () => Math.max(workEnd(), otWEnd() - 15));
	stepper(ot, "上班日加班结束", otWEnd, (v) => (cfg.overtime_end_workday = hhmm(v)), 15, hhmm, () => Math.max(workEnd(), otWStart() + 15), 1439);
	stepper(ot, "非上班日加班开始", otRStart, (v) => (cfg.overtime_start_weekend = hhmm(v)), 15, hhmm, 0, () => Math.max(0, otREnd() - 15));
	stepper(ot, "非上班日加班结束", otREnd, (v) => (cfg.overtime_end_weekend = hhmm(v)), 15, hhmm, () => Math.min(1439, otRStart() + 15), 1439);

	// 加班 ×倍工资：工作日 / 非上班日 两行，各自 0 / 1 / 1.5 / 2（3 倍已按需求删除）
	ot.appendChild(el("div", "note", "加班 ×倍工资"));
	for (const [key, label] of RATE_ROWS) {
		const row = el("div", "row");
		row.appendChild(el("div", "lab", label));
		const grp = el("div", "rates");
		const paint = () => {
			for (const b of grp.children) b.classList.toggle("on", b.dataset.rate === String(cfg[key] ?? ""));
		};
		for (const [value, text] of RATES) {
			const b = el("div", "rate", text);
			b.dataset.rate = value;
			b.addEventListener("click", () => {
				cfg[key] = value;
				paint();
				overview();
			});
			grp.appendChild(b);
		}
		row.appendChild(grp);
		ot.appendChild(row);
		paint();
	}

	const look = document.getElementById("sec-look");
	look.innerHTML = "";
	stepper(look, "吸附范围", () => Number(cfg.snap_px) || 0, (v) => (cfg.snap_px = Math.max(0, Math.min(200, Math.round(v)))), 2, (v) => Math.round(v) + " px");
	stepper(look, "冒钱间隔", () => Number(cfg.float_every_sec) || 5, (v) => (cfg.float_every_sec = Math.max(1, Math.min(10, Math.round(v)))), 1, (v) => Math.round(v) + " 秒");
	stepper(look, "吐槽间隔", () => Number(cfg.banter_every_sec) || 30, (v) => (cfg.banter_every_sec = Math.max(5, Math.min(120, Math.round(v)))), 5, (v) => Math.round(v) + " 秒");

	// 吐槽时段：上班/加班 才吐槽，或全天吐槽
	const modeRow = el("div", "row");
	modeRow.appendChild(el("div", "lab", "吐槽时段"));
	const modeGrp = el("div", "rates");
	const MODES = [["workday", "上班"], ["allday", "全天"]];
	const paintMode = () => {
		for (const b of modeGrp.children) b.classList.toggle("on", b.dataset.mode === (cfg.banter_mode || "workday"));
	};
	for (const [value, text] of MODES) {
		const b = el("div", "rate", text);
		b.dataset.mode = value;
		b.addEventListener("click", () => {
			cfg.banter_mode = value;
			paintMode();
		});
		modeGrp.appendChild(b);
	}
	modeRow.appendChild(modeGrp);
	look.appendChild(modeRow);
	paintMode();

	const flags = document.getElementById("flags");
	flags.innerHTML = "";
	for (const [key, label] of FLAGS) {
		const on = () => (key === "show_chip" ? cfg[key] === true : cfg[key] !== false);
		const b = el("div", "flag" + (on() ? " on" : ""), label);
		b.addEventListener("click", () => {
			cfg[key] = !on();
			b.classList.toggle("on", on());
		});
		flags.appendChild(b);
	}

	overview();
}

/**
 * 「今日概览」区：日薪 / 时薪 / 每秒 / 加班时薪 / 加班时段。
 * 除「时薪」「每秒」是全天恒定的派生量外，其余都按「今天」这个日期算
 * （日薪跟今天的上班日判定走、加班时段跟今天的加班窗口走），所以标题写「今日」。
 * 前四行是绿字（基本工资），加班时薪与加班时段是蓝字（加班相关），
 * 当天加班费不单独占行，直接跟在日薪后面（绿 + 蓝 同一行）。
 * 数字全部由 core.snapshot 算出来 —— 与看板、与冒钱共用同一份口径，
 * 设置页从此不可能再跟桌宠对不上账。
 */
function overview() {
	const now = new Date();
	const box = document.getElementById("ov");
	box.innerHTML = "";
	const model = Core.deriveModel(cfg);
	const snap = Core.snapshot(model, now);
	// 记下这次是按哪一天算的，供 tickDay() 判断是否跨零点。
	lastOvYmd = dayKey(now);

	const GREEN = "#3ad17f";
	const BLUE = "#5b9cff";

	/** 一行：绿字主值。extra 有值时在同一个格子里追加一段蓝字（如「日薪 + 加班费」）。 */
	const putMoney = (key, main, extra) => {
		box.appendChild(el("div", "k", key));
		const val = el("div", "v");
		const a = document.createElement("span");
		a.textContent = "¥" + Core.money(main);
		a.style.color = GREEN;
		val.appendChild(a);
		if (extra != null && extra > 0.005) {
			const b = document.createElement("span");
			b.textContent = " +¥" + Core.money(extra);
			b.style.color = BLUE;
			val.appendChild(b);
		}
		box.appendChild(val);
	};
	/** 一行纯文字：color 决定绿/蓝。 */
	const putText = (key, text, color) => {
		box.appendChild(el("div", "k", key));
		const val = el("div", "v", text);
		val.style.color = color;
		box.appendChild(val);
	};

	// 排版：绿色（基础工资）在上，蓝色（加班相关）在下。
	//   日薪 ¥459.77 +¥212.20   ← 加班费直接跟在日薪后面，不单独占一行
	//   时薪 ¥70.73
	//   每秒 ¥0.0196
	//   加班时薪 ¥106.10        ← 倍率 × 时薪，是加班那一小时的**全部**所得
	//   加班时段 19:00→21:00
	// 注意「加班时薪」不能和「时薪」相加：106.10 里已经含了 1 倍底薪。
	putMoney("日薪", snap.dayBase, snap.dayOt);
	putMoney("时薪", model.perHour);
	putText("每秒", "¥" + model.perSec.toFixed(4), GREEN);
	if (snap.otWindowValid) putText("加班时薪", "¥" + Core.money(model.perHour * snap.otRate), BLUE);
	putText("加班时段", snap.otWindowValid ? hhmm(snap.otStartMin) + "→" + hhmm(snap.otEndMin) : "今日不宜加班", BLUE);
}

function say(text) {
	document.getElementById("msg").textContent = text || "";
}

async function save() {
	// 校验规则与文案都在 core.validateConfig 里，宿主 POST /config 用的是同一份 ——
	// 改规则只需要改一处，两端不可能给出互相矛盾的提示。
	const problem = Core.validateConfig(cfg);
	if (problem) {
		say(problem);
		return;
	}
	try {
		const r = await S.apply({ ...cfg });
		if (r && r.error) {
			say("保存失败：" + r.error);
			return;
		}
		say("");
		window.close();
	} catch (e) {
		say("保存失败：" + (e && e.message ? e.message : e));
	}
}

window.addEventListener("DOMContentLoaded", async () => {
	try {
		const r = await S.req("GET", "/config");
		if (r && r.config) cfg = { ...DEFAULT, ...r.config };
		const verEl = document.getElementById("ver");
		const ver = (S.getVersion && S.getVersion()) || (r && r.appVersion) || "";
		if (verEl && ver) verEl.textContent = "v" + ver;
	} catch (e) {
		say("读取配置失败，显示的是默认值。");
	}
	build();

	document.getElementById("close").addEventListener("click", () => window.close());
	document.getElementById("btn-cancel").addEventListener("click", () => window.close());
	document.getElementById("btn-save").addEventListener("click", save);
	document.getElementById("btn-reset").addEventListener("click", () => {
		const keep = { work_weekdays: cfg.work_weekdays, overtime_weekdays: cfg.overtime_weekdays };
		cfg = { ...DEFAULT, ...keep };
		build();
		say("已恢复默认值，点「保存」生效。");
	});
	window.addEventListener("keydown", (e) => {
		if (e.key === "Escape") window.close();
	});

	// 每 30 秒看一眼日期。跨零点时重算「今日概览」，其余时候立即返回，
	// 不碰 DOM（所以不会跟用户正在调的值抢刷新）。
	setInterval(tickDay, 30000);
});
