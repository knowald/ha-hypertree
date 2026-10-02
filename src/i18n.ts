/**
 * Localisation for the panel UI.
 *
 * Upstream ha-hypertree ships no i18n at all: every string is a hardcoded
 * English literal, and the graph labels are painted onto a canvas with
 * ctx.fillText, so browser translation tools cannot reach them either.
 *
 * This module keys translations by the original English string. That keeps the
 * call sites mechanically reviewable (`t("Spring stiffness")`), makes an
 * untranslated key fall back to readable English instead of breaking the UI,
 * and lets a test prove no key was missed.
 *
 * To go back to English, set DISPLAY_LANG below to "en" - the fallback path
 * returns the key unchanged, so no other file needs to change.
 */

/**
 * Set to "en" to render the original English wording everywhere. The type is a
 * union rather than `as const` so the comparison in t() is actually reachable
 * - a literal type would make it a branch TypeScript rejects as impossible.
 */
export const DISPLAY_LANG: "zh-CN" | "en" = "zh-CN";

/**
 * Option values are stored in localStorage and compared in logic, so they must
 * stay English. Only their rendered text goes through this map.
 */
const OPTION_LABELS: Record<string, string> = {
  // structure / layout
  domain: "按域",
  device: "按设备",
  tree: "树形",
  scatter: "散布",
  // style
  dots: "圆点",
  stars: "星空",
  // visual mode
  default: "默认",
  hulls: "外壳",
  automations: "自动化",
  // unavailable
  normal: "正常",
  pulse: "脉冲",
  ring: "描边",
  hidden: "隐藏",
  only: "仅显示",
  // grouping
  area: "按区域",
  // state-change effects
  supernova: "超新星",
  "shooting-star": "流星",
  flare: "耀斑",
  "pulse-wave": "脉冲波",
  "color-shift": "色彩偏移",
  // automation relations
  trigger: "触发",
  condition: "条件",
  action: "执行",
};

/**
 * Home Assistant integration domains, for display only.
 *
 * The domain itself is never translated: it is what `entity_id.split(".")[0]`
 * produces, what `hiddenDomains` stores, and what the per-domain colour map is
 * keyed by. Only the rendered label goes through here.
 *
 * An unknown domain renders as itself, so a custom integration still shows up
 * correctly.
 */
const DOMAIN_LABELS: Record<string, string> = {
  air_quality: "空气质量",
  alarm_control_panel: "报警控制面板",
  automation: "自动化",
  binary_sensor: "二进制传感器",
  button: "按钮",
  calendar: "日历",
  camera: "摄像头",
  climate: "温控器",
  counter: "计数器",
  cover: "窗帘",
  date: "日期",
  date_time: "日期时间",
  device_tracker: "设备追踪",
  fan: "风扇",
  group: "分组",
  humidifier: "加湿器",
  image: "图片",
  image_processing: "图片处理",
  input_boolean: "布尔输入",
  input_button: "按钮输入",
  input_datetime: "日期时间输入",
  input_number: "数字输入",
  input_select: "选项输入",
  input_text: "文本输入",
  lawn_mower: "割草机",
  light: "灯",
  lock: "门锁",
  media_player: "媒体播放器",
  notify: "通知",
  number: "数值",
  person: "人员",
  plant: "植物",
  remote: "遥控器",
  scene: "场景",
  script: "脚本",
  select: "选项",
  sensor: "传感器",
  siren: "警报器",
  sun: "太阳",
  switch: "开关",
  text: "文本",
  time: "时间",
  timer: "定时器",
  update: "更新",
  vacuum: "扫地机器人",
  valve: "阀门",
  water_heater: "热水器",
  weather: "天气",
  zone: "区域",
};

