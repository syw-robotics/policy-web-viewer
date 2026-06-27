# Runtime adapters

Runtime adapters own environment-specific behavior while sharing the same HTML and CSS.

- `api_runtime.js`: local development UI backed by `policy-web-viewer` HTTP endpoints.
- `wasm_runtime.js`: static browser simulation backed by MuJoCo WASM and ONNX Runtime Web.

Keep shared UI and rendering behavior aligned here until it is extracted into smaller shared modules.
