/// <reference types="vitepress/client" />

// Import typing only; the site build owns validation of Vue templates and assets.
declare module "*.vue" {
  import type { DefineComponent } from "vue"
  const component: DefineComponent
  export default component
}