const DICT: Record<string, string> = {
  // ---- toolbar -----------------------------------------------------------
  "Search entities...": "搜索实体…",
  Filters: "筛选",
  "Reset positions": "重置布局",
  "Fit view to graph": "图形取景",
  Settings: "设置",
  Menu: "菜单",

  // ---- settings tabs and sections ---------------------------------------
  View: "视图",
  Style: "样式",
  Advanced: "高级",
  Colors: "颜色",
  Physics: "物理",
  Connection: "连接",
  Domains: "域",
  Areas: "区域",
  State: "状态",

  // ---- view tab ----------------------------------------------------------
  Structure: "结构",
  Layout: "布局",
  "Initial node positions: tree (structured) or scatter (random)":
    "节点的初始位置：树形（有结构）或散布（随机）",
  "Render nodes as plain dots or glowing stars": "把节点渲染成普通圆点或发光的星星",
  Brightness: "亮度",
  "Overall star and edge opacity": "星星与连线整体的不透明度",
  "Star size": "星星大小",
  "Halo intensity": "光晕强度",
  "Glow gradient spread and strength": "发光渐变的扩散程度与强度",
  "Halo size": "光晕大小",
  "Base glow radius around stars": "星星周围的基础发光半径",
  "Parent halo": "父节点光晕",
  "Halo for area, domain, and device nodes": "区域、域和设备节点的光晕",
  "Effect scale": "特效缩放",
  "Size of state-change effects": "状态变化特效的尺寸",
  "Twinkle speed": "闪烁速度",
  "Twinkle size": "闪烁幅度",
  "Halo radius pulsing with twinkle": "随闪烁脉动的光晕半径",
  "Twinkle floor": "闪烁亮度下限",
  "Minimum brightness during twinkle dip": "闪烁低谷期的最低亮度",
  "Halo spread": "光晕扩散",
  "Gaussian halo width: low = tight bright peak, high = broad soft glow":
    "高斯光晕的宽度：低＝紧致亮峰，高＝宽阔柔光",
  Effect: "特效",
  "Animation on entity state change": "实体状态变化时播放的动画",
  Grouping: "分组方式",
  "Automation entities only": "仅显示自动化引用的实体",
  "Hide entities not referenced by any automation": "隐藏没有被任何自动化引用的实体",
  Entities: "显示实体",
  Unavailable: "不可用实体",
  "Appear on change": "变化时出现",
  "Nodes start hidden and appear as state changes arrive": "节点初始隐藏，随状态变化浮现",

  // ---- filter panel ------------------------------------------------------
  "Search hides non-matching": "搜索时隐藏不匹配项",
  "When enabled, the search bar hides nodes instead of highlighting them":
    "开启后搜索框会隐藏节点，而不是高亮它们",
  All: "全选",
  None: "全不选",
  "Filter by state (e.g. on, off)": "按状态筛选（如 on、off）",

  // ---- style tab ---------------------------------------------------------
  Labels: "标签",
  "Structure labels": "结构标签",
  "Show labels on grouping nodes (domains in domain mode, devices in device mode)":
    "显示分组节点的标签（域模式下是域，设备模式下是设备）",
  "Entity icons": "实体图标",
  "Render Material Design Icons on entity nodes (resolved from Home Assistant)":
    "在实体节点上渲染 Material Design 图标（从 Home Assistant 获取）",
  "Skip unchanged": "跳过未变化",
  "Skip glow when state value hasn't changed": "状态值没有变化时不发光",
  "Label size": "标签字号",
  "Entity label zoom": "实体标签缩放阈值",
  "Zoom level to show entity labels": "显示实体标签所需的缩放级别",
  "Entity dot size": "实体圆点大小",
  "Connection brightness": "连线亮度",
  "Opacity of parent-child connection lines": "父子连线的不透明度",
  Background: "背景色",
  background: "背景",

  // ---- advanced tab ------------------------------------------------------
  Repulsion: "斥力",
  "Spring length": "弹簧长度",
  "Spring stiffness": "弹簧刚度",
  "Pull strength between connected nodes": "相连节点之间的拉力强度",
  Damping: "阻尼",
  "Velocity decay per frame": "每帧的速度衰减",
  "Randomize colors": "随机配色",
  "Reset all settings": "重置全部设置",
  "Export settings": "导出设置",
  "Import settings": "导入设置",
  "Settings exported": "设置已导出",
  "Settings imported": "设置已导入",
  "Invalid settings file": "无效的设置文件",
  Reconnect: "重新连接",
  "Long-lived access token": "长期访问令牌",

  // ---- tooltips ----------------------------------------------------------
  "State: ": "状态：",
  "Changed: ": "变更于 ",
  "References:": "引用了：",
  "Used by automations:": "被以下自动化使用：",
  "{rel} in {name}": "在「{name}」中作为{rel}",

  // ---- context menu ------------------------------------------------------
  "Copy ID: {id}": "复制 ID：{id}",
  "View History": "查看历史",
  "View Logbook": "查看日志簿",
  "Open Area in HA": "在 HA 中打开区域",
  "Open Device in HA": "在 HA 中打开设备",
  "View Automations": "查看自动化",
  Expand: "展开",
  Collapse: "折叠",
  "Not connected": "未连接",
  "Failed: {msg}": "失败：{msg}",
  "Copied: {id}": "已复制：{id}",
  "{label} ({domain})": "{label}（{domain}）",
  // The service name stays as the Home Assistant service id on purpose;
  // only the surrounding sentence is localised.
  "Called {service}: {id}": "已调用 {service}：{id}",

  // ---- entity service actions -------------------------------------------
  Toggle: "切换",
  "Turn on": "打开",
  "Turn off": "关闭",
  Run: "运行",
  Stop: "停止",
  Activate: "激活",
  Trigger: "触发",
  Open: "打开",
  Close: "关闭",
  Unlock: "解锁",
  Lock: "上锁",
  "Play/Pause": "播放/暂停",
  "Return to base": "返回基站",
  Press: "按下",
  Start: "开始",

  // ---- tree labels -------------------------------------------------------
  Unassigned: "未分配",
  "No device": "无设备",
  Home: "家",

  // ---- status / session --------------------------------------------------
  "Loading...": "加载中…",
  "Loading registries...": "正在加载注册表…",
  "Connecting...": "正在连接…",
  Connect: "连接",
  "Connection lost, reconnecting...": "连接已断开，正在重连…",
  "Authentication failed, please log in again": "认证失败，请重新登录",
  "Failed to load": "加载失败",
  "Init failed: {msg}": "初始化失败：{msg}",
  "Loaded {n} nodes across {a} areas": "已加载 {a} 个区域下的 {n} 个节点",
  "{n} nodes | {a} areas": "{n} 个节点 | {a} 个区域",

  // ---- debug console -----------------------------------------------------
  "Debug Console": "调试控制台",
  Clear: "清空",
  // "Close" is shared with the cover service action below.
  "FPS: idle": "帧率：空闲",
  "FPS: {fps}  |  Frame: {ms}ms": "帧率：{fps}  |  帧：{ms}ms",
  "Debug console initialized": "调试控制台已初始化",
  state: "状态",
  system: "系统",
  auth: "认证",

  // ---- debug log messages ------------------------------------------------
  // These are read in the debug console, which is where you go to verify a
  // fix, so they are localised too rather than left as developer English.
  "Auto-connecting with saved credentials": "正在用已保存的凭据自动连接",
  "Connected to {url}": "已连接到 {url}",
  "Connection failed": "连接失败",
  "Connection failed: {msg}": "连接失败：{msg}",
  "Panel connected to {url}": "面板已连接到 {url}",
  "Received {n} states": "已接收 {n} 条状态",
  "Failed to fetch states: {msg}": "获取状态失败：{msg}",
  "Connection restored": "连接已恢复",
  "Reconnection failed: invalid authentication": "重连失败：认证无效",
  "Fit view: k={k} for {n} nodes": "取景：缩放 {k}，共 {n} 个节点",
  "Service call failed: {call}": "服务调用失败：{call}",
  "Automation: found {n} automation entities in registry": "自动化：在注册表中找到 {n} 个自动化实体",
  "Automation: fetched {n} edges": "自动化：已获取 {n} 条连线",
  "Automation: fetch failed": "自动化：获取失败",
  "Automation: first rejection for {id}": "自动化：{id} 首次被拒绝",
  "Automation: sample config keys": "自动化：示例配置的键",
  "Automation: batch {n}: {ok} ok, {failed} failed": "自动化：第 {n} 批：{ok} 成功，{failed} 失败",
  "Automation: aborting, {n} automations not loaded": "自动化：已中止，{n} 个自动化未加载",
  "Icon resolved via {source}: {name} (vb {box})": "图标来自 {source}：{name}（viewBox {box}）",
  "Icon unresolved: {name}": "图标未解析：{name}",

  // ---- login form --------------------------------------------------------
  "Connect to your Home Assistant instance": "连接到你的 Home Assistant",
  "Home Assistant URL": "Home Assistant 地址",
  "Long-Lived Access Token": "长期访问令牌",
  "Hold on, should I give you my token?": "等等，我是不是该把令牌交给你？",
  "Your browser blocks insecure WebSocket connections from HTTPS pages. ":
    "浏览器会阻止 HTTPS 页面发起不安全的 WebSocket 连接。",
  "Try ": "试试 ",
  "switching to HTTP": "切换到 HTTP",
  " to connect to a local HA instance. ": " 以连接本地 HA 实例。",
  "If your browser redirects you back to HTTPS, manually replace ":
    "如果浏览器把你重定向回 HTTPS，请在地址栏里把",
  "in your address bar.": "改掉。",
  "Darn it, no, but I almost got you.": "开玩笑的——不过我差点就骗到你了。",
  "Just kidding - but seriously,": "说真的，玩笑归玩笑，",
  "never lose that reflex.": "但千万别养成随手交出令牌的习惯。",
  "This app is entirely client-side. Your token connects your browser":
    "这个应用完全运行在客户端。令牌只是把你的浏览器",
  "directly to your Home Assistant via WebSocket, and that's the end of":
    "通过 WebSocket 直接连到你的 Home Assistant，然后就到这儿了——",
  "the road. No backend, no analytics, no telemetry, no cloud, no nothing.":
    "没有后端，没有统计，没有遥测，没有云端，什么都没有。",
  "Then again, what if this whole paragraph is just a really convincing bluff? Fair point. The":
    "当然，你也可以怀疑这一整段话本身就是一场精心设计的骗局。说得对。",
  "source code": "源代码",
  "is open - clone it, run it locally, verify it yourself. Words are cheap, code doesn't lie. Stay sharp out there.":
    "是公开的——克隆下来、在本地跑一遍、亲眼验证。言语廉价，代码不会说谎。多留个心眼。",
};

