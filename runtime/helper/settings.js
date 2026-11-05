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
const PET_SIZES = [108, 135, 162, 189, 216, 243, 270, 297, 324];
const WD = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const FLAGS = [
	["snap_enabled", "贴边吸附"],
	["flip_on_left", "贴左镜像"],
	["sound", "点击音效"],
	["show_chip", "胶囊"],
	["roll_numbers", "数字滚动"],
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
	show_float: true,
};

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

/** 对应 Tk 的 _stepper：左侧 10pt 标签，右侧 [− 值 +]。 */
function stepper(host, label, get, set, step, fmt) {
	const row = el("div", "row");
	row.appendChild(el("div", "lab", label));
	const grp = el("div", "grp");
	const minus = el("div", "sbtn", "−");
	const val = el("div", "val", fmt(get()));
	const plus = el("div", "sbtn", "+");
	const sync = () => (val.textContent = fmt(get()));
	minus.addEventListener("click", () => {
		set(Math.max(0, get() - step));
		sync();
	});
	plus.addEventListener("click", () => {
		set(get() + step);
		sync();
	});
	grp.append(minus, val, plus);
	row.appendChild(grp);
	host.appendChild(row);
	return val;
}

function build() {
	document.documentElement.style.setProperty(
		"--pet-font",
		cfg.soft_font !== false ? '"StarPetSoft","Microsoft YaHei",sans-serif' : '"Microsoft YaHei","Segoe UI",sans-serif'
	);

	const pay = document.getElementById("sec-pay");
	pay.innerHTML = "";
	stepper(pay, "月薪", () => Number(cfg.monthly_wage) || 0, (v) => (cfg.monthly_wage = Math.round(v * 100) / 100), 100, (v) => "¥" + Math.round(v).toLocaleString("en-US"), true);
	stepper(pay, "月计薪天数", () => Number(cfg.pay_days_per_month) || 21.75, (v) => (cfg.pay_days_per_month = Math.round(v * 100) / 100), 0.25, (v) => Number(v).toFixed(2));

	const time = document.getElementById("sec-time");
	time.innerHTML = "";
	stepper(time, "上班", () => parse(cfg.work_start, 540), (v) => (cfg.work_start = hhmm(v)), 30, hhmm);
	stepper(time, "下班", () => parse(cfg.work_end, 1020), (v) => (cfg.work_end = hhmm(v)), 30, hhmm);
	stepper(time, "午休开始", () => parse(cfg.lunch_start, 690), (v) => (cfg.lunch_start = hhmm(v)), 15, hhmm);
	stepper(time, "午休", () => Number(cfg.lunch_minutes) || 0, (v) => (cfg.lunch_minutes = Math.min(300, Math.round(v))), 5, durShort);

	const wds = document.getElementById("wds");
	wds.innerHTML = "";
	const wset = new Set((cfg.work_weekdays || [1, 2, 3, 4, 5]).map(Number));
	WD.forEach((name, i) => {
		const b = el("div", "wd" + (wset.has(i + 1) ? " on" : ""), name);
		b.addEventListener("click", () => {
			if (wset.has(i + 1)) wset.delete(i + 1);
			else wset.add(i + 1);
			if (!wset.size) wset.add(i + 1);
			b.classList.toggle("on", wset.has(i + 1));
			cfg.work_weekdays = [...wset].sort((a, c) => a - c);
			overview();
		});
		wds.appendChild(b);
	});

	const look = document.getElementById("sec-look");
	look.innerHTML = "";
	stepper(look, "大小", () => Number(cfg.pet_size_index) || 0, (v) => (cfg.pet_size_index = Math.max(0, Math.min(8, Math.round(v)))), 1, (v) => PET_SIZES[Math.max(0, Math.min(8, Math.round(v)))] + " px");
	stepper(look, "吸附范围", () => Number(cfg.snap_px) || 0, (v) => (cfg.snap_px = Math.max(0, Math.min(200, Math.round(v)))), 2, (v) => Math.round(v) + " px");

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
	const paid = Math.max(0, end - start - lunch);
	const daily = cfg.daily_wage ? Number(cfg.daily_wage) : (Number(cfg.monthly_wage) || 0) / (Number(cfg.pay_days_per_month) || 21.75);
	const perHour = paid > 0 ? daily / (paid / 60) : 0;
	const perSec = paid > 0 ? daily / (paid * 60) : 0;
	const rows = [
		["上班", hhmm(start), "#e8c060"],
		["下班", hhmm(end), "#e8c060"],
		["午休", hhmm(parse(cfg.lunch_start, 690)) + " → " + hhmm(parse(cfg.lunch_start, 690) + lunch), "#e8c060"],
		["计薪", durShort(paid), "#e8c060"],
		["日薪", "¥" + money(daily), "#3ad17f"],
		["时薪", "¥" + money(perHour), "#3ad17f"],
		["每秒", "¥" + perSec.toFixed(4), "#3ad17f"],
	];
	for (const [k, v, color] of rows) {
		box.appendChild(el("div", "k", k));
		const val = el("div", "v", v);
		val.style.color = color;
		box.appendChild(val);
	}
}

function say(text) {
	document.getElementById("msg").textContent = text || "";
}

async function save() {
	if (parse(cfg.work_start, 540) >= parse(cfg.work_end, 1020)) {
		say("下班时间必须晚于上班时间。");
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
		const keep = { work_weekdays: cfg.work_weekdays };
		cfg = { ...DEFAULT, ...keep };
		build();
		say("已恢复默认值，点「保存」生效。");
	});
	window.addEventListener("keydown", (e) => {
		if (e.key === "Escape") window.close();
	});
});
