/*
 * dsh-star-pet · 左侧栏「困困星人」图标
 *
 * 图标：点一下开启桌面宠物，再点一下关闭（图标自己吞掉点击，不切面板）。
 * 文字：侧栏会 selectPanel(key)，所以额外注册一个空的 main 面板接住这次
 *      选中，挂载时立刻 selectPanel(null) 切回会话并切换桌宠 —— 行为与点
 *      图标一致，且不会留下空白页面。
 */
function makeFactory() {
	return (require) => {
		const { useCallback, useEffect, useRef, useState } = require("react");
		const jsxRuntime = require("react/jsx-runtime");

		/** jsx(type, props, key) 的第三个参数是 key，不是子节点。包一层支持 createElement 风格子节点。 */
		const h = function (type, props) {
			const rest = Array.prototype.slice.call(arguments, 2);
			const hasKey = props != null && Object.prototype.hasOwnProperty.call(props, "key");
			const key = hasKey ? props.key : undefined;
			let next = props;
			if (hasKey || rest.length) {
				next = Object.assign({}, props || {});
				if (hasKey) delete next.key;
				if (rest.length) next.children = rest.length === 1 ? rest[0] : rest;
			}
			return jsxRuntime.jsx(type, next, key);
		};

		const KEY = "star-pet";
		const BASE = "/dsh-star-pet";

		function api(path, init) {
			const opts = Object.assign({ cache: "no-store" }, init || {});
			if (opts.body && typeof opts.body !== "string") {
				opts.headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});
				opts.body = JSON.stringify(opts.body);
			}
			return fetch(BASE + path, opts).then((r) => {
				if (!r.ok) throw new Error("HTTP " + r.status);
				return r.json();
			});
		}

		const CSS = `
.sp-icon{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;height:100%;line-height:0;cursor:default;transition:opacity .18s ease,filter .18s ease}
.sp-icon[data-on="0"]{opacity:.5;filter:grayscale(.75)}
.sp-icon[data-on="1"]{opacity:1;filter:none}
.sp-icon[data-busy="1"]{opacity:.35}
.sp-icon svg{display:block;pointer-events:none}
`;
		function installCss() {
			if (document.getElementById("dsh-star-pet-css")) return;
			const el = document.createElement("style");
			el.id = "dsh-star-pet-css";
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		/** 一颗带小脸的黄星星 —— 和桌宠本体同一套配色。 */
		function StarIcon(props) {
			const size = props && typeof props.size === "number" ? props.size : 22;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 24 24", fill: "none" },
				h("path", {
					key: "body",
					d: "M12 2.6l2.62 5.9 6.38.62-4.82 4.24 1.4 6.28L12 16.5l-5.58 3.14 1.4-6.28L3 9.12l6.38-.62L12 2.6z",
					fill: "#f6c445",
					stroke: "#c8931f",
					strokeWidth: 1.1,
					strokeLinejoin: "round"
				}),
				h("circle", { key: "e1", cx: 10.1, cy: 11.4, r: 0.95, fill: "#3a2a10" }),
				h("circle", { key: "e2", cx: 13.9, cy: 11.4, r: 0.95, fill: "#3a2a10" }),
				h("path", {
					key: "mouth",
					d: "M10.7 13.5c.8.75 1.8.75 2.6 0",
					stroke: "#3a2a10",
					strokeWidth: 0.9,
					strokeLinecap: "round"
				}),
				h("circle", { key: "c1", cx: 8.3, cy: 13.2, r: 0.85, fill: "#f79a9a", opacity: 0.85 }),
				h("circle", { key: "c2", cx: 15.7, cy: 13.2, r: 0.85, fill: "#f79a9a", opacity: 0.85 })
			);
		}

		/** 侧栏图标：点击切换桌宠显隐，点击事件不外传（不然侧栏会切到空的 main 面板）。 */
		function StarPetIcon(props) {
			const size = props && typeof props.size === "number" ? props.size : 22;
			// 图标亮 = 桌宠正在显示；灭 = 进程不在或已收起。
			const [shown, setShown] = useState(false);
			const [busy, setBusy] = useState(false);
			const alive = useRef(true);

			useEffect(
				() => () => {
					alive.current = false;
				},
				[]
			);

			useEffect(() => {
				let timer = 0;
				const poll = () => {
					api("/pet/state")
						.then((s) => {
							if (alive.current) setShown(!!s && s.running === true && s.visible !== false);
						})
						.catch(() => {})
						.then(() => {
							if (alive.current) timer = setTimeout(poll, 4000);
						});
				};
				poll();
				return () => {
					clearTimeout(timer);
				};
			}, []);

			const toggle = useCallback(
				(ev) => {
					if (ev) {
						ev.preventDefault();
						ev.stopPropagation();
					}
					if (busy) return;
					setBusy(true);
					togglePet()
						.then((r) => {
							if (!alive.current || !r) return;
							const running = r.running === true;
							setShown(running && r.visible !== false);
						})
						.catch(() => {})
						.then(() => {
							if (alive.current) setBusy(false);
						});
				},
				[busy]
			);

			return h(
				"div",
				{
					className: "sp-icon",
					"data-sp-icon": "1",
					"data-on": shown ? "1" : "0",
					"data-busy": busy ? "1" : "0",
					title: shown ? "困困星人：点击收起桌宠" : "困困星人：点击唤出桌宠",
					onClick: toggle
				},
				h(StarIcon, { size })
			);
		}

		function apply(ctx) {
			installCss();
			installRowGuard(ctx);
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{ name: "sidebar.panellist", id: KEY, order: 16, label: () => "困困星人" },
					(props) => h(StarPetIcon, { size: props && typeof props.size === "number" ? props.size : void 0 })
				)
			);
			// 侧栏那一行文字（「困困星人」）的点击由侧栏自己处理：它会 selectPanel(key)。
			// 没有同名 main 面板时 selectPanel 会抛错、什么都不发生 —— 就是"点文字没反应"。
			// 所以注册一个空面板：一挂载就切回会话，顺便切换桌宠，文字和图标就等价了。
			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: KEY }, () => {
					const done = useRef(false);
					useEffect(() => {
						if (done.current) return;
						done.current = true;
						// 先切桌宠：即使下面这次面板切换要继续几秒，手感也是即时的
						togglePet();
						// 再延后切回会话，避免和 React 本次提交抢同一帧
						setTimeout(() => {
							try {
								// 惰性取 + 可选链：layout 没就绪时跳过这一步，只切换桌宠。
								// 与 skill-explorer / archive-manager 的写法一致，避免把 layout
								// 变成启动硬依赖（那会让 fiber 在页面重建时卡在 loading）。
								ctx.get?.("layout")?.selectPanel?.(null);
							} catch (e) {
								/* 拿不到 layout 就只切换桌宠 */
							}
						}, 0);
					}, []);
					return null;
				})
			);
		}

		/**
		 * 唯一的开关语义：显示 / 收起。
		 * 进程常驻，窗口只是 show/hide，所以是瞬时的；只有从没起过才真的冷启动。
		 * 宿主 /pet/visible 收到 visible:true 时若进程不在会自动拉起，所以这里只需一个布尔。
		 */
		function togglePet() {
			return api("/pet/state")
				.then((s) => {
					const running = !!(s && s.running);
					const visible = running && s.visible !== false;
					const want = !visible;
					// 旧宿主没有 /pet/visible 时退回启停（慢但不会失灵）
					return api("/pet/visible", { method: "POST", body: { visible: want } }).catch(() =>
						api(want ? "/pet/start" : "/pet/stop", { method: "POST" })
					);
				})
				.catch(() => {});
		}

		/**
		 * 侧栏那一行 = 面板选择器：点整行（含文字）会 selectPanel(key)，把会话视图换下去再换回来。
		 * 我们只需要「点一下开关桌宠」，不需要切面板 —— 所以在**行的捕获阶段**拦掉这次点击：
		 * 侧栏自己的（冒泡）处理器就收不到了，会话完全不参与，响应是毫秒级。
		 * 图标自己另有 onClick，这里跳过图标内部，避免切两次。
		 */
		function installRowGuard(ctx) {
			if (window.__dshStarPetRowGuard) return;
			window.__dshStarPetRowGuard = true;
			const LABEL = "困困星人";

			const findRow = (iconEl) => {
				let el = iconEl;
				for (let i = 0; i < 8 && el; i += 1) {
					el = el.parentElement;
					if (!el) return null;
					const text = (el.textContent || "").trim();
					if (text.indexOf(LABEL) >= 0) return el;
				}
				return null;
			};

			const bind = () => {
				const iconEl = document.querySelector('[data-sp-icon="1"]');
				if (!iconEl) return;
				const row = findRow(iconEl);
				if (!row || row.getAttribute("data-sp-row") === "1") return;
				row.setAttribute("data-sp-row", "1");
				row.addEventListener(
					"click",
					(ev) => {
						if (iconEl.contains(ev.target)) return;
						ev.preventDefault();
						ev.stopPropagation();
						togglePet();
					},
					true
				);
				row.addEventListener(
					"keydown",
					(ev) => {
						if (ev.key !== "Enter" && ev.key !== " ") return;
						if (iconEl.contains(ev.target)) return;
						ev.preventDefault();
						ev.stopPropagation();
						togglePet();
					},
					true
				);
			};

			bind();
			// 侧栏可能因为切换面板/重排序而重建这一行，重建后再绑一次。
			// 宿主 DOM 变动很频繁，这里按帧合并（rAF），避免每次 DOM 变更都跑一遍 querySelector。
			try {
				let queued = false;
				const mo = new MutationObserver(() => {
					if (queued) return;
					queued = true;
					const run = () => {
						queued = false;
						bind();
					};
					if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
					else setTimeout(run, 16);
				});
				mo.observe(document.body, { childList: true, subtree: true });
				// 插件卸载时断开，避免观察器在文档上一直挂着
				try {
					ctx?.effect?.(() => () => mo.disconnect());
				} catch (e) {
					/* 没有 effect 就让它挂着（进程退出时随之销毁） */
				}
			} catch (e) {
				/* 没有 MutationObserver 就只绑一次 */
			}
		}

		// 只声明 slots：layout 在真正要用时用 ctx.get("layout") 惰性取（见上面的 main 面板）。
		// 把它写进 inject 会让宿主在启动时等它、并在页面重建时因它的 uid 变化反复重载本插件，
		// 一旦重载循环没能收敛，fiber 就停在 loading，宿主会抛 "web boot: 1 entry did not activate"。
		const inject = ["slots"];
		const name = "star-pet";
		return { apply, inject, name };
	};
}

if (window.__ModuleLoader__) {
	window.__ModuleLoader__.load({ id: "dsh-star-pet", factory: makeFactory() });
}
