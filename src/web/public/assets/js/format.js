export const PHASE_LABELS = {
	idle: "未开始",
	intake: "接收剧本",
	script_analysis: "剧本分析",
	script_gate: "剧本确认",
	design: "企划",
	cast: "角色设计",
	character_images: "角色立绘",
	cast_gate: "角色确认",
	storyboard: "分镜",
	storyboard_gate: "分镜确认",
	prompts: "提示词",
	image_gen: "出图中",
	qa: "审校",
	repair: "修复",
	build: "导出",
	final_gate: "成品确认",
	export: "导出",
	done: "完成",
	paused: "已暂停",
	error: "出错",
};

export const ROLE_LABELS = {
	protagonist: "主角",
	antagonist: "反派",
	supporting: "配角",
};

export function statusText(snapshot) {
	if (!snapshot) return "";
	const stats = snapshot.stats || {};
	const characters = snapshot.characters || [];
	const phase = PHASE_LABELS[snapshot.phase] || snapshot.phase || "未知";
	const ready = characters.filter((item) => item.version > 0).length;
	const cast = characters.length ? ` · 角色 ${ready}/${characters.length}` : "";
	return `${phase} · 页 ${stats.pages ?? 0} · 图 ${stats.images ?? 0}/${stats.panels ?? 0}${cast}`;
}

export function pageTitle(page, snapshot) {
	const suffix = snapshot?.title && page.index === 1 ? ` · ${snapshot.title}` : "";
	return `${page.id}${suffix}`;
}

export function roleLabel(role) {
	return ROLE_LABELS[role] || role || "角色";
}
