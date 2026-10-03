import * as stylex from "@stylexjs/stylex"

/** Region density marker; compact fragments observe it as an ancestor carrying `data-density`. */
export const densityMarker = stylex.defineMarker()

/**
 * Marks an element whose hover or keyboard focus reveals a descendant: a chart column's crosshair
 * and readout, a tooltip's bubble, a row's trailing actions.
 */
export const revealMarker = stylex.defineMarker()

/** Marks the console frame while its narrow-screen drawer is open. */
export const drawerMarker = stylex.defineMarker()
