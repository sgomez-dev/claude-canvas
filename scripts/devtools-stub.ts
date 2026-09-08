/**
 * Stands in for `react-devtools-core` in the shipped bundle.
 *
 * Ink imports it to support attaching React DevTools, which only happens
 * when its DEV mode is on. Marking it `--external` instead left a runtime
 * import in the bundle, and the whole point of the bundle is that an
 * installed plugin has no node_modules to resolve it from -- so the CLI
 * failed to load with "Cannot find package 'react-devtools-core'" before
 * printing anything.
 */
export function connectToDevTools(): void {}
export default { connectToDevTools };
