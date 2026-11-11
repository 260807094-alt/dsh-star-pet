/*
 * dsh-star-pet · 右键菜单 / 大小二级面板
 * 与 workpet.py 的 _popup_menu / _popup_sizes 同构：
 *   字体（软萌体/普通）· 大小 · 面板显示 · 贴边吸附 · 加班 · 设置 · 退出
 * 选中后立即写回配置，主窗 250ms 轮询会自动跟上。
 */
const S = window.starPet;
const Core = window.StarPetCore;
const kind = (() => {
	const k = new URLSearchParams(location.search).get("kind");
	return k === "sizes" || k === "panel" ? k : "menu";
})();

let cfg = {};
let softOk = true;

function close() {
	S.menuClose();
	window.close();
}

async function loadConfig() {
	try {
		const r = await S.req("GET", "/config");
		cfg = (r && r.config) || {};
	} catch (e) {
		cfg = {};
	}
	// 软萌体是否可用：必须先 load()，否则 check() 在字体尚未解析时恒为 false
	try {
		await document.fonts.load('12px "StarPetSoft"');
		softOk = document.fonts.check('12px "StarPetSoft"');
	} catch (e) {
		softOk = false;
	}
	document.documentElement.style.setProperty("--pet-font", cfg.soft_font !== false ? '"StarPetSoft","Microsoft YaHei",sans-serif' : '"Microsoft YaHei","Segoe UI",sans-serif');
}

function itemRow(text, kindCls, onClick) {
	const row = document.createElement("div");
	row.className = "row" + (kindCls ? " " + kindCls : "");
	row.textContent = text;
	if (kindCls === "on" || kindCls === "off") {
		const mark = document.createElement("span");
		mark.className = "mark";
		mark.textContent = kindCls === "on" ? "✓" : "○";
		row.appendChild(mark);
	}
	row.addEventListener("click", async (e) => {
		e.stopPropagation();
		await onClick();
	});
	return row;
}

async function buildMenu() {
	const items = document.getElementById("items");
	items.innerHTML = "";
	items.style.display = "";
	document.getElementById("sizes").style.display = "none";
	document.getElementById("panelView").style.display = "none";

	const softOn = cfg.soft_font !== false && softOk;
	const fontLabel = softOk ? (softOn ? "字体：软萌体" : "字体：普通") : "字体：普通（缺字体文件）";
	items.appendChild(
		itemRow(fontLabel, softOn ? "on" : "off", async () => {
			if (!softOk) return close();
			await S.apply({ soft_font: !softOn });
			close();
		})
	);
	items.appendChild(
		itemRow("大小", "size", async () => {
			await buildSizes();
		})
	);
	items.appendChild(
		itemRow("面板显示", "panel", async () => {
			await buildPanelToggles();
		})
	);
	items.appendChild(
		itemRow("贴边吸附", cfg.snap_enabled !== false ? "on" : "off", async () => {
			await S.apply({ snap_enabled: cfg.snap_enabled === false });
			close();
		})
	);
	items.appendChild(
		itemRow("加班", cfg.overtime_enabled === true ? "on" : "off", async () => {
			await S.apply({ overtime_enabled: cfg.overtime_enabled !== true });
			close();
		})
	);
	items.appendChild(
		itemRow("设置", null, async () => {
			S.openSettings();
			close();
		})
	);
	items.appendChild(
		itemRow("退出", null, async () => {
			S.quit();
		})
	);
}

