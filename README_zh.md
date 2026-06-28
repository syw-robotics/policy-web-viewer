# policy-web-viewer

`policy-web-viewer` 是面向 Unitree checkpoint 的浏览器 MuJoCo policy viewer。

推荐工作流：

1. 本地用 `policy-web-viewer` 开发和调试 interactive demo。
2. 用 `policy-web-viewer-export` 导出同一套 UI 的静态 MuJoCo WASM 页面。
3. 把导出的文件夹推送到 GitHub Pages 部署。

English version: [README.md](README.md)

## Demo 演示

https://github.com/user-attachments/assets/d0173371-9e1d-4efd-a881-b204999295b5

[点击此处探索交互式demo](https://syw-robotics.github.io/policy-web-viewer/)

## 环境安装

`unitree-deploy` 和本项目需要安装在同一个 Python 环境里：

```bash
pip install -e /home/syw/.gitrepos/unitree-deploy
pip install -e /home/syw/.gitrepos/web_policy
npm install
```

## 本地调试

启动本地 API 模式：

```bash
policy-web-viewer \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat
```

打开：

```text
http://127.0.0.1:8000
```

`--ckpt` 应该指向 checkpoint 目录，不是 `policy.yaml` 文件。

## 导出静态 Demo

本地 demo 调好后，导出一个纯静态浏览器仿真目录：

```bash
policy-web-viewer-export \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat \
  --out export/g1-demo \
  --overwrite
```

本地检查导出结果：

```bash
cd export/g1-demo
python3 -m http.server 8080
```

打开：

```text
http://127.0.0.1:8080
```

导出的目录是纯静态文件，可以作为 GitHub 仓库内容推送，然后用 GitHub Pages 部署。

## 项目结构

```text
frontend/
  index.html                    # 共享页面结构
  src/
    bootstrap.js                # 构建时选择 API runtime 或 WASM runtime
    render_config.js            # 共享渲染和交互参数
    styles.css                  # 共享 UI 样式
    runtimes/
      api_runtime.js            # 本地 policy-web-viewer /api runtime
      wasm_runtime.js           # 静态 MuJoCo WASM + ONNX Runtime Web runtime

src/policy_web_viewer/
  server.py                     # 本地 HTTP server 和 API
  simulator.py                  # Python MuJoCo + policy loop
  export.py                     # 静态导出逻辑
  command_schema.py             # 浏览器 command 控件 schema
  static/                       # 生成的本地前端产物，不手动编辑
```

## 前端源码入口

前端源码只有一份：`frontend/`。

应该修改：

```text
frontend/index.html
frontend/src/render_config.js
frontend/src/styles.css
frontend/src/runtimes/api_runtime.js
frontend/src/runtimes/wasm_runtime.js
```

不要手动修改生成文件：

```text
src/policy_web_viewer/static/
```

这个目录由 `npm run build:api` 生成，并且被 git 忽略。

构建命令：

```bash
npm run build:api    # 构建本地 policy-web-viewer 使用的前端产物
npm run build:wasm   # 构建静态 export 使用的前端产物
```

运行 `policy-web-viewer` 时，如果发现 `frontend/` 比 `src/policy_web_viewer/static/` 新，会自动重新构建本地前端产物。

## 两种 Runtime 的差异

两种 runtime 共享同一个 HTML 和 CSS。差异只在执行环境：

- 本地 `policy-web-viewer` 使用 Python `/api` server 和 Python MuJoCo policy loop。
- 静态 export 使用浏览器里的 MuJoCo WASM 和 ONNX Runtime Web。

用户可见的 UI 改动尽量放在共享文件里。只有执行环境特有的逻辑才放进 `frontend/src/runtimes/`。

## Command Schema

如果某个 checkpoint 需要自定义浏览器 command 控件和快捷键，可以在 `policy.yaml` 旁边放一个 `web_policy.yaml`。如果没有这个文件，`policy-web-viewer` 会尝试从 policy config 推断默认的 3D velocity command schema。

## 更多说明

- 架构和 `unitree-deploy` 的关系：[docs/architecture_zh.md](docs/architecture_zh.md)
- 渲染和 UI 参数说明：[docs/rendering_zh.md](docs/rendering_zh.md)
- Architecture in English: [docs/architecture_en.md](docs/architecture_en.md)
- Rendering in English: [docs/rendering_en.md](docs/rendering_en.md)

## 常用命令

如果 `8000` 端口被占用，可以换端口：

```bash
policy-web-viewer \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat \
  --port 8001
```

查找并停止占用 `8000` 的进程：

```bash
lsof -iTCP:8000 -sTCP:LISTEN -n -P
kill <PID>
```
