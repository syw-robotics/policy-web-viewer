# policy-web-viewer frontend

This is the single source of truth for the browser UI.

- `index.html` defines the shared page shell for both local and exported demos.
- `src/styles.css` defines shared styling.
- `src/render_config.js` defines shared rendering and interaction parameters.
- `src/bootstrap.js` selects the runtime at build time using `VITE_POLICY_WEB_VIEWER_RUNTIME`.
- `src/runtimes/api_runtime.js` runs against the local Python `/api` server.
- `src/runtimes/wasm_runtime.js` runs MuJoCo WASM and ONNX Runtime Web in a static export.

Generated Python-server assets live in `../src/policy_web_viewer/static/` and should not be edited directly.
