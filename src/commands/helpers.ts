import { Matrix4, Vector3 } from 'three'
import { transform } from '../core/curves'
import { wireframe } from '../core/geometry'
import type { CommandContext } from './runner'

/** Values the editing commands remember between runs, as their defaults. */
export const memory = {
  rotateCopy: false,
  scaleCopy: false,
  mirrorCopy: true,
  arrayX: 3,
  arrayY: 1,
  arraySpacingX: 10,
  arraySpacingY: 10,
  polarCount: 6,
  polarAngle: 360,
  offsetDistance: 1,
  filletRadius: 1,
}

export function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}

export const yesNo = (name: string, value: boolean) => `${name}=${value ? 'Yes' : 'No'}`
export const valueOption = (name: string, value: number) => `${name}=${formatValue(value)}`
export const isOption = (option: string, name: string) => option.toLowerCase().startsWith(name.toLowerCase())

/** Preview callback that draws the given objects with a transform built from the cursor position. */
export function transformedPreview(ctx: CommandContext, ids: number[], makeMatrix: (p: Vector3) => Matrix4 | null) {
  const geometries = ids.map((id) => ctx.doc.objects.get(id)!.geometry)
  return (p: Vector3) => {
    const m = makeMatrix(p)
    return m ? geometries.flatMap((g) => wireframe(transform(g, m))) : []
  }
}

/** Transforms the objects in place, or adds transformed copies on the same layers. */
export function applyTransform(ctx: CommandContext, ids: number[], m: Matrix4, copy: boolean): void {
  // Copies of grouped objects make groups of their own, one for each original group.
  const newGroups = new Map<number, number[]>()
  for (const id of ids) {
    const obj = ctx.doc.objects.get(id)
    if (!obj) continue
    const moved = transform(obj.geometry, m)
    if (!copy) {
      ctx.doc.setGeometry(id, moved)
      continue
    }
    const added = ctx.doc.add(moved, obj.layerId)
    for (const g of obj.groups ?? []) newGroups.set(g, [...(newGroups.get(g) ?? []), added.id])
  }
  for (const members of newGroups.values()) ctx.doc.group(members)
}

export function rotationAbout(center: Vector3, axis: Vector3, angle: number): Matrix4 {
  return new Matrix4()
    .makeTranslation(center.x, center.y, center.z)
    .multiply(new Matrix4().makeRotationAxis(axis.clone().normalize(), angle))
    .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z))
}

export function scaleAbout(center: Vector3, factor: number): Matrix4 {
  return new Matrix4()
    .makeTranslation(center.x, center.y, center.z)
    .multiply(new Matrix4().makeScale(factor, factor, factor))
    .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z))
}

/** Reflection in the plane through `point` with unit normal `normal`. */
export function mirrorIn(point: Vector3, normal: Vector3): Matrix4 {
  const { x, y, z } = normal.clone().normalize()
  const d = -(x * point.x + y * point.y + z * point.z)
  // prettier-ignore
  return new Matrix4().set(
    1 - 2 * x * x, -2 * x * y, -2 * x * z, -2 * x * d,
    -2 * x * y, 1 - 2 * y * y, -2 * y * z, -2 * y * d,
    -2 * x * z, -2 * y * z, 1 - 2 * z * z, -2 * z * d,
    0, 0, 0, 1,
  )
}

/** Signed angle from a to b around the axis n. */
export function signedAngle(a: Vector3, b: Vector3, n: Vector3): number {
  return Math.atan2(a.clone().cross(b).dot(n), a.dot(b))
}

export function plural(word: string, count: number): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
