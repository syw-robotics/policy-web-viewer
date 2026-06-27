# MuJoCo UI 渲染参数说明

这份文档记录 `policy-web-viewer` 中影响 MuJoCo/Three.js 画面和交互体验的关键参数。修改 UI 时优先改 `frontend/`，不要手动改 `src/policy_web_viewer/static/`，后者是 `npm run build:api` 生成的本地服务静态资源。

## 前端源码位置

本地开发和静态导出共用同一套前端源码：

```text
frontend/
  index.html
  src/render_config.js
  src/styles.css
  src/runtimes/api_runtime.js
  src/runtimes/wasm_runtime.js
```

- `render_config.js`：共享渲染和交互参数。Home 视角、相机、灯光、阴影、地面、材质、contacts、外力和力矩参数都优先改这里。
- `api_runtime.js`：本地 `policy-web-viewer` 页面，数据来自 Python `/api`。
- `wasm_runtime.js`：`policy-web-viewer-export` 导出的静态页面，仿真在浏览器 MuJoCo WASM 内运行。
- 两个 runtime 都 import `render_config.js`。不要在 runtime 里重复写同一类渲染参数，否则本地调好的画面和 export 后的画面容易再次漂移。

## 相机和 Home 视角

关键参数：

```js
CAMERA_CONFIG = {
  fov: 45,
  near: 0.01,
  far: 100,
}
```

- `45`：垂直视场角，越大透视越强，画面看起来更广。
- `0.01`：near clipping plane，太大时近处模型会被裁掉。
- `100`：far clipping plane，太小时远处地面或机器人会被裁掉。

Home 视角当前是：

```js
target: [0, 0.85, 0]
position: [-4.0, 1.5, 2.0]
```

含义：

- `target`：相机看向的位置，通常跟机器人躯干高度接近。
- `position`：Home 视角下相机所在位置。
- 点击 `Home` 会重置 orbit control 的 target、radius、theta、phi。

注意：现在 Home 视角只需要改 `frontend/src/render_config.js` 里的 `HOME_VIEW`。

## Orbit 交互

Orbit 控制器的重要参数：

- 左键拖空白区域：旋转视角。
- 中键或右键拖空白区域：平移视角。
- 滚轮：缩放。
- `radius` 限制：`0.8` 到 `14`。
- 旋转速度：`0.0045`。
- 平移速度：`radius * 0.0012`。
- 俯仰角限制：`0.18` 到 `Math.PI - 0.18`。

这些参数影响视角是否“跟手”、是否容易穿进模型、是否容易丢失机器人。

## 背景、雾和色彩

当前场景背景：

```js
SCENE_CONFIG = {
  background: 0x2d3b3d,
  fogNear: 9,
  fogFar: 18,
}
```

- `0x2d3b3d`：背景和雾颜色。
- `9`：雾开始距离。
- `18`：雾完全显著的距离。

如果觉得画面太暗，优先调灯光强度；如果觉得远处地面太突兀，可以调 fog。

## 灯光

当前有三类灯光：

```js
LIGHT_CONFIG = {
  hemisphereSky: 0xcfe7ff,
  hemisphereGround: 0x26322d,
  hemisphereIntensity: 1.1,
  keyColor: 0xffffff,
  keyIntensity: 2.2,
  rimColor: 0xa8c8ff,
  rimIntensity: 0.65,
}
```

- Hemisphere light：环境补光，决定整体暗部是否能看清。
- Key directional light：主光，负责主要明暗和阴影。
- Rim directional light：侧后方补光，让轮廓更清楚。

主光位置：

```js
keyLight.position = target + [4.5, 7.5, 4.0]
```

这里的 `target` 会跟随机器人，所以机器人走远后阴影仍然应该存在。

## 阴影

关键参数在 `frontend/src/render_config.js` 的 `SHADOW_CONFIG` 中：

```js
SHADOW_CONFIG = {
  mapSize: 2048,
  near: 0.2,
  far: 18,
  left: -7,
  right: 7,
  top: 7,
  bottom: -7,
}
```

