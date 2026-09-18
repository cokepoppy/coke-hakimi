# Hakimi Agent UI 研究与设计基线

状态：`codex/industrial-agent-ui` 分支的第一版设计决策

## 结论

采用混合路线：

1. ImageGen 只负责视觉探索：浅色工业风、设备材质、宠物/Agent 形象、配色和信息层级。
2. HTML/Canvas 原型负责真实交互规格：固定 640×480 横屏画布、聊天气泡、语音草稿框、滚动、状态切换和三颗实体按键的映射。
3. ESP32 固件使用 LVGL 9 实现最终 UI，保留当前已经验证过的 ST7701S/MIPI DSI 初始化、横屏坐标映射、音频链路和 JSONL 协议。

不要让 ESP32 运行 HTML，也不要把 ImageGen 生成的图片直接烧录成整屏背景。HTML 是设计验证工具，ImageGen 是视觉参考，LVGL 才是设备运行时实现。

## 为什么这样选

| 路线 | 适合做什么 | 主要问题 | 决策 |
| --- | --- | --- | --- |
| ImageGen 直接出 UI 图 | 视觉气质、浅色工业风、宠物形象、材质探索 | 文字不可靠，像素布局不可测，状态和滚动无法验证 | 保留为设计稿 |
| HTML/Canvas 原型 | 精确验证 640×480 布局、气泡换行、输入框、状态和按键 | 不能直接在 ESP32 上运行，浏览器字体与固件字体不同 | 作为交互单一事实来源 |
| 直接手写 C 像素绘制 | 固件最小、完全可控 | 当前只有英文大写，布局和聊天内容扩展成本很高 | 仅保留为启动/故障回退 |
| LVGL 9 + ESP-IDF | 文字、容器、滚动、样式、状态组件和局部刷新 | 需要一次性迁移显示 flush 和字体资源 | 最终运行时方案 |
| SquareLine 等可视化编辑器 | 快速拖拽页面 | 生成代码和工具链会增加依赖；三颗按键不是触摸屏交互 | 后续可选，不作为第一阶段依赖 |

官方资料显示，LVGL 有 ESP-IDF 组件集成；Espressif 的 ESP32-P4 MIPI DSI 示例已经采用 LVGL、PSRAM draw buffer、flush callback 和 LVGL task。当前项目的 ST7701S 初始化可以继续由项目内驱动负责，LVGL 只接管 UI 绘制。

参考：

