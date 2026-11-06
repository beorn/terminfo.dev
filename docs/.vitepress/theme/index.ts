import DefaultTheme from "vitepress/theme"
import type { Theme } from "vitepress"
import ResultEvidenceCell from "./ResultEvidenceCell.vue"
import RunHistory from "./RunHistory.vue"
import "./tooltip.css"
import "./result-cells.css"
import "./analysis.css"
import "./glossary-links.css"
import "./breadcrumb.css"
import "./summary-bars.css"
import "./hero.css"

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("ResultEvidenceCell", ResultEvidenceCell)
    app.component("RunHistory", RunHistory)
  },
} satisfies Theme
