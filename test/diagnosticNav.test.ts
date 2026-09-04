import { describe, expect, it } from 'vitest'
import { Severity, type Diagnostic } from '../src/core/types'
import { nextDiagnostic, previousDiagnostic } from '../src/renderer/navigation/diagnosticNav'

function diag(offset: number): Diagnostic {
  return { severity: Severity.Warning, code: 'test', offset, length: 1, message: 'test' }
}

describe('nextDiagnostic', () => {
  it('returns the closest diagnostic after the current offset', () => {
    const diagnostics = [diag(10), diag(50), diag(30)]
    expect(nextDiagnostic(diagnostics, 20)).toEqual(diag(30))
  })

  it('returns null past the last diagnostic — no wraparound', () => {
    expect(nextDiagnostic([diag(10), diag(30)], 30)).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(nextDiagnostic([], 0)).toBeNull()
  })

  it('is unaffected by input order — sorts before searching', () => {
    const diagnostics = [diag(90), diag(10), diag(50)]
    expect(nextDiagnostic(diagnostics, 0)).toEqual(diag(10))
  })

  it('skips past diagnostics at the exact current offset', () => {
    expect(nextDiagnostic([diag(10), diag(20)], 10)).toEqual(diag(20))
  })
})

describe('previousDiagnostic', () => {
  it('returns the closest diagnostic before the current offset', () => {
    const diagnostics = [diag(10), diag(50), diag(30)]
    expect(previousDiagnostic(diagnostics, 40)).toEqual(diag(30))
  })

  it('returns null before the first diagnostic — no wraparound', () => {
    expect(previousDiagnostic([diag(10), diag(30)], 10)).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(previousDiagnostic([], 0)).toBeNull()
  })

  it('is unaffected by input order — sorts before searching', () => {
    const diagnostics = [diag(90), diag(10), diag(50)]
    expect(previousDiagnostic(diagnostics, 100)).toEqual(diag(90))
  })

  it('skips past diagnostics at the exact current offset', () => {
    expect(previousDiagnostic([diag(10), diag(20)], 20)).toEqual(diag(10))
  })
})
