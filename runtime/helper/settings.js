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
const PET_SIZES = [96, 108, 135];
const WD = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const FLAGS = [
	["snap_enabled", "贴边吸附"],
	["flip_on_left", "贴左镜像"],
	["sound", "点击音效"],
	["show_chip", "胶囊"],
	["show_banter", "吐槽"],
	["show_float", "赚到飘字"],
];

const DEFAULT = {
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
	// ── 加班（默认关闭）：独立时段，不接下班时间
	// 加班日与上班日一样一周七天自己勾
	overtime_enabled: false,
	overtime_weekdays: [1, 2, 3, 4, 5],
	overtime_start_workday: "19:00",
	overtime_end_workday: "21:00",
	overtime_start_weekend: "09:00",
	overtime_end_weekend: "17:00",
	overtime_rate_workday: "1.5",
	overtime_rate_weekend: "2",
	overtime_rate_holiday: "3",
};

/** 加班倍率的按钮：值 → 显示文字。没有「自动」了，三档各配一个。 */
const RATES = [
	["0", "0"],
	["1", "1"],
	["1.5", "1.5"],
	["2", "2"],
	["3", "3"],
];
/** 三档倍率字段 → 设置页里的标签。
 *  标签必须短到一行放得下（窗口内宽只有约 262px，右侧还要排 4 个按钮），
 *  所以「加班 ×倍工资」放在上面的小标题里，这里只写工作日/周末/节假日。 */
const RATE_ROWS = [
	["overtime_rate_workday", "工作日"],
	["overtime_rate_weekend", "周末"],
	["overtime_rate_holiday", "节假日"],
];

let cfg = { ...DEFAULT };

const parse = (s, d) => {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
	return m ? Math.min(1439, +m[1] * 60 + +m[2]) : d;
};
const hhmm = (m) => {
	const v = ((Math.round(m) % 1440) + 1440) % 1440;
	return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
};
/** Tk dur_short：分钟 → "H:MM"。 */
const durShort = (v) => {
	const n = Math.max(0, Math.round(Number(v) || 0));
	const h = Math.floor(n / 60);
	const m = n % 60;
	return h + ":" + String(m).padStart(2, "0");
};
const money = (v) =>
	Number(v) >= 100000
		? Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })
		: Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
function refreshAll() {
	for (const f of _refreshFns) f();
}

