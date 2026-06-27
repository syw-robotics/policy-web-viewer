import './styles.css';

if (import.meta.env.VITE_POLICY_WEB_VIEWER_RUNTIME === 'api') {
  import('./runtimes/api_runtime.js');
} else if (import.meta.env.VITE_POLICY_WEB_VIEWER_RUNTIME === 'wasm') {
  import('./runtimes/wasm_runtime.js');
} else {
  throw new Error(`unknown policy-web-viewer runtime: ${import.meta.env.VITE_POLICY_WEB_VIEWER_RUNTIME}`);
}
