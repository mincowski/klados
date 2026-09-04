import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getContext, resetContextForTests } from '../src/renderer/commands/context'
import {
  goBack,
  goForward,
  recordNavigation,
  resetNavigationForTests
} from '../src/renderer/navigation/navigationStore'

describe('navigationStore (D14)', () => {
  beforeEach(() => {
    resetNavigationForTests()
    resetContextForTests()
  })
  afterEach(() => {
    resetNavigationForTests()
    resetContextForTests()
  })

  it('starts with nowhere to go', () => {
    expect(getContext().canGoBack).toBe(false)
    expect(getContext().canGoForward).toBe(false)
  })

  it('recording visits enables going back but not forward', () => {
    recordNavigation(1)
    recordNavigation(2)
    expect(getContext().canGoBack).toBe(true)
    expect(getContext().canGoForward).toBe(false)
  })

  it('goBack returns the previous node and updates context', () => {
    recordNavigation(1)
    recordNavigation(2)
    recordNavigation(3)
    expect(goBack()).toBe(2)
    expect(getContext().canGoBack).toBe(true)
    expect(getContext().canGoForward).toBe(true)
  })

  it('goForward returns to where goBack came from', () => {
    recordNavigation(1)
    recordNavigation(2)
    goBack()
    expect(goForward()).toBe(2)
    expect(getContext().canGoForward).toBe(false)
  })

  it('goBack/goForward are no-ops (return null) with nowhere to go', () => {
    expect(goBack()).toBeNull()
    expect(goForward()).toBeNull()
    recordNavigation(1)
    expect(goBack()).toBeNull() // one entry — no "before" it
  })

  it('recording the same node twice in a row does not create an extra history stop', () => {
    recordNavigation(1)
    recordNavigation(2)
    recordNavigation(2)
    expect(goBack()).toBe(1)
    expect(goForward()).toBe(2)
    expect(goForward()).toBeNull() // still only two real stops
  })
})
