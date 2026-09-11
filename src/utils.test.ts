import { describe, expect, it } from 'vitest'
import { formatErrorMessage, runCatching, runCatchingAsync } from './utils'

describe('runCatching', () => {
  it('wraps a successful call', () => {
    expect(runCatching(() => 42)).toEqual({ ok: true, value: 42 })
  })

  it('wraps a throwing call', () => {
    const error = new Error('boom')
    expect(
      runCatching(() => {
        throw error
      }),
    ).toEqual({ ok: false, error })
  })
})

describe('runCatchingAsync', () => {
  it('wraps a resolved promise', async () => {
    await expect(runCatchingAsync(() => Promise.resolve(42))).resolves.toEqual({ ok: true, value: 42 })
  })

  it('wraps a rejected promise', async () => {
    const error = new Error('boom')
    await expect(runCatchingAsync(() => Promise.reject(error))).resolves.toEqual({ ok: false, error })
  })
})

describe('formatErrorMessage', () => {
  it('formats Error instances', () => {
    expect(formatErrorMessage(new Error('models.json exploded'))).toBe('models.json exploded')
  })

  it('formats non-Error throws', () => {
    expect(formatErrorMessage('this is not an error')).toBe('this is not an error')
  })
})
