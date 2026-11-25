import { createStaticVNode, defineComponent, h, type PropType } from "vue"

/**
 * Matrix `<tbody>` wrapper (#38451).
 *
 * Uses Vue 3's Static VNode (`createStaticVNode`) for initial SSR and hydration so the
 * client skips `innerHTML` re-parsing and full-table style/layout invalidation in O(1).
 * When the matching SSR `<tbody data-mb="...">` is already in `document` during initial
 * client hydration, `renderHtml` is not even invoked — avoiding megabyte string building
 * on the main thread while still rendering normally on SPA navigation or filter updates.
 */
export default defineComponent({
  name: "MatrixBody",
  props: {
    id: { type: String, required: true },
    renderHtml: { type: Function as PropType<() => string>, required: true },
    dynamic: { type: Boolean, default: false },
  },
  setup(props) {
    const initialId = props.id
    let hydratedFromSsr =
      typeof document !== "undefined" && Boolean(document.querySelector(`tbody[data-mb="${CSS.escape(initialId)}"]`))

    return () => {
      if (props.dynamic || props.id !== initialId) {
        hydratedFromSsr = false
        return h("tbody", { "data-mb": props.id, innerHTML: props.renderHtml() })
      }
      if (hydratedFromSsr) {
        return createStaticVNode("", 1)
      }
      return createStaticVNode(`<tbody data-mb="${props.id}">${props.renderHtml()}</tbody>`, 1)
    }
  },
})
