# policy-web-viewer 架构说明

`policy-web-viewer` 是 `unitree-deploy` 的浏览器可视化和静态导出层。它不训练策略，也不替代 `unitree-deploy` 的 policy、robot config、observation 逻辑；它负责把已有 checkpoint 以交互式 MuJoCo demo 的形式在浏览器里运行，并在调好后导出成可部署到 GitHub Pages 的静态网页。

## 和 unitree-deploy 的关系

`unitree-deploy` 是底层策略运行时来源：

- 提供 robot model、MuJoCo XML、mesh、terrain 配置。
- 提供 checkpoint 读取、policy YAML、ONNX policy、observation 结构、action scaling、PD 增益等策略语义。
- 提供 `PolicyManager`，支持单 policy 和 `--multi-ckpt` 多 policy manifest。
- 提供 `ObservationContext`，让本项目构造的观测和 `unitree-deploy` policy 运行逻辑一致。

`policy-web-viewer` 是展示和导出层：

- 本地启动一个 HTTP server，把 MuJoCo + policy loop 暴露给浏览器 UI。
- 提供浏览器里的 command 控件、键盘控制、相机、contacts、外力/力矩交互。
- 复用同一份前端源码构建本地 API 页面和静态 WASM 页面。
- 导出机器人场景、policy ONNX、policy config、manifest，生成纯静态目录。

一个重要边界是：本项目绕过 Unitree DDS，不连接真实机器人。它直接读取 MuJoCo state，构造 `ObservationContext`，调用 `unitree-deploy` 的 policy，然后把动作转成 MuJoCo actuator control。

## 工作流

常规流程：

```bash
policy-web-viewer \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat
```

本地调好 UI、command、渲染、交互后：

```bash
policy-web-viewer-export \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat \
  --out export/g1-demo \
  --overwrite
```

导出的 `export/g1-demo/` 是静态目录，可以直接推到 GitHub Pages。

## 本地 API 模式

本地模式由 `policy-web-viewer` 启动，核心链路是：

```text
policy-web-viewer CLI
  -> src/policy_web_viewer/server.py
  -> OnlineDemoSimulator
  -> unitree-deploy PolicyManager / BasePolicy
  -> Python MuJoCo
  -> browser frontend api_runtime.js
```

主要文件：

- `src/policy_web_viewer/server.py`：HTTP server 和 `/api/*` endpoint。
- `src/policy_web_viewer/simulator.py`：Python MuJoCo + policy loop。
- `frontend/src/runtimes/api_runtime.js`：浏览器 UI 的本地 API adapter。

本地 API：

- `GET /api/scene`：返回 robot bodies、geoms、mesh、camera、command schema。
- `GET /api/frame`：返回当前 body pose、status，可选 contacts。
- `GET /api/status`：返回运行状态、policy 名称、command、RTF。
- `POST /api/command`：更新 command vector。
- `POST /api/control`：start、pause、reset。
- `POST /api/drag`：鼠标拖拽产生外力或力矩。

本地模式的特点：

- policy inference 和 MuJoCo step 都在 Python 里运行。
- 浏览器只负责渲染和交互。
- 适合开发、调 UI、检查策略行为。

## 静态 WASM Export 模式

导出模式由 `policy-web-viewer-export` 生成一个纯静态目录，核心链路是：

```text
policy-web-viewer-export CLI
  -> src/policy_web_viewer/export.py
  -> 读取同一个 OnlineDemoSimulator/profile
  -> 写出 scene XML + meshes
  -> 写出 policy.onnx + policy.json
  -> 写出 demo/manifest.json
  -> Vite build frontend with wasm_runtime.js
```

浏览器打开导出目录后：

```text
browser
  -> frontend wasm_runtime.js
  -> mujoco-js
  -> onnxruntime-web
  -> demo/manifest.json
  -> demo/scenes/*
  -> demo/policy/policy.onnx
```

静态模式的特点：

