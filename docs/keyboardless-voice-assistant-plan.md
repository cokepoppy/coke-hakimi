# Hakimi 免键盘语音助手方案

## 目标

在不依赖绿 PCB 按键和摇杆的情况下，让 ESP32-P4 + 屏幕 + 麦克风完成一轮语音输入：

```text
说官方 WakeNet 唤醒短语“小龙小龙”（当前选定模型）
        ↓
Hakimi 进入 LISTENING，屏幕提示“请说话”
        ↓
检测到下一段语音，桥接端聚焦当前 Agent 输入框并按下 macOS Fn
        ↓
ESP32 PCM → CH343/UART → Electron → BlackHole 2ch → 豆包输入法
        ↓
VAD 检测到稳定静音，桥接端松开 Fn
        ↓
豆包提交文字到当前焦点输入框，Codex/Claude Code 等 Agent 自己处理
```

Electron 不做云端 ASR。豆包仍然负责把真正的命令语音转成文字；桥接端只做唤醒状态、PCM 转发、静音断句、Fn down/up 和 Agent 焦点控制。

## 关键边界

ESP32 当前只输出 16 kHz、单声道、16-bit PCM。它不能仅靠原始 PCM 判断“小哈小哈”这几个汉字，因此需要独立的本地唤醒检测器。实现分两层：

1. 当前可立即验证的 `VAD wake fallback`：第一段连续人声作为唤醒候选，不转发给豆包；静音结束后进入等待命令状态。它能完整验证“唤醒→等待→Fn→VAD 结束→松开 Fn”链路，但不是严格的词语识别。
2. 正式的本地离线 WakeNet 模式：当前使用 Espressif 官方随 ESP-SR 提供的
   `wn9_xiaolongxiaolong_tts`（小龙小龙）。官方内置模型列表中没有“小哈小哈”；
   如果以后要换成自定义词，需要按 Espressif 的唤醒词定制流程训练/打包模型，不能只改字符串。
   模型只决定是否唤醒，不接管命令转写，也不改变豆包输入链路。模型不可用时自动回退到
   VAD wake，并在桥接状态里显示当前模式。

板端通过 `audio/status` 声明 `wakeWord=true` 和 `wakeWordModel`，命中后发送
`audio/wake`；Electron 收到后才进入等待命令状态。唤醒词本身不会送入豆包，只有后续
命令 PCM 会在确认说话后转发。

## 状态机

```text
OFF
  └─ enable → WAITING_WAKE
WAITING_WAKE
  ├─ VAD 人声片段结束 → WAITING_COMMAND（回退模式）
  └─ 板端 `audio/wake` → WAITING_COMMAND（官方 WakeNet）
WAITING_COMMAND
  ├─ 超时 → WAITING_WAKE
  └─ 检测到命令人声 → CAPTURING（Fn down + PCM 转发）
CAPTURING
  ├─ 静音约 900 ms → COOLDOWN（Fn up，豆包提交）
  └─ 最长 20 s → COOLDOWN（保护性 Fn up）
COOLDOWN
  └─ 约 600 ms → WAITING_WAKE
```

检测器保留约 300 ms PCM 前滚，避免聚焦窗口和按下 Fn 的耗时吃掉命令开头。所有时间窗和 RMS 阈值都可配置，后续根据实际麦克风环境调参。

## 端到端验证分层

- 纯状态机：合成“唤醒片段/静音/命令片段/静音”，断言没有把唤醒片段转发给 BlackHole，命令片段被转发，并且最终一定发送 Fn up。
- 桥接集成：fake serial + fake Mac key/focus/sink，断言事件顺序为 `focus → fn down → PCM → fn up`，重复静音不会重复释放 Fn。
- 真实设备：只需要 ESP32 单独连接屏幕和 USB，先看串口音频电平和屏幕状态，再让豆包选择 BlackHole 2ch，最后验证当前焦点输入框的中文结果。
- MIPI 屏幕：没有软件截图回读接口；机器侧用 JSONL ACK、音频计数和状态日志，最终像素用设备照片确认。

## 当前硬件策略

键盘底板暂不接入。重新焊接前，不把 SW1/SW2/SW3、排母或绿 PCB 当成软件验收前置条件；ESP32 单独运行是当前安全测试基线。确认绿 PCB 的短路和焊点后，再把实体按键作为可选的手动覆盖入口。
