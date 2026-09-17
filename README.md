# HachimoDock 3D 装配向导

这是一个面向第一次装机用户的 Three.js 交互式装配动画原型。它把 OSHWHub 项目「哈基米机 HachimoDock：给AI Agent一个身体」的复刻教程做成 7 步向导：核对零件、安装两条排母、插入 ESP32-P4、安装屏幕排线、安装按键/摇杆/喇叭、合壳锁螺钉、完成检查。

## 运行

```bash
npm install
npm run dev
```

然后打开终端输出的本地地址。拖动场景可以旋转，滚轮可以缩放；右下方可以逐步播放，也可以切换爆炸视图。

## 资源与精度边界

- `public/assets/full-case.step`：OSHWHub 附件「桌搭-整机外壳3d打印版.STEP」，作为真实上/下壳、按键帽和摇杆件载入。
- `public/assets/screen-lens.step`：OSHWHub 附件「屏幕lens 3d打印版.STEP」，作为真实屏框载入。
- PCB、ESP32-P4、排母、MIPI-DSI 排线、喇叭、铜螺母和螺钉目前是教学用参数模型；它们的尺寸、接口和方向应在拿到实物/PCB 导出文件后再做一次坐标校准。场景里写有「CUSTOM PCB / 底板」的绿色板不是 PCB CAD 的精确复刻。
- `reference/assembly.mp4` 是页面附件「拼装视频.mp4」的本地参考副本，不会被浏览器运行时加载。

页面给出的 ESP32-P4 方案物料是：微雪 ESP32-P4-WIFI6 / WIFI6-M ×1、2.54 mm 1×20P 单排排母 ×2、2.8 英寸 480×640 IPS MIPI-DSI 屏 ×1、YA13S 摇杆 ×1、Kailh BOX 轴 ×3、2011 小腔体喇叭 ×1、M2.5×6 螺钉 ×2、M2.5×4×3.5 滚花热熔铜螺母 ×2。

## 下一步校准

1. 从嘉立创 EDA 导出 PCB 的 STEP/GLB，或提供工程里的板框尺寸与排母孔位。
2. 用实物确认屏幕 DSI 接头在左/右侧、排线蓝色加强片朝向和喇叭粘贴位置。
3. 按实物照片校准 PCB、排母和屏幕相对于 `full-case.step` 的坐标，再把当前教学几何替换为真实模型。
4. 最后增加“暂停看接口”“反向拆解”和通电前逐项勾选；动画本身不替代电气检查，排线不要带电插拔。

## 来源

参考页面：[OSHWHub 项目](https://oshwhub.com/eda_gqvzlprk/project_cnbmkbjc)。项目页面标注 GPL 3.0，页面同时说明复刻用途和授权边界；本原型仅把页面公开的结构信息和作者提供的 STEP/视频用于装配演示。