- `mapSize`：阴影贴图分辨率。越大越清晰，但更耗 GPU。
- `near/far`：阴影相机深度范围。
- `left/right/top/bottom`：阴影覆盖区域。
- 如果机器人走远后阴影消失，优先检查主光是否跟随机器人，以及 shadow camera 的覆盖范围是否足够。

## 地面

当前地面：

```js
FLOOR_CONFIG = {
  size: 120,
  repeat: [18, 18],
}
```

- `120 x 120`：视觉地面尺寸，不等于 MuJoCo 物理地面大小。
- `repeat 18`：网格纹理重复次数。
- 地面材质 `roughness: 0.86`，用于保持较哑光的效果。

## 模型材质

几何体材质：

```js
GEOM_MATERIAL_CONFIG = {
  roughness: 0.52,
  metalness: 0.03,
  clearcoat: 0.15,
}
```

- `roughness`：越高越哑光。
- `metalness`：机器人如果不应呈现金属反光，保持较低。
- `clearcoat`：轻微高光层，太高会显得塑料感重。

## 分辨率和性能

当前像素比：

```js
SCENE_CONFIG.maxPixelRatio = 2
```

- 限制最大 DPR 为 `2`，避免高分屏上 GPU 压力过大。
- 如果页面卡顿，先考虑降低这个上限，例如改成 `1.5` 或 `1`。

本地 API 页面帧数据轮询：

```js
await sleep(33)
```

约等于 30 FPS 的状态更新。Three.js 渲染仍由 `renderer.setAnimationLoop` 驱动。

WASM 页面仿真节奏来自导出的 manifest：

- `sim_hz`
- `physics_dt`
- `policy_step_dt`
- `decimation`

这些参数会影响浏览器端仿真速度和策略更新频率。

## Contacts 可视化

Contacts 按钮控制接触点和接触力箭头：

```js
CONTACT_CONFIG = {
  forceScale: 0.006,
  forceMaxLength: 0.8,
}
```

- `forceScale`：接触力到箭头长度的缩放。
- `forceMaxLength`：箭头最大长度。
- 接触点是蓝色小球，接触力是蓝色箭头。

如果 contacts 打开后箭头过长或过短，优先在 `CONTACT_CONFIG` 里调这两个值。

## 外力和力矩交互

外力拖拽参数：

```js
FORCE_CONFIG = {
  dragGain: 30.0,
  dragMax: 80.0,
  arrowMaxLength: 1.25,
}
```

- `dragGain`：鼠标拖拽位移转换成外力的增益。
- `dragMax`：外力最大值。
- `arrowMaxLength`：外力箭头最大长度。

力矩拖拽参数：

```js
TORQUE_CONFIG = {
  dragDeadzonePx: 10.0,
  dragGain: 0.15,
  dragMax: 20.0,
}
```

- 右键拖机器人时施加力矩。
- `DEADZONE` 防止轻微抖动误触发。
- `GAIN` 和 `MAX` 决定力矩强度。

## UI 控件

主要按钮：

- `Run/Pause`：开始或暂停仿真。
- `Reset`：重置仿真。
- `Follow`：相机 target 是否跟随机器人。
- `Contacts`：显示接触点和接触力。
- `Home`：重置视角。
- `Force`：是否允许鼠标拖拽施加外力或力矩。

按钮布局、面板颜色、字体、间距在 `frontend/src/styles.css` 中。

## 修改后的同步流程

本地调试：

```bash
policy-web-viewer \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat
```

构建本地静态资源：

```bash
npm run build:api
```

导出 GitHub Pages 可部署目录：

```bash
policy-web-viewer-export \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat \
  --out export/g1-demo \
  --overwrite
```

原则：

- 改共享 HTML/CSS 时，优先改 `frontend/index.html` 和 `frontend/src/styles.css`。
- 改渲染参数时，优先改 `frontend/src/render_config.js`，这样本地和 export 会一起变化。
- 只有环境特有逻辑才放进 `api_runtime.js` 或 `wasm_runtime.js`。
- 不要手动修改 `src/policy_web_viewer/static/`。
