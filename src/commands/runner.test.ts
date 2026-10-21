import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { Document } from '../core/document'
import { CancelError } from '../input/interaction'
import { CommandRunner, type Command } from './runner'

const line = (x: number) => ({ type: 'polyline' as const, points: [new Vector3(x, 0, 0), new Vector3(x + 1, 0, 0)], closed: false })

function setup() {
  const doc = new Document()
  const log: string[] = []
  const runner = new CommandRunner({ doc, input: { setScript: () => {}, unattended: 0 }, log: (text: string) => log.push(text) } as never)
  return { doc, log, runner }
}

describe('commands that stop halfway', () => {
  it('leave the model as it was when they fail', async () => {
    const { doc, log, runner } = setup()
    const kept = doc.add(line(0)).id
    runner.register({
      name: 'Breaks',
      async run({ doc }) {
        doc.add(line(1))
        doc.setGeometry(kept, line(5))
        throw new Error('The kernel could not do it')
      },
    } satisfies Command)
    await runner.run('Breaks')
    expect([...doc.objects.keys()]).toEqual([kept])
    expect(doc.objects.get(kept)!.geometry).toEqual(line(0))
    expect(log.slice(-2)).toEqual(['Error in Breaks: The kernel could not do it', 'The changes it had made were taken back'])
    // Nothing to undo but the first line.
    expect(doc.undo()).toBe(true)
    expect(doc.objects.size).toBe(0)
  })

  it('keep what they did when cancelled', async () => {
    const { doc, runner } = setup()
    runner.register({
      name: 'Copies',
      async run({ doc }) {
        doc.add(line(1))
        doc.add(line(2))
        throw new CancelError()
      },
    } satisfies Command)
    await runner.run('Copies')
    expect(doc.objects.size).toBe(2)
    doc.undo()
    expect(doc.objects.size).toBe(0)
  })
})