function stepper(host, label, get, set, step, fmt, _legacy, min, max) {
	const row = el("div", "row");
	row.appendChild(el("div", "lab", label));
	const grp = el("div", "grp");
	const minus = el("div", "sbtn", "−");
	const val = el("div", "val", fmt(get()));
	const plus = el("div", "sbtn", "+");
	const lo = () => (typeof min === "function" ? min() : typeof min === "number" ? min : 0);
	const hi = () => (typeof max === "function" ? max() : typeof max === "number" ? max : null);
	const refresh = () => {
		const v = get();
		val.textContent = fmt(v);
		minus.classList.toggle("disabled", v <= lo());
		const mx = hi();
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
	stepper(pay, "月薪", () => Number(cfg.monthly_wage) || 0, (v) => (cfg.monthly_wage = Math.round(v * 100) / 100), 100, (v) => "¥" + Math.round(v).toLocaleString("en-US"), true);
	// 月计薪天数：1 ~ 30（一个月最多 30 天，30 天 = 不扣周末，全月算薪）。
	// 最小值 1 与 lib/index.js sanitizePatch 的 Math.max(1, ...) 对齐。
	// 读取用「1~30 才采用」，不能用 `|| 21.75`——那样按到 0 会当场跳回 21.75。
	const payDaysGet = () => {
		const v = Number(cfg.pay_days_per_month);
		return Number.isFinite(v) && v >= 1 ? Math.min(30, v) : 21.75;
	};
	stepper(pay, "月计薪天数", payDaysGet, (v) => (cfg.pay_days_per_month = Math.max(1, Math.min(30, Math.round(v * 100) / 100))), 0.25, (v) => Number(v).toFixed(2), null, 1, 30);

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
	stepper(time, "上班", workStart, (v) => (cfg.work_start = hhmm(v)), 15, hhmm, null, 0, () => Math.min(workEnd() - 15, lunchStart()));
	stepper(time, "下班", workEnd, (v) => (cfg.work_end = hhmm(v)), 15, hhmm, null, () => Math.max(workStart() + 15, lunchStart() + lunchMin()), () => Math.min(1439, otWStart()));
	stepper(time, "午休开始", lunchStart, (v) => (cfg.lunch_start = hhmm(v)), 15, hhmm, null, () => workStart(), () => workEnd() - lunchMin());
	stepper(time, "午休", lunchMin, (v) => (cfg.lunch_minutes = Math.min(300, Math.round(v))), 15, durShort, null, 0, () => Math.min(300, workEnd() - lunchStart()));

	const wds = document.getElementById("wds");
	const ot = document.getElementById("sec-ot");
	ot.innerHTML = "";
	// 开关在右键菜单里（默认关闭）；这里管「加班日 + 时段 + 三档倍率」
	// 加班日：与上班日一样七天自选
	ot.appendChild(el("div", "note", "加班日"));
	const otDaysWrap = el("div", "wds");
	const wset = new Set((cfg.work_weekdays || [1, 2, 3, 4, 5]).map(Number));
	const otSet = new Set((cfg.overtime_weekdays || [1, 2, 3, 4, 5]).map(Number));

	// 上班日 / 加班日里，周六(6)、周日(7)互斥：同一天不能既上班又加班。
	// 未选中且对方已选中 → 该格变灰不可点；已选中则永远可点（能取消），
	// 避免「两边都选中」的旧数据卡死无法解除。周一到周五不互斥（工作日晚上加班很正常）。
	const renderWorkDays = () => {
		wds.innerHTML = "";
		WD.forEach((name, i) => {
			const day = i + 1;
			const conflict = !wset.has(day) && (day === 6 || day === 7) && otSet.has(day);
			const b = el("div", "wd" + (wset.has(day) ? " on" : "") + (conflict ? " disabled" : ""), name);
			b.addEventListener("click", () => {
				if (conflict) return;
				if (wset.has(day)) wset.delete(day);
				else wset.add(day);
				if (!wset.size) wset.add(day);
				cfg.work_weekdays = [...wset].sort((a, c) => a - c);
				renderWorkDays();
				renderOtDays();
				overview();
			});
			wds.appendChild(b);
		});
	};
	const renderOtDays = () => {
		otDaysWrap.innerHTML = "";
		WD.forEach((name, i) => {
			const day = i + 1;
			const conflict = !otSet.has(day) && (day === 6 || day === 7) && wset.has(day);
			const b = el("div", "wd" + (otSet.has(day) ? " on" : "") + (conflict ? " disabled" : ""), name);
			b.addEventListener("click", () => {
				if (conflict) return;
				if (otSet.has(day)) otSet.delete(day);
				else otSet.add(day);
				if (!otSet.size) otSet.add(day);
				cfg.overtime_weekdays = [...otSet].sort((a, c) => a - c);
				renderWorkDays();
				renderOtDays();
				overview();
			});
			otDaysWrap.appendChild(b);
		});
	};

	renderWorkDays();
	ot.appendChild(otDaysWrap);
	renderOtDays();

	// 上班日加班开始最早 = max(17:00, 下班)；结束最晚 23:59。
	// 非上班日加班开始最早 05:00；结束最晚 23:59。
	stepper(ot, "上班日加班开始", otWStart, (v) => (cfg.overtime_start_workday = hhmm(v)), 15, hhmm, null, () => Math.max(1020, workEnd()), () => otWEnd() - 15);
	stepper(ot, "上班日加班结束", otWEnd, (v) => (cfg.overtime_end_workday = hhmm(v)), 15, hhmm, null, () => otWStart() + 15, 1439);
	stepper(ot, "非上班日加班开始", otRStart, (v) => (cfg.overtime_start_weekend = hhmm(v)), 15, hhmm, null, 300, () => otREnd() - 15);
	stepper(ot, "非上班日加班结束", otREnd, (v) => (cfg.overtime_end_weekend = hhmm(v)), 15, hhmm, null, () => otRStart() + 15, 1439);

	// 加班 ×倍工资：工作日 / 周末 / 节假日 三行，各自 0 / 1.5 / 2 / 3
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

function overview() {
	const box = document.getElementById("ov");
	box.innerHTML = "";
	const start = parse(cfg.work_start, 540);
	const end = parse(cfg.work_end, 1020);
	const lunch = Math.max(0, Number(cfg.lunch_minutes) || 0);
	const lunchStart = parse(cfg.lunch_start, 690);
	// 只扣真正落在上下班区间内的午休（与 renderer.js 的 computeState 保持一致）。
	const lunchOverlap = Math.max(0, Math.min(end, lunchStart + lunch) - Math.max(start, lunchStart));
	const paid = Math.max(0, end - start - lunchOverlap);
	// 与 renderer.js computeState 保持一致：只有「月薪没填」才回退 10000，
	// 填 0 就是 0（否则设置页显示 ¥0、看板却按 1 万冒钱）。
	const monthlyFilled = cfg.monthly_wage != null && String(cfg.monthly_wage).trim() !== "";
	const monthly = monthlyFilled ? Math.max(0, Number(cfg.monthly_wage) || 0) : 10000;
	const payDaysOf = () => {
		const v = Number(cfg.pay_days_per_month);
		return Number.isFinite(v) && v >= 1 ? Math.min(30, v) : 21.75;
	};
	const daily = cfg.daily_wage ? Number(cfg.daily_wage) : monthly / payDaysOf();
	const perHour = paid > 0 ? daily / (paid / 60) : 0;
	const perSec = paid > 0 ? daily / (paid * 60) : 0;
	// 概览只列「钱」和「加班」：上班/下班/午休/计薪 在「时间」分区里已经有了，
	// 这里再列一遍会把窗口撑到需要滚动（工作区上限 992，窗口最多约 968 高）。
	const rows = [
		["日薪", "¥" + money(daily), "#3ad17f"],
		["时薪", "¥" + money(perHour), "#3ad17f"],
		["每秒", "¥" + perSec.toFixed(4), "#3ad17f"],
	];
	// 「加班时段」这一行永远显示；只有「开了加班且今天是加班日」才显示具体时段，
	// 否则一律「今日不宜加班」。值是按今天实际生效的那一对时段（上班日走上班日那对，非上班日走另一对）。
	const otStartWorkday = parse(cfg.overtime_start_workday, 1140);
	const otEndWorkday = parse(cfg.overtime_end_workday, 1260);
	const otStartWeekend = parse(cfg.overtime_start_weekend, 540);
	const otEndWeekend = parse(cfg.overtime_end_weekend, 1020);
	// 今日倍率：与 renderer.js 的 isWorkday 完全一致 —— 补班日优先、节假日放假、
	// 其余按上班日。之前只看 work_weekdays，漏了节假日/补班日，导致概览和
	// 看板对「今天到底是上班日还是休息日、该用哪档倍率」判断不一致。
	const now = new Date();
	const dow = now.getDay() === 0 ? 7 : now.getDay();
	const wset = new Set((cfg.work_weekdays || [1, 2, 3, 4, 5]).map(Number));
	const holSet = new Set((cfg.holidays || []).map(String));
	const extraSet = new Set((cfg.extra_workdays || []).map(String));
	const ds =
		now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
	const holidayToday = holSet.has(ds) && !extraSet.has(ds);
	const workdayToday = extraSet.has(ds) ? true : (holidayToday ? false : wset.has(dow));
	const rateKey = workdayToday
		? "overtime_rate_workday"
		: holidayToday
			? "overtime_rate_holiday"
			: "overtime_rate_weekend";
	const todayRate = Math.max(0, Number(cfg[rateKey]) || 0);
	const spanFrom = workdayToday ? otStartWorkday : otStartWeekend;
	const spanTo = workdayToday ? otEndWorkday : otEndWeekend;
	// 今天是不是加班日（和上班日各自独立选）
	const oset = new Set((cfg.overtime_weekdays || [1, 2, 3, 4, 5]).map(Number));
	const otDayToday = oset.has(dow);
	// 只有「开了加班 + 今天是加班日 + 时段写反不算」才显示具体加班时段，否则今日不宜加班
	const otActive = cfg.overtime_enabled === true && otDayToday && spanTo > spanFrom;
	rows.push(["加班时段", otActive ? hhmm(spanFrom) + "→" + hhmm(spanTo) : "今日不宜加班", "#5b9cff"]);
	if (otActive) {
		// 蓝色追加的是「差价」：时薪 × (倍率 − 1)，只显示纯加班费。
		// 倍率 ≤ 1 时差价为 0，就不在日薪/时薪里追加蓝色加班费。
		const otPerHour = perHour * Math.max(0, todayRate - 1);
		// 加班有效时长（分钟）：扣掉落在加班窗口里的午休。
		// 与看板「窝囊费」同口径 —— 窝囊费就是加班工资，不含基本工资、不含午休。
		const lunchStartMin = parse(cfg.lunch_start, 690);
		const lunchEndMin = lunchStartMin + lunch;
		const lunchIn = (a, b) => Math.max(0, Math.min(b, lunchEndMin) - Math.max(a, lunchStartMin));
		const otSpanMin = Math.max(0, spanTo - spanFrom - lunchIn(spanFrom, spanTo));
		// 加班工资 = 时薪 × (倍率 − 1) × 加班时长：只算「比正常工资多出来的部分」。
		// 倍率 1 一分不多 = ¥0.00；倍率 2 多赚一份；倍率 3 多赚两份。
		const otDaily = perHour * Math.max(0, todayRate - 1) * otSpanMin / 60;
		// 只有真有多赚出来的钱才追加蓝字（倍率 1 时加班工资是 0，不显示 "+ ¥0.00"）。
		const otAdd = otDaily > 0.005 ? "  <span style=\"color:#5b9cff\">+ ¥" + money(otDaily) + "</span>" : "";
		const otHourAdd = otPerHour > 0.005 ? "  <span style=\"color:#5b9cff\">+ ¥" + money(otPerHour) + "</span>" : "";
		rows[0][1] = "¥" + money(daily) + otAdd;
		rows[1][1] = "¥" + money(perHour) + otHourAdd;
	}
	for (const [k, v, color] of rows) {
		box.appendChild(el("div", "k", k));
		const val = el("div", "v");
		val.style.color = color;
		// 概览值可能带 <span>（蓝色追加加班费），用 innerHTML；纯文本行不含 HTML 字符，同样安全。
		val.innerHTML = v;
		box.appendChild(val);
	}
}

function say(text) {
	document.getElementById("msg").textContent = text || "";
}

async function save() {
	// 完整时间链（无论加班开关开或关都校验）：
	//   00:00 ≤ 上班 ≤ 午休开始 ≤ 午休结束 ≤ 下班 ≤ 上班日加班开始 < 加班结束 ≤ 23:59（且加班开始 ≥ 17:00）
	//   非上班日：05:00 ≤ 加班开始 < 加班结束 ≤ 23:59
	const ws = parse(cfg.work_start, 540);
	const we = parse(cfg.work_end, 1020);
	const ls = parse(cfg.lunch_start, 690);
	const lm = Number(cfg.lunch_minutes) || 0;
	const le = ls + lm;
	if (we <= ws) {
		say("下班时间必须晚于上班时间。");
		return;
	}
	if (ls < ws) {
		say("午休开始不能早于上班时间。");
		return;
	}
	if (le > we) {
		say("午休结束（午休开始 + 午休时长）不能晚于下班时间。");
		return;
	}
	const otWS = parse(cfg.overtime_start_workday, 1140);
	const otWE = parse(cfg.overtime_end_workday, 1260);
	if (otWS < 1020) {
		say("上班日加班开始不能早于 17:00。");
		return;
	}
	if (otWS < we) {
		say("上班日加班开始必须晚于下班时间。");
		return;
	}
	if (otWE <= otWS) {
		say("上班日加班结束必须晚于开始。");
		return;
	}
	const otRS = parse(cfg.overtime_start_weekend, 540);
	const otRE = parse(cfg.overtime_end_weekend, 1020);
	if (otRS < 300) {
		say("非上班日加班开始不能早于 05:00。");
		return;
	}
	if (otRE <= otRS) {
		say("非上班日加班结束必须晚于开始。");
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
});
