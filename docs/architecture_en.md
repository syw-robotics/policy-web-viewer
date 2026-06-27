# policy-web-viewer Architecture

`policy-web-viewer` is the browser visualization and static export layer for `unitree-deploy`. It does not train policies and does not replace the policy, robot config, or observation logic in `unitree-deploy`. Its job is to run an existing checkpoint as an interactive MuJoCo demo in the browser, then export that demo as a static site that can be deployed to GitHub Pages.

## Relationship With unitree-deploy

`unitree-deploy` provides the policy runtime semantics:

- Robot model, MuJoCo XML, meshes, and terrain configuration.
- Checkpoint loading, `policy.yaml`, ONNX policy, observation definitions, action scaling, and PD gains.
- `PolicyManager` for single-policy and `--multi-ckpt` manifest loading.
- `ObservationContext`, so the web demo constructs observations consistently with the original policy runtime.

`policy-web-viewer` provides the browser experience:

- Starts a local HTTP server that exposes a Python MuJoCo + policy loop to the browser UI.
- Provides browser command controls, keyboard commands, camera controls, contacts, external force, and torque interactions.
- Builds both the local API page and static WASM page from the same frontend source.
- Exports scene files, policy ONNX, policy config, and manifest into a static directory.

Important boundary: this project bypasses Unitree DDS and does not connect to a real robot. It reads MuJoCo state directly, builds an `ObservationContext`, calls the `unitree-deploy` policy, then converts the action into MuJoCo actuator control.

## Workflow

Local development:

```bash
policy-web-viewer \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat
```

After UI, commands, rendering, and interactions behave correctly:

```bash
policy-web-viewer-export \
  --robot g1 \
  --ckpt /home/syw/.gitrepos/unitree-deploy/ckpt/g1/vanilla_ppo_flat \
  --out export/g1-demo \
  --overwrite
```

The exported `export/g1-demo/` directory is static and can be deployed with GitHub Pages.

## Local API Mode

`policy-web-viewer` starts the local mode:

```text
policy-web-viewer CLI
  -> src/policy_web_viewer/server.py
  -> OnlineDemoSimulator
  -> unitree-deploy PolicyManager / BasePolicy
  -> Python MuJoCo
  -> browser frontend api_runtime.js
```

Main files:

- `src/policy_web_viewer/server.py`: HTTP server and `/api/*` endpoints.
- `src/policy_web_viewer/simulator.py`: Python MuJoCo + policy loop.
- `frontend/src/runtimes/api_runtime.js`: browser adapter for the local API.

Local API:

- `GET /api/scene`: robot bodies, geoms, meshes, camera, and command schema.
- `GET /api/frame`: current body poses and status, optionally contacts.
- `GET /api/status`: running state, policy name, command, and RTF.
- `POST /api/command`: updates the command vector.
- `POST /api/control`: start, pause, reset.
- `POST /api/drag`: applies mouse-driven force or torque.

Local mode is best for development because policy inference and MuJoCo stepping stay in Python, while the browser handles rendering and interaction.

## Static WASM Export Mode

`policy-web-viewer-export` generates a static directory:

```text
policy-web-viewer-export CLI
  -> src/policy_web_viewer/export.py
  -> reads the same OnlineDemoSimulator/profile
  -> writes scene XML + meshes
  -> writes policy.onnx + policy.json
  -> writes demo/manifest.json
  -> Vite builds frontend with wasm_runtime.js
```

At runtime in the browser:

```text
browser
  -> frontend wasm_runtime.js
  -> mujoco-js
  -> onnxruntime-web
  -> demo/manifest.json
  -> demo/scenes/*
  -> demo/policy/policy.onnx
```

Static mode:

- Does not require a Python server.
- Does not require `unitree-deploy` on the visitor's machine.
- Runs MuJoCo and ONNX policy inference in the browser.
- Can be deployed to GitHub Pages.
- Exports the active policy as one deterministic interactive demo.

## Single Frontend Source

There is only one frontend source tree:

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

`bootstrap.js` selects the runtime at build time:

- `VITE_POLICY_WEB_VIEWER_RUNTIME=api`: local API page.
- `VITE_POLICY_WEB_VIEWER_RUNTIME=wasm`: static WASM page.

Shared files:

- `frontend/index.html`: page structure.
- `frontend/src/styles.css`: layout and visual styling.
- `frontend/src/render_config.js`: Home view, camera, lighting, shadows, floor, materials, contacts, force, and torque parameters.

Runtime-specific files:

- `api_runtime.js`: calls Python `/api/*`.
- `wasm_runtime.js`: loads MuJoCo WASM and ONNX Runtime Web in the browser.

Rule of thumb: user-visible UI, rendering parameters, and interaction parameters should live in shared files when possible. Only environment-specific logic belongs in runtime adapters.

## Python Package Structure

```text
src/policy_web_viewer/
  server.py
  simulator.py
  export.py
  command_schema.py
  static/
```

Responsibilities:

- `server.py`: CLI `policy-web-viewer`; starts the local HTTP server and auto-builds the API frontend when needed.
- `simulator.py`: connects a `unitree-deploy` policy profile to MuJoCo state, policy stepping, PD control, drag force, and contacts debug data.
- `export.py`: CLI `policy-web-viewer-export`; generates the static WASM demo.
- `command_schema.py`: reads `web_policy.yaml` and builds browser command controls and keyboard hotkey schema.
- `static/`: generated output from `npm run build:api`; ignored by git and not maintained by hand.

## Command Schema

Each checkpoint can place `web_policy.yaml` next to `policy.yaml`:

```text
checkpoint/
  policy.yaml
  policy.onnx
  web_policy.yaml
```

`web_policy.yaml` can define:

- Command dimension names.
- Slider, select, or toggle control type.
- Min, max, default, step, and unit.
- Keyboard hotkeys such as `W/S`, `A/D`, and `Q/E`.

If `web_policy.yaml` is absent, the project tries to infer a default 3D velocity command from the active policy config.

## Build Outputs And Git Tracking

Track:

- `frontend/`
- `src/policy_web_viewer/*.py`
- `docs/`
- `README.md`
- `README_zh.md`
- `package.json`
- `pyproject.toml`

Do not track:

- `node_modules/`
- `export/`
- `src/policy_web_viewer/static/`

`src/policy_web_viewer/static/` is generated by `npm run build:api`. Hashed file names are normal Vite output for browser cache invalidation. When `policy-web-viewer` starts, it rebuilds this directory automatically if `frontend/` has changed.

## Design Choices

1. `unitree-deploy` owns policy semantics; `policy-web-viewer` owns the browser experience.
2. Local development uses Python MuJoCo to stay close to the original `unitree-deploy` policy loop.
3. Static export uses MuJoCo WASM and ONNX Runtime Web to support GitHub Pages deployment.
4. The frontend has one source tree and chooses the runtime at build time.
5. Rendering and interaction parameters are centralized in `render_config.js` to avoid drift between local and exported pages.