- 不需要 Python server。
- 不需要 `unitree-deploy` 安装在访问者机器上。
- MuJoCo 和 ONNX policy 都在浏览器里运行。
- 可以部署到 GitHub Pages。
- 当前 export 导出 active policy，用于部署一个确定的 interactive demo。

## 单一前端源码

前端源码只有一份：

```text
frontend/
  index.html
  src/
    bootstrap.js
    render_config.js
    styles.css
    runtimes/
      api_runtime.js
      wasm_runtime.js
```

`bootstrap.js` 根据构建环境选择 runtime：

- `VITE_POLICY_WEB_VIEWER_RUNTIME=api`：构建本地 API 页面。
- `VITE_POLICY_WEB_VIEWER_RUNTIME=wasm`：构建静态 WASM 页面。

共享内容：

- `frontend/index.html`：页面结构。
- `frontend/src/styles.css`：布局和视觉样式。
- `frontend/src/render_config.js`：Home view、相机、灯光、阴影、地面、材质、contacts、外力和力矩等共享渲染参数。

环境特有内容：

- `api_runtime.js`：调用 Python `/api/*`。
- `wasm_runtime.js`：在浏览器里加载 MuJoCo WASM 和 ONNX Runtime Web。

原则是：用户可见的 UI、渲染参数、交互参数尽量放共享文件；只有执行环境不同的代码才放 runtime adapter。

## Python 包结构

```text
src/policy_web_viewer/
  server.py
  simulator.py
  export.py
  command_schema.py
  static/
```

职责：

- `server.py`：CLI `policy-web-viewer`，启动本地 HTTP server，并在需要时自动构建 API frontend。
- `simulator.py`：把 `unitree-deploy` 的 policy profile 接到 MuJoCo state 上，执行 policy loop、PD control、drag force、contacts debug。
- `export.py`：CLI `policy-web-viewer-export`，生成静态 WASM demo。
- `command_schema.py`：读取 `web_policy.yaml`，生成浏览器 command 控件和键盘 hotkey schema。
- `static/`：`npm run build:api` 的生成产物，已被 git 忽略，不手动维护。

## Command Schema

每个 checkpoint 可以在 `policy.yaml` 旁边放一个 `web_policy.yaml`，用于描述浏览器 command UI：

```text
checkpoint/
  policy.yaml
  policy.onnx
  web_policy.yaml
```

`web_policy.yaml` 可以定义：

- command 维度名称。
- slider/select/toggle 控件类型。
- min/max/default/step/unit。
- 键盘 hotkey，例如 `W/S`、`A/D`、`Q/E`。

如果没有 `web_policy.yaml`，本项目会尝试从 active policy config 推断默认 3D velocity command。

## 构建产物和 Git 追踪

应该追踪：

- `frontend/`
- `src/policy_web_viewer/*.py`
- `README.md`
- `README_zh.md`
- `docs/`
- `package.json`
- `pyproject.toml`

不应该追踪：

- `node_modules/`
- `export/`
- `src/policy_web_viewer/static/`

`src/policy_web_viewer/static/` 是 `npm run build:api` 生成的本地 server 静态资源。文件名带 hash 是 Vite 的正常行为，用于浏览器缓存失效。运行 `policy-web-viewer` 时，如果发现 `frontend/` 更新，会自动重新构建这个目录。

## 关键设计取舍

1. `unitree-deploy` 负责策略语义，`policy-web-viewer` 负责浏览器体验。
2. 本地调试用 Python MuJoCo，最大限度复用 `unitree-deploy` 原始 policy loop。
3. 静态导出用 MuJoCo WASM + ONNX Runtime Web，牺牲一部分动态能力，换取 GitHub Pages 部署能力。
4. 前端只有一份源码，通过 build-time runtime selection 适配本地和静态两种环境。
5. 渲染和交互参数集中在 `render_config.js`，避免本地页面和导出页面漂移。