/**
 * Translate a UI string. Unknown keys return the English source, so a missing
 * entry degrades to the original wording instead of breaking the panel.
 * Supports `{name}` placeholders.
 *
 * Set DISPLAY_LANG to "en" above to go back to the original wording - the
 * dictionaries are ignored and every key renders as itself.
 */
export function t(key: string, vars?: Record<string, unknown>): string {
  const dict = DISPLAY_LANG === "en" ? undefined : DICT;
  let out = (dict && dict[key]) ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.split(`{${name}}`).join(String(value));
    }
  }
  return out;
}

/**
 * Display text for an option value. The value itself is never translated - it
 * is what gets written to localStorage and compared in settings logic.
 */
export function optionLabel(value: string): string {
  const labels = DISPLAY_LANG === "en" ? undefined : OPTION_LABELS;
  return (labels && labels[value]) ?? value;
}

/** Display text for a Home Assistant domain. Unknown domains pass through. */
export function domainLabel(domain: string): string {
  const labels = DISPLAY_LANG === "en" ? undefined : DOMAIN_LABELS;
  return (labels && labels[domain]) ?? domain;
}

/** "灯 (light)" - the Chinese label with the raw domain kept discoverable. */
export function domainTitle(domain: string): string {
  const zh = domainLabel(domain);
  return zh === domain ? domain : t("{label} ({domain})", { label: zh, domain });
}

/** Exposed for the dictionary-completeness test. */
export const __internals = { DICT, OPTION_LABELS, DOMAIN_LABELS };
