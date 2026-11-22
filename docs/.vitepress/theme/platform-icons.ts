/**
 * The platform icons every terminal name sits beside (#37761): the icon says the platform, so the name beside it
 * never repeats it in words. Greyscale 14x14 inline SVG, one home for every page.
 */
const ICONS: Record<string, string> = {
  macos:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style="vertical-align:-2px"><path d="M12.2 5.5c-.1 0-1.6.9-1.6 2.8 0 2.2 1.9 3 2 3-.1.1-.3 1.1-1 2.2-.6 1-1.3 1.9-2.3 1.9s-1.3-.6-2.4-.6c-1.2 0-1.6.6-2.5.6-.9 0-1.6-.9-2.3-2C1.3 12 .8 10.2.8 8.6c0-2.6 1.7-4 3.3-4 .9 0 1.6.6 2.2.6.5 0 1.4-.6 2.4-.6.4 0 1.8.1 2.6 1.3-.1 0-1.5.9-1.5 2.6h.4z" fill="#888"/><path d="M10 1c.5.6.9 1.5.8 2.4-.8.1-1.7-.4-2.2-1.1-.5-.6-.9-1.5-.8-2.3.9 0 1.7.4 2.2 1z" fill="#888"/></svg>',
  linux:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style="vertical-align:-2px"><path d="M8 1C5.8 1 4 3.4 4 6.4c0 1.5.4 2.8 1.1 3.8-.5.3-1.5 1-1.5 2.1 0 .4.1.8.4 1.1.5.5 1.4.6 2.2.6h3.6c.8 0 1.7-.1 2.2-.6.3-.3.4-.7.4-1.1 0-1.1-1-1.8-1.5-2.1.7-1 1.1-2.3 1.1-3.8C12 3.4 10.2 1 8 1zm-1.5 5c-.4 0-.8-.4-.8-.8s.4-.8.8-.8.8.4.8.8-.4.8-.8.8zm3 0c-.4 0-.8-.4-.8-.8s.4-.8.8-.8.8.4.8.8-.4.8-.8.8z" fill="#888"/></svg>',
  windows:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style="vertical-align:-2px"><path d="M1 3.5l5.5-.8v5.3H1V3.5zm6.3-.9L15 1.5v6.5H7.3V2.6zM15 8.5v6.3l-7.7-1.1V8.5H15zM6.5 13.5L1 12.8V8.5h5.5v5z" fill="#888"/></svg>',
}

export function platformIcon(os: string | null | undefined): string {
  return (os && ICONS[os]) || ""
}