- [LVGL ESP-IDF integration](https://docs.lvgl.io/master/integration/chip_vendors/espressif/add_lvgl_to_esp32_idf_project.html)
- [Espressif ESP32-P4 MIPI DSI + LVGL example](https://github.com/espressif/esp-idf/tree/master/examples/peripherals/lcd/mipi_dsi)
- [LVGL ESP-IDF reference port](https://github.com/lvgl/lv_esp_idf)

## 当前硬件与软件约束

- 真实屏幕为 480×640 ST7701S，设备横向安装；逻辑 UI 画布固定为 640×480。
- 当前 `agent-bridge/firmware/serial-audio/main/display.c` 是手写 RGB565 像素渲染，只支持有限的英文大写字形和 `READY/VOICE/WORKING/DONE/ERROR` 等短状态。
- 当前 ESP32 是已现场识别的 ESP32-P4 v3.2，不能使用 V1 固件；新 UI 仍使用 V3 工程。
- 当前 UART 运行链路为 4,000,000 baud；烧录 CH343 路径仍使用 460800，不能把运行波特率和烧录波特率混用。
- SW1 长按是语音 PTT；SW1 短按不提交；SW2 是退格；SW3 是 Enter/发送。Command+Tab 不占用实体按钮，保留给组合键或 Mac 端控制。
- 语音文字由 Mac 上的豆包输入法识别。Hakimi 只负责麦克风、按键和显示；Mac 桥接层负责把识别后的文字同步回设备。

## 视觉方向

主题：浅色工业风，而不是深色赛博风。

- 画布底色：暖白/浅灰，保持白色外壳的一致性。
- 信息卡：石墨灰、钢灰，用来承载聊天气泡和状态信息。
- 强调色：青色表示正在监听/连接，琥珀色表示等待或需要注意，酸绿色表示完成。
- 线条：细灰色网格和分隔线，避免大面积渐变、霓虹和装饰性背景。
- 宠物：保留一个小型几何 Agent 头像，作为状态图标；不占聊天区域，不依赖大图资源。
- 字体：正文优先高可读性，状态/时间/项目名使用等宽风格；最终固件需要单独准备中文字体子集。

视觉参考稿：

- [浅色工业风概念稿](./industrial-agent-ui-concept-v2-light.png)
- [早期深色方向稿，仅作对比](./industrial-agent-ui-concept-v1.png)

概念稿中的文字块是故意抽象的。实际文字、换行和控件尺寸以 HTML 原型和固件字体测试为准。

## 640×480 页面布局

采用 8 px 网格，四周安全边距 16 px：

```text
┌────────────────────────────────────────────────────────────┐  y=0
│ agent / project                         state · connection  │  40 px
├───────────────┬────────────────────────────────────────────┤
│               │                                            │
│  small pet    │  chat history                              │
│  + state      │  user bubble / agent bubble / system line   │  322 px
│  + progress   │  newest message stays visible              │
│               │                                            │
├───────────────┴────────────────────────────────────────────┤
│  microphone  live transcript draft ...              send   │  60 px
├────────────────────────────────────────────────────────────┤
│  LISTEN / hold             ← cursor        ENTER / send    │  42 px
└────────────────────────────────────────────────────────────┘  y=480
```

底部输入区域是必须保留的核心区域：

1. SW1 长按时，Mac 桥接层聚焦 Agent 输入框并按住 Fn；设备显示声波、监听状态和实时草稿。
2. 豆包把语音转成文字后，Mac 端监听目标输入框/系统输入结果，将文本作为 `ui/input-draft` 增量同步到 Hakimi。
3. 草稿显示在底部输入框中，不立即当作聊天消息；用户可以用摇杆左右移动光标，SW2 退格。
4. SW1 松开后，Mac 端结束 Fn；按现有约定，Enter 或后续确认动作才把草稿提交为用户气泡。
5. 提交后草稿清空，用户消息进入聊天区；Agent 输出以左侧气泡追加，状态栏切换为 WORKING/DONE/ERROR。

为了避免同步输入时出现“半个汉字”或乱序，协议应传 UTF-8 的完整文本快照和 cursor，而不是只发送不带序号的单字符：

```json
{
  "topic": "ui/input-draft",
  "payload": {
    "sessionId": "agent-session",
    "text": "正在输入的文字",
    "cursor": 6,
    "revision": 12,
    "source": "mac-input-method",
    "status": "composing"
  }
}
```

## Agent 状态

设备屏幕使用以下稳定状态，不直接把 Codex 或 Claude Code 的原始日志词汇暴露给固件：

- `idle`：已连接，没有活动任务。
- `listening`：SW1 正在按住，麦克风/豆包输入链路活动。
- `working`：Agent 正在执行工具、命令或生成回复。
- `waiting_user`：Agent 等待确认、权限或用户输入。
- `done`：本轮任务完成，保留最后一条结果。
- `error`：适配器或 Agent 报错。
- `disconnected`：Mac 桥接层或设备连接断开。

状态只显示一个主状态，聊天区保留最近若干条消息。不要把大量日志直接塞进屏幕；日志继续留在 Mac 端，设备只收到摘要、最后一条输出和必要的进度信息。

## 适配层与协议边界

现有 `AgentAdapter` 继续作为 Codex、Claude Code 等 Agent 的入口。后续扩展为两层：

```text
Codex/Claude Code/其他 Agent 日志
              ↓
        AgentAdapter
              ↓ 统一格式
     AgentSnapshot + AgentMessage[]
              ↓
       Mac bridge / ui protocol
              ↓
          LVGL screen
```

建议增加的通用消息模型：

```ts
type AgentMessage = {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  createdAt: number;
  final: boolean;
};

type AgentScreenSnapshot = {
  agentId: string;
  agentName: string;
  projectName?: string;
  state: 'idle' | 'listening' | 'working' | 'waiting_user' | 'done' | 'error' | 'disconnected';
  title?: string;
  draft?: { text: string; cursor: number; revision: number };
  messages: AgentMessage[];
};
```

第一阶段可以复用当前 `speech/text` 做状态兼容，同时新增 `ui/snapshot` 和 `ui/input-draft`；不要修改音频 PCM 包格式，也不要让固件读取 Agent 原始日志格式。

## 实施顺序

1. 建立 640×480 HTML/Canvas 原型：浅色主题、状态切换、聊天气泡、底部草稿框、模拟三颗按键。
2. 先用固定假数据验证聊天换行、滚动、草稿光标和状态，不连接真实 Agent。
3. 扩展 Mac 端通用屏幕状态模型，将 Codex/Claude Code 的最新摘要和 Mac 输入草稿推送到设备。
4. 在固件中引入 LVGL 9 和 `esp_lvgl_port`；保留现有 ST7701S 初始化和已验证的横屏变换，先做静态页面。
5. 加入中文字体子集和消息裁剪策略，再接入真实 `ui/snapshot`/`ui/input-draft`。
6. 通过 V3 固件编译、低速烧录、设备显示、按键和语音回归测试后，才替换默认屏幕。

## 暂不做的事情

- 不在 ESP32 上运行 WebView 或 HTML 引擎。
- 不用 ImageGen 生成的整张界面作为运行时背景。
- 不把 Codex 的原始 JSONL/日志格式写进固件。
- 不为了 UI 重做已经稳定的音频、按键和串口链路。
- 不在没有中文字体和内存预算测试前承诺任意长度的中文聊天记录。
