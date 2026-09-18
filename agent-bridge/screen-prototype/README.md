# Hakimi Screen UI Prototype

固定 640×480 横屏的浅色工业风交互原型。它独立于 Electron 控制台和 ESP32 固件，用来验证：

- Agent 状态：IDLE、LISTENING、WORKING、WAITING、DONE、ERROR
- 聊天气泡和消息裁剪
- Mac/豆包语音转写草稿框
- SW1 监听、SW2 退格、SW3 回车/发送
- 草稿发送后进入聊天区

直接打开 `index.html` 即可；如果浏览器限制本地脚本，可以在本目录运行：

```bash
python3 -m http.server 4174
```

然后访问 <http://127.0.0.1:4174>。

这个原型不是 ESP32 运行时。确认布局后，固件版本会使用 LVGL 9 重建同一套组件和状态模型。
