/*
 * dsh-star-pet · 预加载桥
 * 渲染端只能用这里列出的能力；不开放 require / node 原语。
 */
const { contextBridge, ipcRenderer } = require("electron");

const api = {
	boot(cb) {
		ipcRenderer.on("pet:boot", (_e, payload) => cb(payload));
	},
	onFlip(cb) {
		ipcRenderer.on("pet:flip", (_e, payload) => cb(payload));
	},
	onDragged(cb) {
		ipcRenderer.on("pet:dragged", (_e, payload) => cb(payload));
	},
	/** true = 整窗点击穿透（指针不在宠物/面板上时） */
	ignore(flag) {
		ipcRenderer.send("pet:ignore", !!flag);
	},
	dragStart() {
		ipcRenderer.send("pet:drag-start");
	},
	/** 相对按下点的位移（DIP）；渲染端每个 pointermove 发一次，不轮询 */
	dragMove(dx, dy) {
		ipcRenderer.send("pet:drag-move", { dx, dy });
	},
	dragEnd() {
		ipcRenderer.send("pet:drag-end");
	},
	menu(payload) {
		return ipcRenderer.invoke("pet:menu", payload || {});
	},
	menuClose() {
		ipcRenderer.send("pet:menu-close");
	},
	/** 菜单切换到「大小」子面板后按内容重设窗口高度 */
	menuResize(height) {
		ipcRenderer.send("pet:menu-resize", { height });
	},
	/** 写回配置（右键菜单里的字体/大小/吸附都走这里） */
	apply(patch) {
		return ipcRenderer.invoke("pet:apply", patch || {});
	},
	/** 读宿主（GET /config、GET /state 等） */
	req(method, path, body) {
		return ipcRenderer.invoke("pet:request", { method, path, body });
	},
	openSettings() {
		ipcRenderer.send("pet:open-settings");
	},
	resize(size) {
		ipcRenderer.send("pet:resize", size);
	},
	quit() {
		ipcRenderer.send("pet:quit");
	},
};

contextBridge.exposeInMainWorld("starPet", api);
