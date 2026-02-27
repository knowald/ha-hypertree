/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HIDE_EXPLAINER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
