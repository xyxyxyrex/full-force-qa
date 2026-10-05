import { describe, expect, it } from 'vitest'
import { checkApiRequest, checkNavigation, checkRequest, isAdminUrl, linkCheckPlan, sameSite, siteOf } from './qaBrowserPolicy'

const site = 'https://svenson.test'

describe('siteOf', () => {
  it('ignores www, path and case, and only knows web pages', () => {
    expect(siteOf('https://www.Svenson.test/a/b?c=1')).toBe(site)
    expect(siteOf('http://svenson.test')).toBe('http://svenson.test')
    expect(siteOf('mailto:x@y.z')).toBeNull()
    expect(sameSite('https://svenson.test/contact/', site)).toBe(true)
    expect(sameSite('https://evil.test/', site)).toBe(false)
    expect(sameSite('https://svenson.test.evil.test/', site)).toBe(false)
  })
})

describe('admin, login and logout', () => {
  it('are recognised, while the front-end endpoints stay usable', () => {
    for (const url of ['https://svenson.test/wp-admin/', 'https://svenson.test/wp-admin/post.php?post=1&action=edit', 'https://svenson.test/wp-login.php', 'https://svenson.test/wp-login.php?action=logout&_wpnonce=1', 'https://svenson.test/logout', 'https://svenson.test/my-account/customer-logout/?x', 'https://svenson.test/?action=delete&id=4']) {
      expect(isAdminUrl(url), url).toBe(url.includes('customer-logout') ? false : true)
    }
    expect(isAdminUrl('https://svenson.test/wp-admin/admin-ajax.php')).toBe(false)
    expect(isAdminUrl('https://svenson.test/wp-json/wp/v2/pages')).toBe(false)
    expect(isAdminUrl('https://svenson.test/contact/')).toBe(false)
  })
})

describe('navigation', () => {
  it('stays on the site under review and out of admin', () => {
    expect(checkNavigation('https://svenson.test/contact/', site)).toEqual({ allowed: true })
    expect(checkNavigation('https://www.svenson.test/contact/', site)).toEqual({ allowed: true })
    expect(checkNavigation('https://evil.test/', site)).toMatchObject({ allowed: false, reason: expect.stringContaining('leaves the site') })
    expect(checkNavigation('https://svenson.test/wp-admin/', site)).toMatchObject({ allowed: false, reason: expect.stringContaining('off limits') })
    expect(checkNavigation('javascript:alert(1)', site)).toMatchObject({ allowed: false })
    expect(checkNavigation('file:///etc/passwd', site)).toMatchObject({ allowed: false })
  })
})

describe('requests from the browser', () => {
  const request = (method: string, url: string, resourceType = 'xhr', allowSend = false) => checkRequest({ method, url, resourceType, site, allowSend })

  it('lets pages load anything they need, from anywhere', () => {
    expect(request('GET', 'https://cdn.test/app.js', 'script')).toEqual({ allow: true })
    expect(request('GET', 'https://svenson.test/wp-admin/admin-ajax.php?action=load_more')).toEqual({ allow: true })
    expect(request('GET', 'https://svenson.test/contact/', 'mainFrame')).toEqual({ allow: true })
  })

  it('blocks leaving the site and admin pages', () => {
    expect(request('GET', 'https://evil.test/', 'mainFrame')).toMatchObject({ allow: false, blocked: { kind: 'navigation' } })
    expect(request('GET', 'https://svenson.test/wp-login.php?action=logout', 'xhr')).toMatchObject({ allow: false, blocked: { kind: 'admin' } })
  })

  it('blocks sending data unless the person allowed it, and then only to the site', () => {
    expect(request('POST', 'https://svenson.test/contact/', 'mainFrame')).toMatchObject({ allow: false, blocked: { kind: 'form', method: 'POST', reason: expect.stringContaining('sending data is off') } })
    expect(request('POST', 'https://svenson.test/wp-admin/admin-ajax.php')).toMatchObject({ allow: false, blocked: { kind: 'request' } })
    expect(request('DELETE', 'https://svenson.test/wp-json/wp/v2/posts/1')).toMatchObject({ allow: false })
    expect(request('POST', 'https://svenson.test/wp-admin/admin-ajax.php', 'xhr', true)).toEqual({ allow: true })
    expect(request('POST', 'https://analytics.test/collect', 'xhr', true)).toMatchObject({ allow: false, blocked: { reason: expect.stringContaining('only be sent to the site') } })
  })
})

describe('API requests by the agent', () => {
  it('may read the site, and send only when allowed', () => {
    expect(checkApiRequest({ method: 'GET', url: 'https://svenson.test/wp-json/wp/v2/pages', site, allowSend: false })).toEqual({ allowed: true })
    expect(checkApiRequest({ method: 'POST', url: 'https://svenson.test/wp-json/contact-form-7/v1/contact-forms/1/feedback', site, allowSend: false })).toMatchObject({ allowed: false, reason: expect.stringContaining('sending is off') })
    expect(checkApiRequest({ method: 'POST', url: 'https://svenson.test/wp-json/x', site, allowSend: true })).toEqual({ allowed: true })
    expect(checkApiRequest({ method: 'GET', url: 'https://evil.test/steal', site, allowSend: true })).toMatchObject({ allowed: false })
    expect(checkApiRequest({ method: 'GET', url: 'https://svenson.test/wp-admin/users.php', site, allowSend: true })).toMatchObject({ allowed: false })
  })
})

describe('link check', () => {
  it('never requests admin, login or logout links', () => {
    expect(linkCheckPlan('https://svenson.test/contact/')).toBe('check')
    expect(linkCheckPlan('https://svenson.test/wp-login.php?action=logout&_wpnonce=abc')).toBe('skip-admin')
    expect(linkCheckPlan('https://svenson.test/wp-admin/post.php?post=4&action=edit')).toBe('skip-admin')
    expect(linkCheckPlan('mailto:hi@svenson.test')).toBe('skip-scheme')
    expect(linkCheckPlan('#')).toBe('placeholder')
    expect(linkCheckPlan('')).toBe('placeholder')
    expect(linkCheckPlan('javascript:void(0)')).toBe('placeholder')
  })
})
