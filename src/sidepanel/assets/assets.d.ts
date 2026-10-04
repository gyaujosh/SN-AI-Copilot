// Vite resolves imported SVGs to URLs (inlined as data URIs when small).
declare module "*.svg" {
  const url: string;
  export default url;
}
