import DefaultTheme from "vitepress/theme"
import GlossaryTooltip from "vitepress-plugin-glossary/vue"
import "./tooltip.css"
import "./result-cells.css"
import "./analysis.css"
import "./glossary-override.css"

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("GlossaryTooltip", GlossaryTooltip)
  },
}