async function buildSizes() {
	const box = document.getElementById("sizes");
	document.getElementById("items").style.display = "none";
	document.getElementById("panelView").style.display = "none";
	box.style.display = "grid";
	box.innerHTML = "";

	const title = document.createElement("div");
	title.className = "title";
	title.textContent = "大小";
	box.appendChild(title);

	const cur = Number.isInteger(cfg.pet_size_index) ? cfg.pet_size_index : Core.PET_SIZE_INDEX;
	Core.PET_SIZES.forEach((px, i) => {
		const cell = document.createElement("div");
		cell.className = "cell" + (i === cur ? " on" : "");
		cell.textContent = String(px);
		cell.addEventListener("click", async (e) => {
			e.stopPropagation();
			await S.apply({ pet_size_index: i });
			close();
		});
		box.appendChild(cell);
	});
	// 3×3 网格比 5 行菜单更矮，按内容把窗口收一下
	try {
		if (S && typeof S.menuResize === 'function') S.menuResize(document.getElementById('body').scrollHeight + 2);
	} catch (e) {
		/* 忽略：拿不到高度就保持原尺寸 */
	}
}

/** 「面板显示」五个开关：与「大小」面板同款格子。
 *  点一下立即生效并原地刷新，不关窗口 —— 方便连着调几个。
 *  每个开关的提交函数都写死字面量键（test/audit.cjs 靠这个扫 UI 入口）。 */
const PANEL_TOGGLES = [
	["show_perhour", "时薪", (v) => S.apply({ show_perhour: v })],
	["show_daybase", "日薪", (v) => S.apply({ show_daybase: v })],
	["show_monthearned", "本月已赚", (v) => S.apply({ show_monthearned: v })],
	["show_pouch", "窝囊费", (v) => S.apply({ show_pouch: v })],
	["show_monthremain", "本月还可赚", (v) => S.apply({ show_monthremain: v })],
];

async function buildPanelToggles() {
	const box = document.getElementById("panelView");
	document.getElementById("items").style.display = "none";
	document.getElementById("sizes").style.display = "none";
	box.style.display = "grid";
	box.innerHTML = "";

	const title = document.createElement("div");
	title.className = "title";
	title.textContent = "面板显示";
	box.appendChild(title);

	for (const [key, label, submit] of PANEL_TOGGLES) {
		const on0 = cfg[key] !== false;
		const cell = document.createElement("div");
		cell.className = "cell " + (on0 ? "on" : "off");
		cell.textContent = label;
		const mark = document.createElement("span");
		mark.className = "mark";
		mark.textContent = on0 ? "✓" : "○";
		cell.appendChild(mark);
		cell.addEventListener("click", async (e) => {
			e.stopPropagation();
			const next = cfg[key] === false; // 现在是关 → 打开
			const r = await submit(next);
			// 以宿主返回的真实值为准：宿主若不认这个键（版本旧/白名单没含它），
			// 勾就不能翻，否则会出现「看着点上了、面板却没变」的假象。
			const real = r && r.config && typeof r.config[key] === "boolean" ? r.config[key] : next;
			cfg[key] = real;
			cell.className = "cell " + (real ? "on" : "off");
			mark.textContent = real ? "✓" : "○";
			try {
				if (S && typeof S.menuResize === "function") S.menuResize(document.getElementById("body").scrollHeight + 2);
			} catch (err) {
				/* ignore */
			}
		});
		box.appendChild(cell);
	}
	try {
		if (S && typeof S.menuResize === "function") S.menuResize(document.getElementById("body").scrollHeight + 2);
	} catch (e) {
		/* ignore */
	}
}

window.addEventListener("DOMContentLoaded", () => {
	// 先用默认值把行建出来（同步），这样 did-finish-load 量高时 DOM 已经是满的；
	// 配置回来后再重绘一次修正状态。
	render().then(() => {
		loadConfig().then(() => render());
	});
});

async function render() {
	if (kind === "sizes") await buildSizes();
	else if (kind === "panel") await buildPanelToggles();
	else await buildMenu();
	const body = document.getElementById("body");
	if (S && typeof S.menuResize === "function") {
		try {
			S.menuResize(Math.ceil(body.scrollHeight + 2));
		} catch (e) {
			/* ignore */
		}
	}
}

window.addEventListener("keydown", (e) => {
	if (e.key === "Escape") close();
});
// 失焦（点别处）→ 关闭，和 Tk 的 <FocusOut> 一致
window.addEventListener("blur", () => close());
